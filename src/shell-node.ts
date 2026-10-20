import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { PluginInput } from '@opencode-ai/plugin';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024;

interface NodeShellCommand extends Promise<{ stdout: string; stderr: string }> {
  quiet: () => NodeShellCommand;
  text: () => Promise<string>;
}

/**
 * Tokenize a `$`-tagged template into an argv array with Bun `$` semantics:
 * static text splits on whitespace, and each `${}` glues into the current token
 * as one argument. An empty value keeps its slot so `-m ${''}` does not
 * collapse to a bare `-m` (which opens an interactive editor and hangs).
 */
export function buildArgv(strings: readonly string[], values: readonly unknown[]): string[] {
  const argv: string[] = [];
  let buf = '';
  let pending = false;
  const flush = () => {
    if (pending) {
      argv.push(buf);
      pending = false;
      buf = '';
    }
  };

  strings.forEach((segment, i) => {
    for (const chunk of segment.split(/(\s+)/)) {
      if (chunk === '') continue;
      if (/^\s+$/.test(chunk)) {
        flush();
        continue;
      }
      buf += chunk;
      pending = true;
    }
    if (i < values.length) {
      buf += String(values[i]);
      pending = true;
    }
  });
  flush();
  return argv;
}

/**
 * Canonical Windows argv quoting (MSVCRT/list2cmdline rules) for the fallback path.
 *
 * The short-circuit char class also covers cmd.exe execution primitives
 * (`&|<>()^!`) so they are always wrapped in quotes on the `exec` path.
 * `%` is left out: cmd expands `%…%` even inside double quotes, a documented
 * ceiling of the shell fallback that quoting cannot close.
 */
export function quoteWin32(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>()^!]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += `${'\\'.repeat(backslashes + 1)}"`;
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  if (backslashes > 0) out += '\\'.repeat(backslashes * 2);
  return `${out}"`;
}

const quotePosix = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

/**
 * Node `child_process` implementation of the opencode `$` template-tag shell.
 *
 * Opencode v2 plugins have no `$` helper, so the v2 entrypoint runs git/gh/op
 * commands through this shim. Templates are tokenized by `buildArgv` (Bun `$`
 * token semantics) and spawned via `execFile` with no shell, so no platform
 * quoting rules apply. `.quiet()` is a no-op kept for call-site compatibility,
 * `.text()` resolves stdout, and awaiting the command throws on non-zero exit.
 *
 * `.cmd`/`.bat` shims: Node refuses to spawn these shell-less (EINVAL since
 * CVE-2024-27980), and bare names that only resolve via PATHEXT reject with
 * ENOENT. Both cases fall back to a platform-quoted one-liner through `exec`;
 * both codes surface as rejections, so a single `await`/catch covers them. The
 * fallback re-enters a shell and may resolve a different binary from PATH than
 * the direct spawn would.
 *
 * Differences from Bun `$` to be aware of when debugging service failures:
 * - No shell: `&&`, pipes, redirects, and globs in template text are passed as
 *   literal argv elements, not executed as operators.
 * - Spawns are hidden (`windowsHide: true`) so console children do not flash
 *   a conhost window on Windows when the host has no attached console.
 * - No `cwd`/`env` options; inherits the plugin host process env.
 * - `maxBuffer` is 32 MiB; larger git output throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
 * - Rejection is a `child_process` Error (with `stdout`/`stderr` props), not a Bun ShellError.
 */
export function createNodeShell(): PluginInput['$'] {
  const shell = (strings: TemplateStringsArray, ...values: unknown[]): NodeShellCommand => {
    const argv = buildArgv(strings, values);
    const run = async (): Promise<{ stdout: string; stderr: string }> => {
      try {
        return await execFileAsync(argv[0], argv.slice(1), {
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'EINVAL' && code !== 'ENOENT') throw error;
        const line = argv.map(process.platform === 'win32' ? quoteWin32 : quotePosix).join(' ');
        return await execAsync(line, { maxBuffer: MAX_BUFFER, windowsHide: true });
      }
    };
    const execution = run() as unknown as NodeShellCommand;
    execution.quiet = () => execution;
    execution.text = async () => (await execution).stdout;
    return execution;
  };
  return shell as unknown as PluginInput['$'];
}

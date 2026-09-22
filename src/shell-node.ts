import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { PluginInput } from '@opencode-ai/plugin';

const execAsync = promisify(exec);

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

interface NodeShellCommand extends Promise<{ stdout: string; stderr: string }> {
  quiet: () => NodeShellCommand;
  text: () => Promise<string>;
}

/**
 * Node `child_process` implementation of the opencode `$` template-tag shell.
 *
 * Opencode v2 plugins have no `$` helper, so the v2 entrypoint runs git/gh/op
 * commands through this shim. Interpolated values are single-quote escaped,
 * matching v1 behavior. `.quiet()` is a no-op kept for call-site compatibility,
 * `.text()` resolves stdout, and awaiting the command throws on non-zero exit.
 *
 * Differences from Bun `$` to be aware of when debugging service failures:
 * - Runs via `child_process.exec` (`/bin/sh`), not bash; keep commands POSIX.
 * - No `cwd`/`env` options; inherits the plugin host process env.
 * - `maxBuffer` is 32 MiB; larger git output throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
 * - Rejection is an `exec` Error (with `stdout`/`stderr` props), not a Bun ShellError.
 */
export function createNodeShell(): PluginInput['$'] {
  const shell = (strings: TemplateStringsArray, ...values: unknown[]): NodeShellCommand => {
    const command = strings.reduce(
      (result, segment, index) =>
        result + segment + (index < values.length ? shellQuote(values[index]) : ''),
      ''
    );
    const execution = execAsync(command, {
      maxBuffer: 32 * 1024 * 1024,
    }) as unknown as NodeShellCommand;
    execution.quiet = () => execution;
    execution.text = async () => (await execution).stdout;
    return execution;
  };
  return shell as unknown as PluginInput['$'];
}

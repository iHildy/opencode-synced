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

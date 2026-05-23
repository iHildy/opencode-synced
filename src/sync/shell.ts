import { exec } from 'node:child_process';

export interface ShellProcessPromise
  extends Promise<{ exitCode: number; stdout: string; stderr: string }> {
  quiet(): this;
  text(): Promise<string>;
}

export type ShellFn = (strings: TemplateStringsArray, ...values: unknown[]) => ShellProcessPromise;

// EN: Build shell command string — wraps all interpolated values in double quotes
// EN: Prevents path/commit-message breakage on Windows (spaces in paths, etc.)
// RU: Сборка команды — все интерполированные значения оборачиваются в двойные кавычки
// RU: Предотвращает поломку путей/commit message на Windows (пробелы в путях, и т.д.)
function buildCommand(strings: TemplateStringsArray, ...values: unknown[]): string {
  let cmd = '';
  for (let i = 0; i < strings.length; i++) {
    cmd += strings[i];
    if (i < values.length) {
      const v = values[i];
      const str = typeof v === 'string' ? v : String(v);
      cmd += `"${str.replace(/"/g, '\\"')}"`;
    }
  }
  return cmd.trim();
}

export function createNodeShell(): ShellFn {
  return (strings: TemplateStringsArray, ...values: unknown[]): ShellProcessPromise => {
    const command = buildCommand(strings, ...values);
    let isQuiet = false;

    const run = (): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      return new Promise((resolve) => {
        const child = exec(
          command,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              resolve({
                exitCode: error.code ?? 1,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
              });
            } else {
              resolve({ exitCode: 0, stdout: stdout ?? '', stderr: '' });
            }
          }
        );
        if (!isQuiet) {
          child.stdout?.pipe(process.stdout);
          child.stderr?.pipe(process.stderr);
        }
      });
    };

    let promise: Promise<{ exitCode: number; stdout: string; stderr: string }> | null = null;
    const getPromise = (): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      if (!promise) {
        promise = run();
      }
      return promise;
    };

    const shellPromise = {
      // biome-ignore lint/suspicious/noThenProperty: thenable pattern for async shell execution
      then<TResult1 = { exitCode: number; stdout: string; stderr: string }, TResult2 = never>(
        onfulfilled?:
          | ((value: {
              exitCode: number;
              stdout: string;
              stderr: string;
            }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): Promise<TResult1 | TResult2> {
        return getPromise().then(onfulfilled, onrejected);
      },
      catch<TResult = never>(
        onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
      ): Promise<{ exitCode: number; stdout: string; stderr: string } | TResult> {
        return getPromise().catch(onrejected);
      },
      finally(
        onfinally?: (() => void) | null
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return getPromise().finally(onfinally);
      },
      get [Symbol.toStringTag]() {
        return 'ShellProcessPromise';
      },
      quiet(): ShellProcessPromise {
        isQuiet = true;
        return this as unknown as ShellProcessPromise;
      },
      text(): Promise<string> {
        return getPromise().then((r) => r.stdout);
      },
    } as ShellProcessPromise;

    return shellPromise;
  };
}

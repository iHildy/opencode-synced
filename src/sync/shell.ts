import { execSync } from 'node:child_process';

export interface ShellProcessPromise extends Promise<{ exitCode: number; stdout: string; stderr: string }> {
  quiet(): this;
  text(): Promise<string>;
}

export type ShellFn = (strings: TemplateStringsArray, ...values: unknown[]) => ShellProcessPromise;

function buildCommand(strings: TemplateStringsArray, ...values: unknown[]): string {
  let cmd = '';
  for (let i = 0; i < strings.length; i++) {
    cmd += strings[i];
    if (i < values.length) {
      const v = values[i];
      cmd += typeof v === 'string' ? v : String(v);
    }
  }
  return cmd.trim();
}

export function createNodeShell(): ShellFn {
  return (strings: TemplateStringsArray, ...values: unknown[]): ShellProcessPromise => {
    const command = buildCommand(strings, ...values);
    let isQuiet = false;

    const run = (): { exitCode: number; stdout: string; stderr: string } => {
      try {
        const stdout = execSync(command, { encoding: 'utf-8', stdio: isQuiet ? 'pipe' : 'inherit' });
        return { exitCode: 0, stdout: stdout ?? '', stderr: '' };
      } catch (error) {
        if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
          const execError = error as Error & { stdout: string; stderr: string; status?: number };
          return {
            exitCode: execError.status ?? 1,
            stdout: execError.stdout ?? '',
            stderr: execError.stderr ?? '',
          };
        }
        throw error;
      }
    };

    let promise: Promise<{ exitCode: number; stdout: string; stderr: string }> | null = null;
    const getPromise = (): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      if (!promise) {
        promise = new Promise((resolve) => {
          resolve(run());
        });
      }
      return promise;
    };

    const shellPromise = {
      then<TResult1 = { exitCode: number; stdout: string; stderr: string }, TResult2 = never>(
        onfulfilled?: ((value: { exitCode: number; stdout: string; stderr: string }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): Promise<TResult1 | TResult2> {
        return getPromise().then(onfulfilled, onrejected);
      },
      catch<TResult = never>(
        onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
      ): Promise<{ exitCode: number; stdout: string; stderr: string } | TResult> {
        return getPromise().catch(onrejected);
      },
      finally(onfinally?: (() => void) | null): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return getPromise().finally(onfinally);
      },
      get [Symbol.toStringTag]() {
        return 'ShellProcessPromise';
      },
      quiet(): ShellProcessPromise {
        isQuiet = true;
        return shellPromise as unknown as ShellProcessPromise;
      },
      text(): Promise<string> {
        return getPromise().then((r) => r.stdout);
      },
    } as ShellProcessPromise;

    return shellPromise;
  };
}

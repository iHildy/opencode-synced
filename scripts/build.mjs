import { cp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

await rm('dist', { force: true, recursive: true });
await run(process.execPath, ['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
await cp('src/command', 'dist/command', { recursive: true });

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 1}`));
    });
  });
}

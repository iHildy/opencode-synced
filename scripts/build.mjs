import { spawnSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' }
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

await cp('src/command', 'dist/command', { recursive: true });

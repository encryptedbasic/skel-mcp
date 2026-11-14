import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDirectory = new URL('../tests/', import.meta.url);
const files = readdirSync(testDirectory)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => fileURLToPath(new URL(name, testDirectory)));

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

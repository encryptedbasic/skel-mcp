import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { getSmartDiff } from '../src/git.js';

const exec = promisify(execFile);
const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'skel-mcp-compact-git-test-'));
after(async () => {
  assert.ok(path.resolve(fixtureDirectory).startsWith(path.join(path.resolve(tmpdir()), 'skel-mcp-compact-git-test-')));
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function repository(name: string, fileName: string, content: string): Promise<{ cwd: string; filePath: string }> {
  const cwd = path.join(fixtureDirectory, name);
  await mkdir(cwd);
  const git = async (...args: string[]): Promise<void> => { await exec('git', args, { cwd, windowsHide: true }); };
  await git('init', '--quiet');
  await git('config', 'core.autocrlf', 'false');
  const filePath = path.join(cwd, fileName);
  await writeFile(filePath, content);
  await git('add', '--', fileName);
  return { cwd, filePath };
}

test('compact diff preserves both changed values and AST scope without unrelated function lines', async () => {
  const before = `export function calculateTotal(subtotal: number): number {
  const irrelevant = 'UNCHANGED_CONTEXT';
  const discountRate = subtotal >= 100 ? 0.1 : 0;
  return subtotal * (1 - discountRate);
}
function neighbor() { return 'UNRELATED'; }
`;
  const { cwd, filePath } = await repository('one-line', 'цена товара.ts', before);
  await writeFile(filePath, before.replace('subtotal >= 100', 'subtotal >= 200'));
  const compact = await getSmartDiff(cwd, { view: 'changes' });
  assert.match(compact, /цена товара\.ts/);
  assert.match(compact, /function calculateTotal/);
  assert.match(compact, /old L3:\n  const discountRate = subtotal >= 100/);
  assert.match(compact, /new L3:\n  const discountRate = subtotal >= 200/);
  assert.doesNotMatch(compact, /UNCHANGED_CONTEXT|return subtotal|UNRELATED|^@@|diff --git/m);
  const full = await getSmartDiff(cwd);
  assert.match(full, /UNCHANGED_CONTEXT/);
  assert.match(full, /return subtotal/);
  assert.ok(compact.length < full.length);
});

test('compact diff retains deletions without assigning the unchanged neighbor to the gap', async () => {
  const removed = 'function removed() {\n  return "REMOVED";\n}\n';
  const surviving = 'function surviving() { return "UNTOUCHED"; }\n';
  const { cwd, filePath } = await repository('deletion', 'sample.js', removed + surviving);
  await writeFile(filePath, surviving);
  const compact = await getSmartDiff(cwd, { view: 'changes' });
  assert.match(compact, /function removed/);
  assert.match(compact, /old L1-3:/);
  assert.match(compact, /REMOVED/);
  assert.doesNotMatch(compact, /UNTOUCHED|function surviving|new L/);
});

test('compact diff identifies top-level import changes and pure additions by exact lines', async () => {
  const before = 'import oldName from "before";\nfunction keep() { return 1; }\n';
  const { cwd, filePath } = await repository('top-level', 'sample.js', before);
  await writeFile(filePath, 'import newName from "after";\nfunction keep() { return 1; }\nexport const enabled = true;\n');
  const compact = await getSmartDiff(cwd, { view: 'changes' });
  assert.match(compact, /module\nold L1:\nimport oldName/);
  assert.match(compact, /new L1:\nimport newName/);
  assert.match(compact, /new L3:\nexport const enabled = true/);
  assert.doesNotMatch(compact, /function keep/);
});

test('compact diff keeps old code and names from a deleted file', async () => {
  const { cwd, filePath } = await repository('deleted-file', 'removed.py', 'def removed():\n    return "OLD_FILE"\n');
  await unlink(filePath);
  const compact = await getSmartDiff(cwd, { view: 'changes' });
  assert.match(compact, /removed\.py/);
  assert.match(compact, /function removed/);
  assert.match(compact, /old L1-2:\ndef removed\(\):\n    return "OLD_FILE"/);
  assert.doesNotMatch(compact, /new L/);
});

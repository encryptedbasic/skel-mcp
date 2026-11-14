import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { getSmartDiff } from '../src/git.js';

const exec = promisify(execFile);
const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'skel-mcp-git-test-'));
after(async () => {
  assert.ok(fixtureDirectory.startsWith(path.join(tmpdir(), 'skel-mcp-git-test-')));
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd, windowsHide: true });
}

async function repository(name: string, fileName: string, content: string): Promise<{ cwd: string; filePath: string }> {
  const cwd = path.join(fixtureDirectory, name);
  await mkdir(cwd);
  await git(cwd, 'init', '--quiet');
  await git(cwd, 'config', 'core.autocrlf', 'false');
  const filePath = path.join(cwd, fileName);
  await writeFile(filePath, content, 'utf8');
  await git(cwd, 'add', '--', fileName);
  await git(cwd, '-c', 'user.name=skel-mcp-test', '-c', 'user.email=skel-mcp-test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  return { cwd, filePath };
}

test('smart diff returns complete affected functions and omits unchanged neighbors', async () => {
  const before = `import { join } from 'node:path';
export function changed(name: string): string {
  const prefix = 'UNCHANGED_LINE_INSIDE_TOUCHED_FUNCTION';
  return join(prefix, name, 'BEFORE');
}

export function untouched(): string {
  return 'UNRELATED_FUNCTION_BODY';
}
`;
  const { cwd, filePath } = await repository('changed-function', 'пример с пробелом.ts', before);
  await writeFile(filePath, before.replace("'BEFORE'", "'AFTER'"), 'utf8');
  const diff = await getSmartDiff(cwd);
  assert.match(diff, /пример с пробелом\.ts/);
  assert.match(diff, /function changed/);
  assert.match(diff, /UNCHANGED_LINE_INSIDE_TOUCHED_FUNCTION/);
  assert.match(diff, /AFTER/);
  assert.doesNotMatch(diff, /UNRELATED_FUNCTION_BODY/);
  assert.doesNotMatch(diff, /^@@|^diff --git|^--- a\//m);
});

test('smart diff maps removed lines inside a function to its surviving full body', async () => {
  const before = `function changed() {
  const first = 'KEEP_FIRST';
  const removed = 'REMOVED_LINE';
  return first;
}

function neighbor() {
  return 'UNRELATED_DELETION_NEIGHBOR';
}
`;
  const { cwd, filePath } = await repository('deleted-line', 'sample.js', before);
  await writeFile(filePath, before.replace("  const removed = 'REMOVED_LINE';\n", ''), 'utf8');
  const diff = await getSmartDiff(cwd);
  assert.match(diff, /function changed/);
  assert.match(diff, /KEEP_FIRST/);
  assert.match(diff, /return first/);
  assert.doesNotMatch(diff, /UNRELATED_DELETION_NEIGHBOR/);
});

test('smart diff includes deleted functions using their previous AST', async () => {
  const deleted = `function removed() {
  return 'DELETED_FUNCTION_BODY';
}

`;
  const surviving = `function surviving() {
  return 'SURVIVING_UNCHANGED_BODY';
}
`;
  const { cwd, filePath } = await repository('deleted-function', 'sample.js', deleted + surviving);
  await writeFile(filePath, surviving, 'utf8');
  const diff = await getSmartDiff(cwd);
  assert.match(diff, /function removed/);
  assert.match(diff, /DELETED_FUNCTION_BODY/);
  assert.doesNotMatch(diff, /SURVIVING_UNCHANGED_BODY/);
});

test('smart diff includes the previous full symbols of a deleted file', async () => {
  const { cwd, filePath } = await repository('deleted-file', 'removed.go', `package sample
func Removed() string {
    return "DELETED_GO_FILE_BODY"
}
`);
  await unlink(filePath);
  const diff = await getSmartDiff(cwd);
  assert.match(diff, /removed\.go/);
  assert.match(diff, /func Removed/);
  assert.match(diff, /DELETED_GO_FILE_BODY/);
});

test('smart diff preserves a deletion next to an edited function in one hunk', async () => {
  const before = `function removed() {
  return 'REMOVED_ADJACENT_BODY';
}
function changed() {
  return 'ADJACENT_BEFORE';
}
`;
  const after = `function changed() {
  return 'ADJACENT_AFTER';
}
`;
  const { cwd, filePath } = await repository('adjacent-deletion', 'sample.js', before);
  await writeFile(filePath, after, 'utf8');
  const diff = await getSmartDiff(cwd);
  assert.match(diff, /function removed/);
  assert.match(diff, /REMOVED_ADJACENT_BODY/);
  assert.match(diff, /function changed/);
  assert.match(diff, /ADJACENT_AFTER/);
  assert.doesNotMatch(diff, /ADJACENT_BEFORE/);
});

test('smart diff emits an affected class once without duplicating its methods', async () => {
  const before = `class Service {
  changed() {
    return 'CLASS_BEFORE';
  }
  neighbor() {
    return 'CLASS_NEIGHBOR';
  }
}
function unrelated() { return 'CLASS_UNRELATED_FUNCTION'; }
`;
  const { cwd, filePath } = await repository('class-change', 'sample.ts', before);
  await writeFile(filePath, before.replace('CLASS_BEFORE', 'CLASS_AFTER'), 'utf8');
  const diff = await getSmartDiff(cwd);
  assert.equal(diff.match(/class Service/g)?.length, 1);
  assert.equal(diff.match(/changed\(\)/g)?.length, 1);
  assert.match(diff, /CLASS_AFTER/);
  assert.match(diff, /CLASS_NEIGHBOR/);
  assert.doesNotMatch(diff, /CLASS_UNRELATED_FUNCTION/);
});

test('smart diff conservatively preserves both definitions when a name changes', async () => {
  const before = `function originalName() {
  return 'RENAMED_BODY';
}
`;
  const { cwd, filePath } = await repository('renamed-function', 'sample.js', before);
  await writeFile(filePath, before.replace('originalName', 'updatedName'), 'utf8');
  const diff = await getSmartDiff(cwd);
  assert.match(diff, /function updatedName/);
  assert.match(diff, /RENAMED_BODY/);
  assert.match(diff, /function originalName/);
  assert.match(diff, /removed.*index version/i);
});

test('smart diff retains a deleted function when an unrelated function replaces it', async () => {
  const before = `function removedA() {
  return 'DELETED_REPLACEMENT_A';
}
`;
  const { cwd, filePath } = await repository('unrelated-replacement', 'sample.js', before);
  await writeFile(filePath, `function addedB(value) {
  return value + 'ADDED_REPLACEMENT_B';
}
`, 'utf8');
  const diff = await getSmartDiff(cwd);
  assert.match(diff, /function removedA/);
  assert.match(diff, /DELETED_REPLACEMENT_A/);
  assert.match(diff, /function addedB/);
  assert.match(diff, /ADDED_REPLACEMENT_B/);
});

test('smart diff respects current subdirectory and ignores sibling changes', async () => {
  const { cwd } = await repository('subdirectory', 'baseline.js', 'function baseline() { return 1; }\n');
  const subdirectory = path.join(cwd, 'nested');
  await mkdir(subdirectory);
  const inside = path.join(subdirectory, 'inside.py');
  const outside = path.join(cwd, 'outside.py');
  await writeFile(inside, "def inside():\n    return 'BEFORE_INSIDE'\n", 'utf8');
  await writeFile(outside, "def outside():\n    return 'BEFORE_OUTSIDE'\n", 'utf8');
  await git(cwd, 'add', '--', '.');
  await git(cwd, '-c', 'user.name=skel-mcp-test', '-c', 'user.email=skel-mcp-test@example.invalid', 'commit', '--quiet', '-m', 'nested fixtures');
  await writeFile(inside, "def inside():\n    return 'AFTER_INSIDE'\n", 'utf8');
  await writeFile(outside, "def outside():\n    return 'AFTER_OUTSIDE'\n", 'utf8');
  const diff = await getSmartDiff(subdirectory);
  assert.match(diff, /AFTER_INSIDE/);
  assert.doesNotMatch(diff, /AFTER_OUTSIDE/);
});

test('smart diff clearly reports a clean working tree and unsupported changed files', async () => {
  const { cwd } = await repository('clean', 'notes.txt', 'before\n');
  const clean = await getSmartDiff(cwd);
  assert.match(clean, /no .*changes|no .*diff|clean|нет .*измен/i);
  await writeFile(path.join(cwd, 'notes.txt'), 'after\n', 'utf8');
  const unsupported = await getSmartDiff(cwd);
  assert.match(unsupported, /notes\.txt/);
  assert.match(unsupported, /unsupported|skipp|support|поддерж/i);
});

test('smart diff reports a non-Git directory clearly', async () => {
  const cwd = path.join(fixtureDirectory, 'not-a-repository');
  await mkdir(cwd);
  await assert.rejects(getSmartDiff(cwd), /git|repository/i);
});

test('smart diff follows git diff semantics and excludes staged and untracked files', async () => {
  const { cwd, filePath } = await repository('staged-and-untracked', 'tracked.js', "function tracked() { return 'BEFORE'; }\n");
  await writeFile(filePath, "function tracked() { return 'STAGED_BODY'; }\n", 'utf8');
  await git(cwd, 'add', '--', 'tracked.js');
  await writeFile(path.join(cwd, 'untracked.js'), "function untracked() { return 'UNTRACKED_BODY'; }\n", 'utf8');
  const diff = await getSmartDiff(cwd);
  assert.match(diff, /no .*changes|no .*diff|clean|нет .*измен/i);
  assert.doesNotMatch(diff, /STAGED_BODY|UNTRACKED_BODY/);
});

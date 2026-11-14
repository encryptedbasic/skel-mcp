import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { getContext } from '../src/context.js';
import { getSmartDiff } from '../src/git.js';
import { parseFile } from '../src/parser.js';
import { resolveWorkspaceFile } from '../src/source-files.js';

const exec = promisify(execFile);

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const prefix = path.join(tmpdir(), 'skel-mcp-security-');
  const directory = await mkdtemp(prefix);
  try {
    await run(directory);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  }
}

test('workspace file access keeps reads inside the root and excludes Git metadata', () => fixture(async (directory) => {
  const root = path.join(directory, 'workspace');
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, 'folder.ts'));
  await writeFile(path.join(root, 'public.ts'), 'function visible() { return true; }\n');
  await writeFile(path.join(directory, 'outside.ts'), 'function outside() { return false; }\n');
  await writeFile(path.join(root, '.git', 'protected.ts'), 'function protectedSource() {}\n');
  assert.ok((await resolveWorkspaceFile('public.ts', root)).endsWith('public.ts'));
  await assert.rejects(resolveWorkspaceFile('../outside.ts', root), /inside the workspace/);
  await assert.rejects(resolveWorkspaceFile('.git/protected.ts', root), /Git metadata/);
  await assert.rejects(parseFile(path.join(root, 'folder.ts')), /regular source files/);

  const result = await getContext({ requests: [
    { op: 'outline', file: 'public.ts' },
    { op: 'outline', file: path.join(directory, 'outside.ts') },
  ] }, root);
  assert.match(result, /function visible/);
  assert.match(result, /\[1\] ERROR File must be inside the workspace/);
  assert.doesNotMatch(result, /function outside/);
}));

test('workspace file access checks resolved directory links', (context) => fixture(async (directory) => {
  const root = path.join(directory, 'workspace');
  const other = path.join(directory, 'other');
  await mkdir(root);
  await mkdir(other);
  await writeFile(path.join(other, 'source.ts'), 'function unrelated() {}\n');
  try {
    await symlink(other, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    context.skip('This filesystem does not support directory links.');
    return;
  }
  await assert.rejects(resolveWorkspaceFile('linked/source.ts', root), /inside the workspace/);
}));

test('Git diff stays in its workspace and supports diffing when conversion is configured as required', () => fixture(async (directory) => {
  const workspace = path.join(directory, 'workspace');
  const other = path.join(directory, 'other');
  const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, windowsHide: true });
  await mkdir(workspace);
  await mkdir(other);
  for (const root of [workspace, other]) {
    await git(root, 'init', '--quiet');
    await writeFile(path.join(root, 'source.ts'), 'export function selected() { return 1; }\n');
    await git(root, 'add', '--', 'source.ts');
  }
  await writeFile(path.join(workspace, '.gitattributes'), 'source.ts filter=example\n');
  await git(workspace, 'config', 'filter.example.required', 'true');
  await writeFile(path.join(workspace, 'source.ts'), 'export function selected() { return 2; }\n');
  await writeFile(path.join(other, 'source.ts'), 'export function selected() { return 3; }\n');
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(other, '.git');
  try {
    const result = await getSmartDiff(workspace, { view: 'changes' });
    assert.match(result, /return 2/);
    assert.doesNotMatch(result, /return 3|Unable to analyze/);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
}));

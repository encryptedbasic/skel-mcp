import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function isWorkspacePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !path.isAbsolute(relative) && !relative.split(path.sep).some((part) =>
    part === '..' || part.toLowerCase() === '.git' || (process.platform === 'win32' && part.includes(':')));
}

/** Verify that the canonical path is a regular source file in the active workspace. */
export async function resolveWorkspaceFile(filePath: string, root = process.cwd()): Promise<string> {
  const base = path.resolve(root);
  const workspace = await realpath(base);
  const requested = path.resolve(base, filePath);
  const message = 'File must be inside the workspace, outside Git metadata.';
  if (!isWorkspacePath(base, requested) && !isWorkspacePath(workspace, requested)) throw new Error(message);
  const candidate = await realpath(requested);
  if (!isWorkspacePath(workspace, candidate)) throw new Error(message);
  if (!(await stat(candidate)).isFile()) throw new Error('Only regular source files can be read.');
  return candidate;
}

export async function readSourceFile(filePath: string): Promise<string> {
  const expected = await stat(filePath);
  if (!expected.isFile()) throw new Error('Only regular source files can be read.');
  // Non-blocking open avoids getting stuck if a special file replaces the path.
  // O_NOFOLLOW applies where the platform exposes it.
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const file = await open(filePath, flags);
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error('Source file changed while opening.');
    }
    return await file.readFile({ encoding: 'utf8' });
  } finally {
    await file.close();
  }
}

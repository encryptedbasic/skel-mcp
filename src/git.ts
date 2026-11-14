import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  getEnclosingSymbols,
  isSupportedFile,
  parseFile,
  parseSource,
} from './parser.js';
import { resolveWorkspaceFile } from './source-files.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

type SymbolMatch = ReturnType<typeof getEnclosingSymbols>[number];
type GitConfig = ReadonlyArray<readonly [key: string, value: string]>;

export interface SmartDiffOptions {
  /** `changes` returns changed source lines with AST labels instead of full bodies. */
  view?: 'full' | 'changes';
}

async function findGit(): Promise<string> {
  const searchPath = process.env.PATH ?? '';
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  // Passing an absolute executable bypasses Windows's current-directory lookup,
  // and ignoring relative PATH entries keeps the search independent of the repo.
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next absolute PATH entry.
    }
  }
  throw new Error('Git is not installed or is unavailable on PATH.');
}

function gitEnv(config: GitConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The launcher sets cwd, so inherited repository, index and config overrides
    // would otherwise allow Git to read a different workspace.
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GIT_CONFIG_COUNT: String(config.length),
  });
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function git(executable: string, cwd: string, args: string[], config: GitConfig = []): Promise<string> {
  try {
    const { stdout } = await execFileAsync(executable, [
      '--no-pager', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${devNull}`,
      '-c', 'diff.autoRefreshIndex=false',
      ...args,
    ], {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT,
      timeout: 30_000,
      windowsHide: true,
      env: gitEnv(config),
    });
    return stdout;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: string };
    const detail = error.code === 'ENOENT'
      ? 'Git is not installed or is unavailable on PATH.'
      : error.stderr?.trim() || error.message;
    throw new Error(`Cannot run git in ${JSON.stringify(cwd)}: ${detail}`, { cause });
  }
}

async function disableGitFilters(executable: string, cwd: string): Promise<GitConfig> {
  const keys = await git(executable, cwd, ['config', '--includes', '--null', '--name-only', '--list']);
  const drivers = new Set<string>();
  for (const key of keys.split('\0')) {
    const driver = /^filter\.(.+)\.(?:clean|process|required)$/s.exec(key)?.[1];
    if (driver) drivers.add(driver);
  }
  // --no-textconv does not disable worktree clean/process filters.
  return [...drivers].flatMap((driver) => [
    [`filter.${driver}.clean`, ''] as const,
    [`filter.${driver}.process`, ''] as const,
    [`filter.${driver}.required`, 'false'] as const,
  ]);
}

async function resolveChangedFile(root: string, filePath: string): Promise<string | undefined> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error('Git changes to symbolic links are not analyzed.');
    return await resolveWorkspaceFile(filePath, root);
  } catch (error) {
    // A removed file can still be analyzed from its index entry.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseHunks(patch: string): Hunk[] {
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((match) => ({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
    }));
}

/** Map an unchanged declaration's old line into the working tree. */
function mapOldLine(line: number, hunks: Hunk[]): number {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount === 0) {
      if (line > hunk.oldStart) delta += hunk.newCount;
      continue;
    }
    if (line < hunk.oldStart) break;
    if (line < hunk.oldStart + hunk.oldCount) return Math.max(1, hunk.newStart);
    delta += hunk.newCount - hunk.oldCount;
  }
  return line + delta;
}

function codeBlock(code: string, filePath: string): string {
  let fenceLength = 3;
  for (const match of code.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const language = ['ts', 'tsx', 'mts', 'cts'].includes(extension)
    ? 'typescript'
    : ['js', 'jsx', 'mjs', 'cjs'].includes(extension)
      ? 'javascript'
      : extension === 'py' ? 'python' : extension === 'go' ? 'go' : '';
  return `${fence}${language}\n${code}\n${fence}`;
}

function sharesReplacement(oldSymbol: SymbolMatch, newSymbol: SymbolMatch, hunks: Hunk[]): boolean {
  return hunks.some((hunk) =>
    hunk.oldCount > 0 && hunk.newCount > 0
    && oldSymbol.startLine <= hunk.oldStart + hunk.oldCount - 1
    && oldSymbol.endLine >= hunk.oldStart
    && newSymbol.startLine <= hunk.newStart + hunk.newCount - 1
    && newSymbol.endLine >= hunk.newStart);
}

function changedLines(
  version: 'old' | 'new',
  parsed: Awaited<ReturnType<typeof parseSource>> | undefined,
  start: number,
  count: number,
): { text: string; labels: string[] } | undefined {
  if (!parsed || count === 0) return undefined;
  const end = start + count - 1;
  const labels = getEnclosingSymbols(parsed, [{ startLine: start, endLine: end }])
    .map((symbol) => `${symbol.kind} ${symbol.name}`);
  const source = parsed.content.split(/\r?\n/).slice(start - 1, end).join('\n');
  const location = start === end ? `L${start}` : `L${start}-${end}`;
  return { text: `${version} ${location}:\n${source}`, labels };
}

/** No context lines are copied: exact changed lines stay labelled by AST scope. */
function compactChanges(
  filePath: string,
  hunks: Hunk[],
  previous: Awaited<ReturnType<typeof parseSource>> | undefined,
  currentChanges: Array<ReturnType<typeof changedLines>>,
): string {
  const changes = hunks.map((hunk, index) => {
    const old = changedLines('old', previous, hunk.oldStart, hunk.oldCount);
    const next = currentChanges[index];
    const labels = [...new Set([...(old?.labels ?? []), ...(next?.labels ?? [])])];
    return [labels.join(', ') || 'module', old?.text, next?.text].filter(Boolean).join('\n');
  });
  return `${JSON.stringify(filePath)}\n${changes.join('\n\n')}`;
}

/**
 * Summarize ordinary `git diff`: unstaged tracked changes under cwd.
 * Zero-context hunks are used only to select AST nodes; patch text is never returned.
 * For deleted symbols, return their complete code from the index with an explicit label.
 */
export async function getSmartDiff(cwd = process.cwd(), options: SmartDiffOptions = {}): Promise<string> {
  // realpath also expands Windows 8.3 names, which otherwise produce
  // an incorrect relative path against Git's expanded repository path.
  const absoluteCwd = await realpath(path.resolve(cwd));
  const executable = await findGit();
  // Removing one final newline preserves legal leading/trailing spaces in repository paths.
  const repository = await realpath((await git(executable, absoluteCwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''));
  const config = await disableGitFilters(executable, repository);
  const inspect = (args: string[]): Promise<string> => git(executable, repository, args, config);
  const relativeDirectory = path.relative(repository, absoluteCwd).split(path.sep).join('/') || '.';
  const diffOptions = [
    '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
    '--no-relative', '--ignore-submodules=all', '--no-indent-heuristic',
  ];
  const raw = (await inspect([
    'diff', ...diffOptions, '--raw', '-z', '--', relativeDirectory,
  ])).split('\0');

  if (raw.length === 1 && !raw[0]) return 'No unstaged changes in tracked files under the current directory.';

  const sections: string[] = [];
  for (let entry = 0; entry + 1 < raw.length; entry += 2) {
    const filePath = raw[entry + 1]!;
    const modes = /^:(\d{6}) (\d{6}) /.exec(raw[entry]!);
    if (!modes || !filePath) throw new Error('Git returned an unrecognized diff entry.');
    if (!isSupportedFile(filePath)) {
      sections.push(`## ${JSON.stringify(filePath)}\nSkipped: unsupported language.`);
      continue;
    }
    const isRegular = (mode: string): boolean => mode === '000000' || mode.startsWith('100');
    if (!isRegular(modes[1]!) || !isRegular(modes[2]!)) {
      sections.push(`## ${JSON.stringify(filePath)}\nSkipped: non-regular Git entry.`);
      continue;
    }

    try {
      const absoluteFile = path.resolve(repository, filePath);
      const currentFile = await resolveChangedFile(absoluteCwd, absoluteFile);
      const patch = await inspect([
        'diff', ...diffOptions, '--unified=0', '--inter-hunk-context=0', '--', filePath,
      ]);
      const hunks = parseHunks(patch);
      if (hunks.length === 0) {
        sections.push(`## ${JSON.stringify(filePath)}\nNo text hunks (binary file or metadata-only change).`);
        continue;
      }

      const removals = hunks.filter((hunk) => hunk.oldCount > 0);
      let currentChanges: Array<ReturnType<typeof changedLines>> = [];
      let currentSymbols: SymbolMatch[] = [];
      let addedSymbols: SymbolMatch[] = [];
      if (currentFile) {
        const current = await parseFile(currentFile);
        // Cache eviction can dispose this tree while Git reads the index. Keep
        // only source text and symbol metadata past the next await.
        if (options.view === 'changes') {
          currentChanges = hunks.map((hunk) => changedLines('new', current, hunk.newStart, hunk.newCount));
        } else {
          const additions = hunks.filter((hunk) => hunk.newCount > 0).map((hunk) => ({
            startLine: hunk.newStart,
            endLine: hunk.newStart + hunk.newCount - 1,
          }));
          addedSymbols = getEnclosingSymbols(current, additions);
          if (removals.length > 0) {
            currentSymbols = getEnclosingSymbols(current, [{ startLine: 1, endLine: Number.MAX_SAFE_INTEGER }]);
          }
        }
      }

      if (options.view === 'changes') {
        const previous = removals.length > 0
          ? await parseSource(absoluteFile, await inspect(['cat-file', 'blob', `:${filePath}`]))
          : undefined;
        sections.push(compactChanges(filePath, hunks, previous, currentChanges));
        continue;
      }

      const selected = new Map<string, { symbol: SymbolMatch; removed: boolean }>();
      const add = (symbol: SymbolMatch, removed = false): void => {
        selected.set(`${removed ? 'old' : 'new'}:${symbol.startLine}:${symbol.endLine}:${symbol.name}`, {
          symbol, removed,
        });
      };
      for (const symbol of addedSymbols) add(symbol);

      // A zero-length new hunk is a gap, not a changed line. Looking it up directly
      // would incorrectly select an unchanged neighboring function after a deletion.
      if (removals.length > 0) {
        const previousSource = await inspect(['cat-file', 'blob', `:${filePath}`]);
        const previous = await parseSource(absoluteFile, previousSource);
        const oldRanges = removals.map((hunk) => ({
          startLine: hunk.oldStart,
          endLine: hunk.oldStart + hunk.oldCount - 1,
        }));
        const previousSymbols = getEnclosingSymbols(previous, oldRanges);
        const matchedOld = new Set<SymbolMatch>();
        const matchedCurrent = new Set<SymbolMatch>();

        // Match declarations by name and position. This preserves both a deleted
        // foo and an edited bar even when Git combines them into one replacement.
        for (const oldSymbol of previousSymbols) {
          const whollyDeleted = removals.some((hunk) => hunk.newCount === 0
            && hunk.oldStart <= oldSymbol.startLine
            && hunk.oldStart + hunk.oldCount - 1 >= oldSymbol.endLine);
          if (whollyDeleted) continue;
          const mappedStart = mapOldLine(oldSymbol.startLine, hunks);
          const candidates = currentSymbols.filter((symbol) =>
            !matchedCurrent.has(symbol)
            && symbol.name === oldSymbol.name
            && symbol.kind === oldSymbol.kind
            && (symbol.startLine === mappedStart || sharesReplacement(oldSymbol, symbol, hunks)));
          candidates.sort((a, b) => Math.abs(a.startLine - mappedStart) - Math.abs(b.startLine - mappedStart));
          const surviving = candidates[0];
          if (surviving) {
            matchedOld.add(oldSymbol);
            matchedCurrent.add(surviving);
            add(surviving);
          }
        }

        // Keep unmatched old declarations explicitly. Guessing renames could hide
        // a deleted function when an unrelated new function occupies its old lines.
        // A rename therefore shows the removed old name and the current new name.
        for (const oldSymbol of previousSymbols) {
          if (!matchedOld.has(oldSymbol)) add(oldSymbol, true);
        }
      }

      const excerpts = [...selected.values()].map(({ symbol, removed }) => {
        const version = removed ? 'removed; index version' : 'working tree';
        return `### ${symbol.kind} ${JSON.stringify(symbol.name)} (${version}, lines ${symbol.startLine}-${symbol.endLine})\n${codeBlock(symbol.code, filePath)}`;
      });
      if (excerpts.length === 0) {
        excerpts.push('Changes are outside functions/classes (for example, imports, types, or module-level statements).');
      }
      sections.push(`## ${JSON.stringify(filePath)}\n${excerpts.join('\n\n')}`);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      sections.push(`## ${JSON.stringify(filePath)}\nUnable to analyze this file: ${error}`);
    }
  }

  return sections.join('\n\n');
}

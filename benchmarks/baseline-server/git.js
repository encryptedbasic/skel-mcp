import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getEnclosingSymbols, isSupportedFile, parseFile, parseSource, } from './parser.js';
const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
async function git(cwd, args) {
    try {
        const { stdout } = await execFileAsync('git', ['--literal-pathspecs', ...args], {
            cwd,
            encoding: 'utf8',
            maxBuffer: MAX_GIT_OUTPUT,
            timeout: 30_000,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        });
        return stdout;
    }
    catch (cause) {
        const error = cause;
        const detail = error.code === 'ENOENT'
            ? 'Git is not installed or is unavailable on PATH.'
            : error.stderr?.trim() || error.message;
        throw new Error(`Cannot run git in ${JSON.stringify(cwd)}: ${detail}`, { cause });
    }
}
function parseHunks(patch) {
    return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
        .map((match) => ({
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
    }));
}
/** Map an unchanged declaration's old line into the working tree. */
function mapOldLine(line, hunks) {
    let delta = 0;
    for (const hunk of hunks) {
        if (hunk.oldCount === 0) {
            if (line > hunk.oldStart)
                delta += hunk.newCount;
            continue;
        }
        if (line < hunk.oldStart)
            break;
        if (line < hunk.oldStart + hunk.oldCount)
            return Math.max(1, hunk.newStart);
        delta += hunk.newCount - hunk.oldCount;
    }
    return line + delta;
}
function codeBlock(code, filePath) {
    let fenceLength = 3;
    for (const match of code.matchAll(/`+/g))
        fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const language = ['ts', 'tsx', 'mts', 'cts'].includes(extension)
        ? 'typescript'
        : ['js', 'jsx', 'mjs', 'cjs'].includes(extension)
            ? 'javascript'
            : extension === 'py' ? 'python' : extension === 'go' ? 'go' : '';
    return `${fence}${language}\n${code}\n${fence}`;
}
function sharesReplacement(oldSymbol, newSymbol, hunks) {
    return hunks.some((hunk) => hunk.oldCount > 0 && hunk.newCount > 0
        && oldSymbol.startLine <= hunk.oldStart + hunk.oldCount - 1
        && oldSymbol.endLine >= hunk.oldStart
        && newSymbol.startLine <= hunk.newStart + hunk.newCount - 1
        && newSymbol.endLine >= hunk.newStart);
}
/**
 * Summarize ordinary `git diff`: unstaged tracked changes under cwd.
 * Zero-context hunks are used only to select AST nodes; patch text is never returned.
 * For deleted symbols, return their complete code from the index with an explicit label.
 */
export async function getSmartDiff(cwd = process.cwd()) {
    // realpath also expands Windows 8.3 names (ENCRYP~1), which otherwise produce
    // an incorrect relative path against Git's expanded repository path.
    const absoluteCwd = await realpath(path.resolve(cwd));
    // Removing one final newline preserves legal leading/trailing spaces in repository paths.
    const repository = await realpath((await git(absoluteCwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''));
    const relativeDirectory = path.relative(repository, absoluteCwd).split(path.sep).join('/') || '.';
    const diffOptions = [
        '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
        '--no-relative', '--ignore-submodules=all',
    ];
    const names = (await git(repository, [
        'diff', ...diffOptions, '--name-only', '-z', '--', relativeDirectory,
    ])).split('\0').filter(Boolean);
    if (names.length === 0)
        return 'No unstaged changes in tracked files under the current directory.';
    const sections = [];
    for (const filePath of names) {
        if (!isSupportedFile(filePath)) {
            sections.push(`## ${JSON.stringify(filePath)}\nSkipped: unsupported language.`);
            continue;
        }
        try {
            const patch = await git(repository, [
                'diff', ...diffOptions, '--unified=0', '--inter-hunk-context=0', '--', filePath,
            ]);
            const hunks = parseHunks(patch);
            if (hunks.length === 0) {
                sections.push(`## ${JSON.stringify(filePath)}\nNo text hunks (binary file or metadata-only change).`);
                continue;
            }
            const absoluteFile = path.resolve(repository, filePath);
            let current;
            try {
                current = await parseFile(absoluteFile);
            }
            catch (error) {
                // Deleted files have no working-tree AST. Other read/parse errors are surfaced below.
                if (error.code !== 'ENOENT')
                    throw error;
            }
            const selected = new Map();
            const add = (symbol, removed = false) => {
                selected.set(`${removed ? 'old' : 'new'}:${symbol.startLine}:${symbol.endLine}:${symbol.name}`, {
                    symbol, removed,
                });
            };
            const additions = hunks.filter((hunk) => hunk.newCount > 0).map((hunk) => ({
                startLine: hunk.newStart,
                endLine: hunk.newStart + hunk.newCount - 1,
            }));
            if (current) {
                for (const symbol of getEnclosingSymbols(current, additions))
                    add(symbol);
            }
            // A zero-length new hunk is a gap, not a changed line. Looking it up directly
            // would incorrectly select an unchanged neighboring function after a deletion.
            const removals = hunks.filter((hunk) => hunk.oldCount > 0);
            if (removals.length > 0) {
                const previousSource = await git(repository, ['show', `:${filePath}`]);
                const previous = await parseSource(absoluteFile, previousSource);
                const oldRanges = removals.map((hunk) => ({
                    startLine: hunk.oldStart,
                    endLine: hunk.oldStart + hunk.oldCount - 1,
                }));
                const currentSymbols = current
                    ? getEnclosingSymbols(current, [{ startLine: 1, endLine: Number.MAX_SAFE_INTEGER }])
                    : [];
                const previousSymbols = getEnclosingSymbols(previous, oldRanges);
                const matchedOld = new Set();
                const matchedCurrent = new Set();
                // Match declarations by name and position. This preserves both a deleted
                // foo and an edited bar even when Git combines them into one replacement.
                for (const oldSymbol of previousSymbols) {
                    const whollyDeleted = removals.some((hunk) => hunk.newCount === 0
                        && hunk.oldStart <= oldSymbol.startLine
                        && hunk.oldStart + hunk.oldCount - 1 >= oldSymbol.endLine);
                    if (whollyDeleted)
                        continue;
                    const mappedStart = mapOldLine(oldSymbol.startLine, hunks);
                    const candidates = currentSymbols.filter((symbol) => !matchedCurrent.has(symbol)
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
                    if (!matchedOld.has(oldSymbol))
                        add(oldSymbol, true);
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
        }
        catch (cause) {
            const error = cause instanceof Error ? cause.message : String(cause);
            sections.push(`## ${JSON.stringify(filePath)}\nUnable to analyze this file: ${error}`);
        }
    }
    return sections.join('\n\n');
}
//# sourceMappingURL=git.js.map
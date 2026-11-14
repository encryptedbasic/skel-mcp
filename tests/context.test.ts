import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { countTokens, getContext, paginate, type ContextInput, type ContextRequest } from '../src/context.js';

const exec = promisify(execFile);
const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'skel-mcp-context-test-'));
after(async () => {
  assert.ok(path.resolve(fixtureDirectory).startsWith(path.join(path.resolve(tmpdir()), 'skel-mcp-context-test-')));
  await rm(fixtureDirectory, { recursive: true, force: true });
});

const original = `import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Service {
  constructor() { console.log('CONSTRUCTOR_BODY'); }
  public run(value: string): string { return join('CLASS_BODY', value); }
  private hidden(): string { return 'PRIVATE_BODY'; }
}

export function selected(value: string): string {
  const start = 'OMITTED_START';
  const first = value.toUpperCase();
  const marker = 'MATCH_IN_SELECTED';
  const result = join(first, marker);
  return result;
}

export function changed(value: number): number {
  const unrelatedLocal = 'UNCHANGED_BODY_LINE';
  return value + 1;
}

export function outside(): string { return 'MATCH_OUTSIDE_SELECTED'; }
`;
const fixtureFile = path.join(fixtureDirectory, 'sample.ts');
await writeFile(fixtureFile, original);
await exec('git', ['init', '--quiet'], { cwd: fixtureDirectory, windowsHide: true });
await exec('git', ['config', 'core.autocrlf', 'false'], { cwd: fixtureDirectory, windowsHide: true });
await exec('git', ['add', '--', 'sample.ts'], { cwd: fixtureDirectory, windowsHide: true });
await writeFile(fixtureFile, original.replace('return value + 1;', 'return value + 2;'));

function cursorOf(page: string): string | undefined {
  return /\n\[truncated next=([A-Za-z0-9_-]+)\]$/.exec(page)?.[1];
}

function pageBody(page: string): string {
  return page.replace(/^\[continued\]\n/, '').replace(/\n\[truncated next=[A-Za-z0-9_-]+\]$/, '');
}

test('context batches outline, full symbol, scoped lines and AST-labelled changed lines', async () => {
  const cwd = process.cwd();
  process.chdir(fixtureDirectory);
  try {
    const result = await getContext({ requests: [
      { op: 'outline', file: fixtureFile, symbol: 'Service', detail: 'names', publicOnly: true },
      { op: 'symbol', file: fixtureFile, symbol: 'selected' },
      { op: 'lines', file: fixtureFile, symbol: 'selected', find: 'MATCH_IN_SELECTED' },
      { op: 'diff' },
    ], maxTokens: 16_000 });
    const sections = result.split(/(?=^\[\d+\]\n)/m).filter(Boolean);
    assert.equal(sections.length, 4);
    assert.match(sections[0]!, /class Service/);
    assert.match(sections[0]!, /method Service\.run/);
    assert.doesNotMatch(sections[0]!, /hidden|constructor|CLASS_BODY|outside/);
    assert.match(sections[1]!, /import \{ join \}/);
    assert.match(sections[1]!, /function selected/);
    assert.match(sections[1]!, /OMITTED_START/);
    assert.doesNotMatch(sections[1]!, /randomUUID|MATCH_OUTSIDE_SELECTED/);
    assert.match(sections[2]!, /snippet selected/);
    assert.match(sections[2]!, /\d+:.*MATCH_IN_SELECTED/);
    assert.match(sections[2]!, /\.\.\./);
    assert.doesNotMatch(sections[2]!, /OMITTED_START|MATCH_OUTSIDE_SELECTED|import /);
    assert.match(sections[3]!, /function changed/);
    assert.match(sections[3]!, /old L\d+:\n  return value \+ 1;/);
    assert.match(sections[3]!, /new L\d+:\n  return value \+ 2;/);
    assert.doesNotMatch(sections[3]!, /UNCHANGED_BODY_LINE|^@@|diff --git/m);
  } finally {
    process.chdir(cwd);
  }
});

test('line search stays inside the selected AST symbol and a failed batch item does not hide other results', async () => {
  const result = await getContext({ requests: [
    { op: 'outline', file: path.join(fixtureDirectory, 'missing.ts') },
    { op: 'lines', file: fixtureFile, symbol: 'selected', find: 'MATCH_OUTSIDE_SELECTED' },
    { op: 'symbol', file: fixtureFile, symbol: 'outside', imports: 'none' },
  ] });
  assert.match(result, /^\[0\] ERROR .*ENOENT/m);
  assert.match(result, /^\[1\] ERROR No match/m);
  assert.match(result, /\[2\]\nexport function outside/);
  assert.match(result, /MATCH_OUTSIDE_SELECTED/);
  assert.doesNotMatch(result, /import \{/);
});

test('128-token pages include continuation metadata and reconstruct Unicode and a single long line exactly', () => {
  for (const text of [
    Array.from({ length: 70 }, (_, index) => `Строка ${index}: 🌲東京 — русский текст, emoji 🙂, <|endoftext|>.\n`).join(''),
    '🙂漢字Приветabc'.repeat(250),
  ]) {
    let cursor: string | undefined;
    const fragments: string[] = [];
    const seen = new Set<string>();
    let pages = 0;
    do {
      const page = paginate(text, 128, cursor);
      assert.ok(countTokens(page) <= 128, `Page uses ${countTokens(page)} tokens.`);
      const fragment = pageBody(page);
      assert.ok(fragment.length > 0);
      assert.doesNotMatch(fragment, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      fragments.push(fragment);
      cursor = cursorOf(page);
      if (cursor) {
        assert.ok(!seen.has(cursor), 'Pagination must advance.');
        seen.add(cursor);
      }
      pages += 1;
      assert.ok(pages < 200, 'Pagination should finish.');
    } while (cursor);
    assert.ok(pages > 1);
    assert.equal(fragments.join(''), text);
  }
});

test('pagination rejects stale or malformed cursors and invalid budgets', () => {
  const source = 'значение 🌍 '.repeat(300);
  const cursor = cursorOf(paginate(source, 128));
  assert.ok(cursor);
  assert.throws(() => paginate(source + ' edited', 128, cursor), /Stale or invalid cursor/);
  assert.throws(() => paginate(source, 128, 'garbage'), /Stale or invalid cursor/);
  for (const budget of [0, 127, 128.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => paginate(source, budget), /maxTokens/);
  }
  assert.equal(paginate('', 128), '');
  assert.doesNotThrow(() => countTokens('<|endoftext|>'));
});

test('context symbol follows referenced types inside the configured root unless opted out', async () => {
  const workspace = path.join(fixtureDirectory, 'workspace with spaces');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'meta.ts'), `export interface Meta { requestId: string }
export interface OtherMeta { debug: boolean }
`);
  await writeFile(path.join(workspace, 'typed.ts'), `import type { Meta } from './meta.js';
import type { Unused } from './unused.js';
interface Inner { meta: Meta }
type Outer = Inner;
interface Unrelated { value: Unused }
export function format(value: Outer): Outer { return value; }
`);
  const request: ContextRequest = { op: 'symbol', file: 'typed.ts', symbol: 'format' };
  await withContextClient(async (client) => {
    const result = await callContext(client, { requests: [request] });
    assert.match(result, /import type \{ Meta \} from '\.\/meta\.js'/);
    assert.match(result, /interface Inner \{ meta: Meta \}/);
    assert.match(result, /type Outer = Inner/);
    assert.match(result, /export interface Meta \{ requestId: string \}/);
    assert.match(result, /function format\(value: Outer\): Outer \{ return value; \}/);
    assert.doesNotMatch(result, /Unrelated|Unused|unused\.js|OtherMeta/);

    const optedOut = await callContext(client, { requests: [{ ...request, includeTypes: false }] });
    assert.match(optedOut, /function format\(value: Outer\)/);
    assert.doesNotMatch(optedOut, /interface Inner|type Outer =|meta\.js|interface Meta/);
  }, { env: { SKEL_MCP_ROOT: workspace } });
});

test('context budgets count request hashes and continuations and invalidate cursor after a file edit', async () => {
  const file = path.join(fixtureDirectory, 'large.ts');
  await writeFile(file, `export function large() {\n${Array.from({ length: 100 }, (_, index) => `  console.log('line ${index} 🌲東京');`).join('\n')}\n}\n`);
  const requests: ContextRequest[] = [{ op: 'symbol', file, symbol: 'large', imports: 'none' }];
  const first = await getContext({ requests, versions: true, maxTokens: 128 });
  assert.ok(countTokens(first) <= 128);
  assert.match(first, /^\[0\] h=[a-f0-9]{16}\n/);
  const cursor = cursorOf(first);
  assert.ok(cursor);
  const second = await getContext({ requests, versions: true, maxTokens: 128, cursor });
  assert.match(second, /^\[continued\]\n/);
  assert.ok(countTokens(second) <= 128);
  const before = await readFile(file, 'utf8');
  await writeFile(file, before.replace('line 99', 'edited line 99'));
  await assert.rejects(getContext({ requests, versions: true, maxTokens: 128, cursor }), /Stale or invalid cursor/);
});

test('unchanged responses require an explicit caller hash and changed code produces a new revision', async () => {
  const file = path.join(fixtureDirectory, 'versioned.ts');
  await writeFile(file, 'export function versioned() { return "VERSION_ONE"; }\n');
  const request: ContextRequest = { op: 'symbol', file, symbol: 'versioned' };
  const plain = await getContext({ requests: [request] });
  assert.match(plain, /VERSION_ONE/);
  assert.equal(await getContext({ requests: [request] }), plain);
  assert.doesNotMatch(plain, /unchanged| h=/);
  const versioned = await getContext({ requests: [request], versions: true });
  const revision = /^\[0\] h=([a-f0-9]{16})\n/.exec(versioned)?.[1];
  assert.ok(revision);
  const same = await getContext({ requests: [{ ...request, ifHash: revision }] });
  assert.equal(same, `[0] h=${revision}\nunchanged`);
  await writeFile(file, 'export function versioned() { return "VERSION_TWO"; }\n');
  const changed = await getContext({ requests: [{ ...request, ifHash: revision }] });
  assert.match(changed, /VERSION_TWO/);
  assert.doesNotMatch(changed, /unchanged/);
  assert.notEqual(/^\[0\] h=([a-f0-9]{16})\n/.exec(changed)?.[1], revision);
});

async function withContextClient<T>(
  run: (client: Client) => Promise<T>,
  launch: { cwd?: string; env?: Record<string, string> } = {},
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    cwd: launch.cwd ?? fixtureDirectory,
    env: launch.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'skel-mcp-context-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}

async function callContext(client: Client, input: ContextInput): Promise<string> {
  const result = await client.callTool({ name: 'get_context', arguments: { ...input } });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content.length, 1);
  assert.equal(result.structuredContent, undefined);
  const content = result.content[0];
  assert.ok(content?.type === 'text' && typeof content.text === 'string', 'Expected one text payload.');
  return content.text;
}

test('default stdio exposes one get_context tool and resolves batched reads from the configured root', async () => {
  const launchDirectory = path.join(fixtureDirectory, 'launch');
  await mkdir(launchDirectory);
  await withContextClient(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['get_context']);
    const result = await callContext(client, { requests: [
      { op: 'outline', file: 'sample.ts', symbol: 'Service', publicOnly: true, detail: 'names' },
      { op: 'symbol', file: 'sample.ts', symbol: 'outside', imports: 'none' },
    ], maxTokens: 128 });
    assert.ok(countTokens(result) <= 128);
    assert.match(result, /method Service\.run/);
    assert.equal(result.match(/function outside/g)?.length, 1);
    assert.doesNotMatch(result, /hidden|PRIVATE_BODY/);
  }, { cwd: launchDirectory, env: { SKEL_MCP_ROOT: fixtureDirectory } });
});

test('default stdio pages a large symbol and permits a caller to retrieve the complete result', async () => {
  const source = [
    'export function largePagedSymbol() {',
    '  const rows = [];',
    ...Array.from({ length: 1600 }, (_, index) => `  rows.push('row ${index} Приём данных 🌍');`),
    '  return rows;',
    '}',
  ].join('\n');
  await writeFile(path.join(fixtureDirectory, 'paged.ts'), `${source}\n`);
  const requests: ContextRequest[] = [{ op: 'symbol', file: 'paged.ts', symbol: 'largePagedSymbol' }];
  const { first, second, secondCursor } = await withContextClient(async (client) => {
    const first = await callContext(client, { requests });
    assert.ok(countTokens(first) <= 1200);
    const firstCursor = cursorOf(first);
    assert.ok(firstCursor, 'The first page must advertise a continuation.');

    const second = await callContext(client, { requests, cursor: firstCursor });
    assert.match(second, /^\[continued\]\n/);
    assert.ok(countTokens(second) <= 1200);
    const secondCursor = cursorOf(second);
    assert.ok(secondCursor && secondCursor !== firstCursor, 'The cursor must advance.');
    return { first, second, secondCursor };
  });

  // A fresh server process has never seen this cursor or the preceding pages.
  await withContextClient(async (client) => {
    const remainder = await callContext(client, { requests, cursor: secondCursor, maxTokens: null });
    assert.match(remainder, /^\[continued\]\n/);
    assert.equal(cursorOf(remainder), undefined);
    assert.ok(countTokens(remainder) > 16_000);
    const complete = await callContext(client, { requests, maxTokens: null });
    assert.equal(complete, `[0]\n${source}`);
    assert.equal(pageBody(first) + pageBody(second) + pageBody(remainder), complete);

    const largePage = await callContext(client, { requests, maxTokens: 17_000 });
    assert.ok(countTokens(largePage) > 16_000 && countTokens(largePage) <= 17_000);
    assert.ok(cursorOf(largePage));
    assert.ok(complete.startsWith(pageBody(largePage)));
  });
});

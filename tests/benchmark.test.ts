import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import {
  completedToolCalls,
  finalAnswer,
  normalizeAnswer,
  parseEvents,
  readUsage,
  totalTokens,
  validRetrieval,
  type Event,
} from '../benchmarks/harness.js';
import { prepareFixtures, tasks } from '../benchmarks/tasks.js';
import { getSmartDiff } from '../src/git.js';
import { getFileSkeleton, getSymbol } from '../src/parser.js';

test('benchmark totals use reported input and output without counting cached/reasoning twice', () => {
  const events = parseEvents([
    '{"type":"thread.started","thread_id":"sample"}',
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":1500,"cached_input_tokens":1200,"output_tokens":100,"reasoning_output_tokens":60}}',
    '',
  ].join('\r\n'));
  const usage = readUsage(events);
  assert.equal(totalTokens(usage), 1600);
  assert.equal(usage.input_tokens - usage.cached_input_tokens, 300);
});

test('benchmark rejects missing, duplicate and invalid CLI usage instead of inventing token counts', () => {
  assert.throws(() => readUsage([{ type: 'turn.failed' }]), /exactly one/);
  assert.throws(() => readUsage([{ type: 'turn.completed' }]), /report usage/);
  const valid: Event = {
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 },
  };
  assert.throws(() => readUsage([valid, valid]), /exactly one/);
  for (const usage of [
    { input_tokens: -1, cached_input_tokens: 0, output_tokens: 2 },
    { input_tokens: 10.5, cached_input_tokens: 0, output_tokens: 2 },
    { input_tokens: 10, cached_input_tokens: 11, output_tokens: 2 },
    { input_tokens: 10, cached_input_tokens: 0, output_tokens: -2 },
  ]) {
    assert.throws(() => readUsage([{ type: 'turn.completed', usage }]), /Invalid|subset/);
  }
});

test('benchmark requires valid JSONL and takes the final completed JSON answer', () => {
  assert.throws(() => parseEvents('{"type":"turn.started"}\nnot-json\n'), /Invalid CLI JSONL/);
  const events = parseEvents([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"intermediate"}' } }),
    JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: '{"answer":"unfinished"}' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"  return order.SubtotalCents >= minimumCents  "}' } }),
  ].join('\n'));
  assert.equal(normalizeAnswer(finalAnswer(events)), 'return order.SubtotalCents >= minimumCents');
  assert.throws(() => finalAnswer([]), /final answer/);
  assert.throws(() => finalAnswer([{ type: 'item.completed', item: { type: 'agent_message', text: '{"answer":123}' } }]), /answer string/);
});

test('benchmark counts completed retrievals once and keeps tool discovery separate', () => {
  const events: Event[] = [
    { type: 'item.started', item: { type: 'mcp_tool_call', server: 'skel', tool: 'get_symbol' } },
    { type: 'item.completed', item: { type: 'tool_search' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'skel', tool: 'get_symbol' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'git diff' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"ok"}' } },
  ];
  const calls = completedToolCalls(events);
  assert.deepEqual(calls.map((call) => call?.type), ['tool_search', 'mcp_tool_call', 'command_execution']);
  assert.equal(calls.filter((call) => call?.type !== 'tool_search').length, 2);
});

test('benchmark accepts only the requested successful MCP retrieval with matching arguments', () => {
  const expected = { tool: 'get_symbol', arguments: { filePath: 'cart.js', symbolName: 'getCartTotal' } };
  const item: NonNullable<Event['item']> = {
    type: 'mcp_tool_call', status: 'completed', server: 'skel', tool: 'get_symbol',
    arguments: { symbolName: 'getCartTotal', filePath: 'cart.js' },
    result: { content: [{ type: 'text', text: 'export function getCartTotal() {}' }] },
  };
  const events = (current: Event['item']): Event[] => [
    { type: 'item.started', item },
    { type: 'item.completed', item: { type: 'tool_search', status: 'completed' } },
    { type: 'item.completed', item: current },
  ];
  assert.equal(validRetrieval(events(item), 'with-mcp', expected, 'baseline'), true);
  for (const change of [
    { status: 'failed' },
    { server: 'other-server' },
    { tool: 'get_file_skeleton' },
    { arguments: { filePath: 'cart.js', symbolName: 'createCart' } },
    { arguments: { filePath: 'cart.js', symbolName: 'getCartTotal', unexpected: 'value' } },
    { error: { message: 'Tool failed.' } },
    { result: undefined },
    { result: { content: [] } },
    { result: { content: [{ type: 'text', text: 'failed' }], isError: true } },
    { result: { content: [{ type: 'text', text: 'failed' }], is_error: true } },
  ]) {
    assert.equal(validRetrieval(events({ ...item, ...change }), 'with-mcp', expected, 'baseline'), false);
  }
  assert.equal(validRetrieval([], 'with-mcp', expected, 'baseline'), false);
  assert.equal(validRetrieval([
    { type: 'item.completed', item }, { type: 'item.completed', item },
  ], 'with-mcp', expected, 'baseline'), false);
});

test('benchmark full-file baseline rejects failed, partial or multiple shell retrievals', () => {
  const expected = { tool: 'get_symbol', arguments: { filePath: 'cart.js', symbolName: 'getCartTotal' } };
  const baseline = 'export function first() {\n  return 1;\n}\nexport function second() {\n  return 2;\n}\n';
  const item: NonNullable<Event['item']> = {
    type: 'command_execution', status: 'completed', exit_code: 0,
    aggregated_output: `shell output:\r\n${baseline.replaceAll('\n', '\r\n')}\r\n`,
  };
  const events = (current: Event['item']): Event[] => [{ type: 'item.completed', item: current }];
  assert.equal(validRetrieval(events(item), 'without-mcp', expected, baseline), true);
  for (const change of [
    { status: 'failed' },
    { exit_code: 1 },
    { aggregated_output: baseline.slice(0, 45) + '\n[output truncated]' },
    { aggregated_output: 'file not found' },
    { aggregated_output: undefined },
    { type: 'mcp_tool_call' },
  ]) {
    assert.equal(validRetrieval(events({ ...item, ...change }), 'without-mcp', expected, baseline), false);
  }
  assert.equal(validRetrieval(events(item), 'without-mcp', expected, ''), false);
  assert.equal(validRetrieval([
    { type: 'item.completed', item }, { type: 'item.completed', item },
  ], 'without-mcp', expected, baseline), false);
});

const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'skel-mcp-benchmark-test-'));
after(async () => {
  assert.ok(path.resolve(fixtureDirectory).startsWith(path.join(path.resolve(tmpdir()), 'skel-mcp-benchmark-test-')));
  await rm(fixtureDirectory, { recursive: true, force: true });
});
await prepareFixtures(fixtureDirectory);
const exec = promisify(execFile);

test('benchmark fixture repository stages its baseline and exposes exactly one known unstaged change', async () => {
  assert.deepEqual((await readdir(fixtureDirectory)).sort(), [
    '.git', 'cart.js', 'catalog.ts', 'paging.py', 'pricing.ts', 'shipping.go', 'tiny.ts',
  ].sort());
  const git = async (...args: string[]): Promise<string> => (await exec('git', args, {
    cwd: fixtureDirectory, windowsHide: true,
  })).stdout;
  assert.equal((await git('diff', '--name-only')).trim(), 'pricing.ts');
  const baseline = await git('show', ':pricing.ts');
  const current = await readFile(path.join(fixtureDirectory, 'pricing.ts'), 'utf8');
  assert.match(baseline, /subtotal >= 100 \? 0\.1 : 0/);
  assert.equal(current, baseline.replace('subtotal >= 100 ? 0.1 : 0', 'subtotal >= 200 ? 0.1 : 0'));
  assert.equal(tasks.length, 6);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
});

test('benchmark MCP retrievals provide the necessary evidence for the same six tasks', async () => {
  const results = new Map<string, string>();
  for (const task of tasks) {
    const args = task.retrieval.arguments;
    const filePath = path.join(fixtureDirectory, args.filePath ?? '');
    const result = task.retrieval.tool === 'get_file_skeleton'
      ? await getFileSkeleton(filePath)
      : task.retrieval.tool === 'get_symbol'
        ? await getSymbol(filePath, args.symbolName!)
        : await getSmartDiff(fixtureDirectory);
    results.set(task.id, result);
    assert.ok(result.length > 0, task.id);
  }

  const catalog = results.get('typescript-api')!;
  for (const name of ['add', 'find', 'list', 'remove']) assert.match(catalog, new RegExp(`\\b${name}\\(`));
  assert.match(catalog, /private normalizeTags/);
  assert.doesNotMatch(catalog, /Item id is required/);

  const cart = results.get('javascript-total')!;
  const cartModule = await import(`data:text/javascript;base64,${Buffer.from(cart).toString('base64')}`) as {
    getCartTotal: (items: { price: number; quantity: number }[], discount: number) => number;
  };
  assert.equal(String(cartModule.getCartTotal([{ price: 19.9, quantity: 2 }, { price: 5, quantity: 3 }], 10)),
    tasks.find((task) => task.id === 'javascript-total')!.expectedAnswer);
  assert.doesNotMatch(cart, /function createCart/);

  assert.match(results.get('python-boundary')!, /end = min\(total, start \+ page_size - 1\)/);
  assert.match(results.get('go-boundary')!, /return order\.SubtotalCents > minimumCents/);
  const review = results.get('git-review')!;
  assert.match(review, /function calculateTotal/);
  assert.match(review, /subtotal >= 200 \? 0\.1 : 0/);
  assert.doesNotMatch(review, /function formatSummary|^@@/m);
  assert.match(results.get('tiny-file')!, /export function isEven/);
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { countTokens } from '../src/context.js';
import { compactRequests } from './compact-tasks.js';
import { prepareFixtures, tasks } from './tasks.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'skel-mcp-payload-'));
const output = path.join(root, 'benchmarks', 'runs', 'payload');
await mkdir(output, { recursive: true });
await prepareFixtures(directory);
const old = new Client({ name: 'payload-before', version: '1' });
const compact = new Client({ name: 'payload-after', version: '1' });
const connect = (client: Client, args: string[]): Promise<void> => client.connect(new StdioClientTransport({
  command: process.execPath, args, cwd: directory, stderr: 'pipe',
}));
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
};
try {
  await connect(old, [path.join(root, 'benchmarks', 'baseline-server', 'index.js')]);
  await connect(compact, [path.join(root, 'dist', 'index.js')]);
  const beforeTools = await old.listTools();
  const afterTools = await compact.listTools();
  const rows = [];
  for (const task of tasks) {
    const before = textOf(await old.callTool({ name: task.retrieval.tool, arguments: task.retrieval.arguments }));
    const after = textOf(await compact.callTool({ name: 'get_context', arguments: { requests: [compactRequests[task.id]!] } }));
    assert.doesNotMatch(after, /\bERROR\b|\[truncated/);
    rows.push({ id: task.id, title: task.title, beforeTokens: countTokens(before), afterTokens: countTokens(after), before, after });
  }
  const batch = textOf(await compact.callTool({ name: 'get_context', arguments: { requests: tasks.map((task) => compactRequests[task.id]!) } }));
  const before = rows.reduce((sum, row) => sum + row.beforeTokens, 0);
  const after = rows.reduce((sum, row) => sum + row.afterTokens, 0);
  const result = {
    encoding: 'o200k_base',
    schemaTokens: { before: countTokens(JSON.stringify(beforeTools.tools)), after: countTokens(JSON.stringify(afterTools.tools)) },
    totals: { before, after, batch: countTokens(batch), savedPercent: (1 - after / before) * 100 },
    rows, batch,
  };
  await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(output, 'report.md'), [
    '# MCP response payload benchmark', '',
    'This benchmark counts MCP response text using o200k_base. Both servers process the same fixtures.', '',
    '| Task | Legacy tool response | Compact tool response |', '| --- | ---: | ---: |',
    ...rows.map((row) => `| ${row.title} | ${row.beforeTokens} | ${row.afterTokens} |`),
    `| Total | ${before} | ${after} |`, '',
    `Response text shrank ${result.totals.savedPercent.toFixed(2)}%. A single compact batch returned all six excerpts in ${result.totals.batch} tokens.`, '',
    `The serialized listTools JSON took ${result.schemaTokens.before} tokens for the legacy server and ${result.schemaTokens.after} for compact mode.`, '',
    'Compact requests select the level of detail each task requires. Full code remains available on request. The paired agent benchmark measures end-to-end usage and verifies answers separately.', '',
  ].join('\n'));
  console.log(JSON.stringify({ totals: result.totals, schemaTokens: result.schemaTokens }));
} finally {
  await Promise.allSettled([old.close(), compact.close()]);
  assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'skel-mcp-payload-')));
  await rm(directory, { recursive: true, force: true });
}

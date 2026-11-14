import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('legacy stdio exposes all three original tools and returns usable results and tool errors', async () => {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'skel-mcp-stdio-test-'));
  const filePath = path.join(fixtureDirectory, 'sample.ts');
  await writeFile(filePath, `import path from 'node:path';
export function hello(name: string): string {
  return path.join('MCP_FUNCTION_BODY', name);
}
`, 'utf8');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--legacy'],
    cwd: fixtureDirectory,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'skel-mcp-integration-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), ['get_file_skeleton', 'get_smart_diff', 'get_symbol']);
    const skeleton = await client.callTool({ name: 'get_file_skeleton', arguments: { filePath } });
    assert.notEqual(skeleton.isError, true);
    const skeletonText = JSON.stringify(skeleton.content);
    assert.match(skeletonText, /function hello/);
    assert.doesNotMatch(skeletonText, /MCP_FUNCTION_BODY/);
    const symbol = await client.callTool({ name: 'get_symbol', arguments: { filePath, symbolName: 'hello' } });
    assert.notEqual(symbol.isError, true);
    assert.match(JSON.stringify(symbol.content), /MCP_FUNCTION_BODY/);
    const missing = await client.callTool({ name: 'get_symbol', arguments: { filePath, symbolName: 'missing' } });
    assert.equal(missing.isError, true);
    const diff = await client.callTool({ name: 'get_smart_diff', arguments: {} });
    assert.equal(diff.isError, true);
    assert.match(JSON.stringify(diff.content), /git|repository/i);
  } finally {
    await client.close();
    assert.ok(fixtureDirectory.startsWith(path.join(tmpdir(), 'skel-mcp-stdio-test-')));
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test('--compact still starts the single get_context MCP tool', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--compact'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'skel-mcp-compact-alias-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['get_context']);
  } finally {
    await client.close();
  }
});

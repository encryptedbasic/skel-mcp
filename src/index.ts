#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerContextTool, registerLegacyTools } from './tools.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

async function main(): Promise<void> {
  const root = process.env.SKEL_MCP_ROOT || process.env.CLAUDE_PROJECT_DIR;
  if (root) process.chdir(root);
  const server = new McpServer({ name: 'skel-mcp', version });
  if (process.argv.includes('--legacy')) registerLegacyTools(server);
  else await registerContextTool(server);

  await server.connect(new StdioServerTransport());
  const shutdown = (): void => { void server.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('skel-mcp:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getSmartDiff } from './git.js';
import { getFileSkeleton, getSymbol } from './parser.js';
import { resolveWorkspaceFile } from './source-files.js';

const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const filePath = z.string().min(1);

async function toolResult(action: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await action() }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export async function registerContextTool(server: McpServer): Promise<void> {
  const { getContext } = await import('./context.js');
  server.registerTool('get_context', {
    description: 'Batch AST reads. outline: signatures/names. symbol: code with imports/types, or explicit returns only. lines: literal match with contextLines. diff: changes/full scoped by file/symbol. Share a top-level file. Use sources:true for file/symbol labels. Continue with cursor or maxTokens:null.',
    inputSchema: {
      file: filePath.optional(),
      requests: z.array(z.object({
        op: z.enum(['outline', 'symbol', 'lines', 'diff']),
        file: filePath.optional(),
        symbol: z.string().optional(),
        find: z.string().optional(),
        detail: z.enum(['signatures', 'names', 'full', 'changes', 'returns']).optional(),
        contextLines: z.number().int().min(0).max(5).optional(),
        publicOnly: z.boolean().optional(),
        imports: z.enum(['referenced', 'all', 'none']).optional(),
        includeTypes: z.boolean().optional(),
        ifHash: z.string().optional(),
      })).min(1).max(20),
      maxTokens: z.number().int().min(128).nullable().optional(),
      cursor: z.string().optional(),
      versions: z.boolean().optional(),
      sources: z.boolean().optional(),
    },
    annotations,
  }, (input) => toolResult(() => getContext(input, process.cwd())));
}

export function registerLegacyTools(server: McpServer): void {
  server.registerTool('get_file_skeleton', {
    description: 'TS/JS/Python/Go imports, types and signatures; bodies omitted.',
    inputSchema: { filePath },
    annotations,
  }, ({ filePath }) => toolResult(async () => getFileSkeleton(await resolveWorkspaceFile(filePath))));

  server.registerTool('get_symbol', {
    description: 'Full function, method or class with imports. Names may be Class.method.',
    inputSchema: { filePath, symbolName: z.string().trim().min(1) },
    annotations,
  }, ({ filePath, symbolName }) => toolResult(async () => getSymbol(await resolveWorkspaceFile(filePath), symbolName)));

  server.registerTool('get_smart_diff', {
    description: 'Full functions/classes affected by unstaged git diff under cwd; deletions from index.',
    inputSchema: {},
    annotations,
  }, () => toolResult(() => getSmartDiff()));
}

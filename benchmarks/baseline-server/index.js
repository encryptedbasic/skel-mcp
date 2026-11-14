#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getFileSkeleton, getSymbol } from './parser.js';
import { getSmartDiff } from './git.js';
async function toolResult(action) {
    try {
        return { content: [{ type: 'text', text: await action() }] };
    }
    catch (error) {
        return {
            isError: true,
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
    }
}
const server = new McpServer({ name: 'skel-mcp', version: '0.1.0' });
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const filePath = z.string().min(1).describe('Absolute path or path relative to the server working directory.');
server.registerTool('get_file_skeleton', {
    description: 'Return imports, types/interfaces, and function/class signatures with implementation bodies omitted. Supports TypeScript, JavaScript, Python, and Go.',
    inputSchema: { filePath },
    annotations,
}, ({ filePath }) => toolResult(() => getFileSkeleton(filePath)));
server.registerTool('get_symbol', {
    description: 'Return the full source of a named function, method, or class with file imports. Use a qualified name such as Class.method to disambiguate.',
    inputSchema: {
        filePath,
        symbolName: z.string().trim().min(1).describe('Symbol name or qualified name, for example UserService.find.'),
    },
    annotations,
}, ({ filePath, symbolName }) => toolResult(() => getSymbol(filePath, symbolName)));
server.registerTool('get_smart_diff', {
    description: 'Inspect unstaged tracked Git changes under the server working directory and return full affected functions/classes instead of raw line diffs. Deleted symbols are reported from the index.',
    inputSchema: {},
    annotations,
}, () => toolResult(() => getSmartDiff()));
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    const shutdown = async () => {
        await server.close();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}
main().catch((error) => {
    // stdout is reserved exclusively for MCP JSON-RPC messages.
    console.error('skel-mcp:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map
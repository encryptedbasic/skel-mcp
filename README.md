# skel-mcp

**Give coding agents the code they need for the task.**

`skel-mcp` is a local Model Context Protocol server for TypeScript, JavaScript, Python, and Go. One call can retrieve signatures, complete symbol bodies, related types and imports, or the changed lines in a Git working tree. The server uses bundled Tree-sitter grammars and caches syntax trees by file content.

[Connect your client](#connect-a-client) · [Release v0.3.1](https://github.com/encryptedbasic/skel-mcp/releases/tag/v0.3.1) · [Token savings](#token-savings)

## Token savings

| Codex benchmark with skel-mcp 0.2.0 | Without MCP | With skel-mcp | Fewer tokens |
| --- | ---: | ---: | ---: |
| Six separate tasks | 212,180 | 149,252 | **29.7%** |
| The same six tasks in one request | 41,966 | 26,216 | **37.5%** |

![Codex CLI benchmark token totals](docs/assets/benchmark-tokens.svg)

Each row records one paired run with matching prompts and verified answers. The MCP runs used compact responses and Codex's direct MCP tool configuration. The baseline read full files for file tasks and ran `git diff` for Git tasks. Both sides of the batch test retrieved context in one call. Counts include agent input and output tokens. Savings vary by client and task. [Six-task report](benchmarks/results/optimized/report.md) · [Batch report](benchmarks/results/optimized-batch/report.md)

## Quick start

Use Node.js 20 or newer. Git operations require `git` on your `PATH`. Start the server from the project you want to analyze, or set the project directory in your client.

```sh
npx --yes skel-mcp@0.3.1
```

You can also launch the package directly from the GitHub release.

```sh
npx --yes --package=https://github.com/encryptedbasic/skel-mcp/releases/download/v0.3.1/skel-mcp-0.3.1.tgz skel-mcp
```

The first launch may download dependencies. The server waits for MCP requests on stdin and sends protocol messages on stdout.

## Connect a client

For a local archive, replace the `npx` arguments below with `["--yes", "--package=/absolute/path/skel-mcp-0.3.1.tgz", "skel-mcp"]`. You can also run a built checkout with `node` and an absolute path to its `dist/index.js`.

### Claude Code

Run this command from your project directory.

```sh
claude mcp add --transport stdio skel -- npx --yes skel-mcp@0.3.1
```

To share the configuration with your project, put the server in the root `.mcp.json` under `mcpServers`. Claude Code supplies the project directory through `CLAUDE_PROJECT_DIR`. Check the connection in `/mcp`. [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)

### Cursor

Save this in the project's `.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "skel": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "skel-mcp@0.3.1"],
      "env": {
        "SKEL_MCP_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

[Cursor MCP documentation](https://cursor.com/docs/mcp)

### Codex

Add this server to `.codex/config.toml` and replace `cwd` with the absolute path to your project.

```toml
[mcp_servers.skel]
command = "npx"
args = ["--yes", "skel-mcp@0.3.1"]
cwd = "/absolute/path/to/project"
```

To use the optional direct-tool setting from the benchmark, add this to the Codex configuration. The namespace matches the server name `skel`. Support can vary by Codex version. [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```toml
[features.code_mode]
direct_only_tool_namespaces = ["mcp__skel"]
```

### VS Code and other stdio clients

Use the **stdio** transport with `command` set to `npx` and `args` set to `["--yes", "skel-mcp@0.3.1"]`. Set `cwd` if supported, or pass an absolute project path as `SKEL_MCP_ROOT`. VS Code supports project configuration under `mcpServers` in `.mcp.json` where the Copilot harness offers it. Editor-managed `.vscode/mcp.json` uses a top-level `servers` key. [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)

If a Windows client cannot launch `npx` directly, use `"command": "cmd.exe"` with `"args": ["/d", "/c", "npx", "--yes", "skel-mcp@0.3.1"]`.

## One tool, four operations

`get_context` accepts up to 20 requests in a batch. Set a top-level `file` to use that path for every item without its own `file`. The response labels each result with its request index. Set `sources: true` to add the workspace-relative file and symbol, such as `[1] src/service.ts#Service.run`. This is useful when forwarding results or comparing duplicate names. Reads are scoped to the configured project directory and exclude Git metadata.

```json
{
  "file": "src/service.ts",
  "requests": [
    { "op": "outline", "symbol": "Service", "detail": "names" },
    { "op": "symbol", "symbol": "Service.run", "detail": "returns" },
    { "op": "diff", "symbol": "Service.run" }
  ]
}
```

| Operation | Returns |
| --- | --- |
| `outline` | Signatures and type declarations. To focus the response, pass a `symbol`, set `detail: "names"`, or use `publicOnly: true`. Pass `imports: "all"` to include imports. |
| `symbol` | A complete symbol body with related types and imports. Use `detail: "returns"` for explicit return statements or an expression-bodied arrow only. Set `includeTypes: false` to omit related declarations. Use `imports: "all"` for every import from the requested file or `"none"` to omit imports. |
| `lines` | Line-numbered excerpts around literal `find` matches within the requested `symbol`. `contextLines` ranges from 0 to 5 and defaults to 1. |
| `diff` | Unstaged changes to tracked files, labeled by their enclosing AST symbols. Filter by an exact `file` or a `symbol` name. A symbol filter keeps both sides of every Git hunk that touches its source lines. Use `detail: "full"` for complete affected bodies. |

Use `detail: "returns"` to extract exact source text for a function or method's returns. It skips nested callables and omits branch conditions, local declarations and other context surrounding the returns. Fetch the full symbol when you need to determine which branch runs, evaluate a return value, or make an edit.

When the same symbol occurs in multiple files, request both by path and enable source labels.

```json
{
  "sources": true,
  "requests": [
    { "op": "symbol", "file": "src/checkout/quote.ts", "symbol": "buildQuote", "detail": "returns" },
    { "op": "symbol", "file": "src/legacy/quote.ts", "symbol": "buildQuote", "detail": "returns" }
  ]
}
```

The results begin with `[0] src/checkout/quote.ts#buildQuote` and `[1] src/legacy/quote.ts#buildQuote`.

Set the project root through `SKEL_MCP_ROOT`, Claude Code's `CLAUDE_PROJECT_DIR`, or the launcher's working directory, in that order. The server resolves related declarations in the requested file and follows one hop of unambiguous relative ESM imports for TypeScript and JavaScript. Python and Go resolve declarations in the requested file. External packages, ambiguous paths, and further dependencies appear as imports.

Pages default to 1,200 tokens counted with `o200k_base`. If a page ends with `[truncated next=…]`, repeat the request with the same `file`, `requests`, `versions` and `sources` and pass the continuation value as `cursor`. Set `maxTokens` to a safe integer of at least 128 or pass `null` for the entire remaining result. Use `versions: true` to receive a content hash. Pass it as `ifHash` to skip unchanged content you already have.

Add `--legacy` to the server arguments to use `get_file_skeleton`, `get_symbol`, and `get_smart_diff` with their original parameters. `--compact` is an alias for the default mode.

## Development

```sh
npm install
npm run build
```

Run `npm pack` to build a local archive. Start it from your project with `npx --yes --package="/absolute/path/skel-mcp-0.3.1.tgz" skel-mcp`.

[MIT license](LICENSE)

# get_context reference

`get_context` is the default MCP tool. Launch the server with `--legacy` for the original three tools. `--compact` is an alias for the default mode.

## Batch requests

```json
{
  "requests": [
    { "op": "outline", "file": "src/service.ts", "symbol": "Service", "detail": "names", "publicOnly": true },
    { "op": "symbol", "file": "src/pricing.ts", "symbol": "calculateTotal" },
    { "op": "lines", "file": "src/paging.py", "symbol": "page_bounds", "find": "end =" },
    { "op": "diff" }
  ],
  "maxTokens": 1200
}
```

The response labels results `[0]`, `[1]`, and so on. Each request is independent. An `ERROR` entry can appear alongside successful results.

| `op` | What it returns |
| --- | --- |
| `outline` | Signatures and type declarations with implementation bodies omitted. Use `detail: "names"` for just names, `symbol` to focus on a class or function, or `publicOnly: true` to hide non-public members and constructors. |
| `symbol` | The complete selected symbol with related declarations and imports. `imports: "all"` includes every import from the requested file, and `imports: "none"` omits imports. `includeTypes: false` omits related declarations. |
| `lines` | Line-numbered excerpts around literal `find` matches inside the requested symbol. Each match gets one line of surrounding context. `...` marks omitted lines. |
| `diff` | Old and new changed lines with line numbers and AST symbol names. `detail: "full"` returns complete affected functions and classes. |

The `outline` operation includes imports when requested with `imports: "all"`. For `symbol`, the server follows references between declarations in the current file. In TypeScript and JavaScript it also follows one hop of unambiguous relative ESM imports inside the project. Python and Go declarations are resolved in the current file. External packages, ambiguous paths, and further dependencies appear as imports. The syntax-based filter keeps side-effect imports and ambiguous cases such as Go imports with implicit package names.

Choose the project with `SKEL_MCP_ROOT`, the Claude Code project directory, or the launcher's working directory. File reads stay within that directory and exclude Git metadata. Git analysis covers unstaged changes to tracked files.

## Pagination and repeated reads

Pages default to 1,200 tokens counted with `o200k_base`. Any safe integer `maxTokens` of 128 or higher sets the page size. `maxTokens: null` returns the whole remaining result. The token count includes headings and continuation markers.

When a response ends with `[truncated next=…]`, repeat the same `requests` and `versions` with the value of `next` as `cursor`. The server prefers line boundaries, and a long line can span pages. Continuation pages start with `[continued]`. If the rendered result changes, start a fresh request without the old cursor.

With `versions: true`, each successful result includes an `h=…` content identifier. Send that value as `ifHash` when the client already has the corresponding result. A matching hash returns `unchanged`. The AST cache accelerates parsing, and the hash lets the client skip unchanged response text.

## Codex direct tool configuration

The benchmark uses `features.code_mode.direct_only_tool_namespaces` to make this server's tool available directly in Codex. The example uses the server name `skel` and namespace `mcp__skel`. Support for this optional setting can vary by Codex version. [Example configuration](../examples/codex-compact.toml) · [Codex feature definition](https://github.com/openai/codex/blob/main/codex-rs/features/src/feature_configs.rs)

For results and reproduction commands, see the [benchmark methodology](../benchmarks/README.md).

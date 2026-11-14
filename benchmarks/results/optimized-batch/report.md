# Compact MCP benchmark for one batch

One paired run of the same six tasks combined into a single prompt. Both arms used Codex CLI `0.167.0-alpha.4.1`, model `gpt-6.1-sol`, and matching prompts and settings. The prompts in this historical run were in Russian. The MCP server supplied all requested context in one `get_context` call with direct MCP tool configuration. The baseline read its full source files and plain Git diff in one shell call. Both answers and retrieval methods passed verification.

The run used **41,966 tokens without MCP** and **26,216 with skel-mcp**, a reduction of **15,750 tokens (37.53%)**.

| Mode | Input | Cached input included | Output | Total |
| --- | ---: | ---: | ---: | ---: |
| Without MCP | 41,795 | 24,960 | 171 | 41,966 |
| With skel-mcp | 26,024 | 12,672 | 192 | 26,216 |

This measures the whole agent turn, including tool overhead and runtime context. Results can vary with tasks, client behavior, and caching. [Methodology](../../../README.md#token-savings)

# Compact MCP benchmark for six separate tasks

One paired run of six tasks with the compact server and direct MCP tool configuration. Both arms used Codex CLI `0.167.0-alpha.4.1`, model `gpt-6.1-sol`, and matching prompts and settings. The prompts in this historical run were in Russian. All 12 answers and retrieval methods passed verification.

The run used **212,180 tokens without MCP** and **149,252 with skel-mcp**, a reduction of **62,928 tokens (29.66%)**.

| Task | Without MCP | With skel-mcp | Reduction | Check |
| --- | ---: | ---: | ---: | --- |
| TypeScript public class methods | 37,510 | 24,857 | 33.73% | Pass |
| JavaScript function result | 37,716 | 25,026 | 33.65% | Pass |
| Python slice boundary | 37,804 | 24,934 | 34.04% | Pass |
| Go free-shipping threshold | 37,710 | 24,905 | 33.96% | Pass |
| Git discount-threshold review | 24,693 | 24,794 | −0.41% | Pass |
| Function name in a small TypeScript file | 36,747 | 24,736 | 32.69% | Pass |
| **Total** | **212,180** | **149,252** | **29.66%** | **Pass** |

| Mode | Input | Cached input included | Output | Total |
| --- | ---: | ---: | ---: | ---: |
| Without MCP | 211,486 | 152,832 | 694 | 212,180 |
| With skel-mcp | 148,784 | 89,344 | 468 | 149,252 |

The baseline used full-file reads and plain `git diff`. The combined effect of compact answers and direct client tool calls is reflected in the reported agent usage. Results can vary with tasks, client behavior, and caching. [Methodology](../../../README.md#token-savings)

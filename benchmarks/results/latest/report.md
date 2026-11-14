# Legacy MCP benchmark

One paired run of six tasks using the original three MCP tools. Both arms used Codex CLI `0.167.0-alpha.4.1`, model `gpt-6.1-sol`, and matching prompts and settings. The prompts in this historical run were in Russian. All 12 answers and retrieval methods passed verification.

The run used **211,636 tokens without MCP** and **223,093 with legacy MCP**, an increase of **11,457 tokens (5.41%)**.

| Task | Without MCP | Legacy MCP | Reduction | Check |
| --- | ---: | ---: | ---: | --- |
| TypeScript public class methods | 37,573 | 37,208 | 0.97% | Pass |
| JavaScript function result | 37,704 | 37,311 | 1.04% | Pass |
| Python slice boundary | 37,562 | 37,311 | 0.67% | Pass |
| Go free-shipping threshold | 37,438 | 37,195 | 0.65% | Pass |
| Git discount-threshold review | 24,666 | 37,107 | −50.44% | Pass |
| Function name in a small TypeScript file | 36,693 | 36,961 | −0.73% | Pass |
| **Total** | **211,636** | **223,093** | **−5.41%** | **Pass** |

| Mode | Input | Cached input included | Output | Total |
| --- | ---: | ---: | ---: | ---: |
| Without MCP | 210,953 | 140,544 | 683 | 211,636 |
| Legacy MCP | 222,319 | 145,536 | 774 | 223,093 |

The baseline used full-file reads and plain `git diff`. The larger totals on Git and the small file illustrate overhead in the original setup. Totals include all reported agent input and output. [Methodology](../../README.md)

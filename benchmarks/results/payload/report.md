# MCP response payload benchmark

This historical run counts tokens in the text of actual MCP responses for the six fixtures, using `o200k_base`. The comparison includes both the baseline server's original tools and the compact server's `get_context`.

| Task | Legacy tool response | Compact tool response |
| --- | ---: | ---: |
| TypeScript public class methods | 200 | 21 |
| JavaScript function result | 186 | 189 |
| Python slice boundary | 129 | 44 |
| Go free-shipping threshold | 42 | 49 |
| Git discount-threshold review | 190 | 55 |
| Function name in a small TypeScript file | 12 | 6 |
| **Total** | **759** | **364** |

The combined response text shrank **52.04%**. A single compact batch returned all six fixture excerpts in 366 tokens.

The compact requests return only the detail each task requires, including names, scoped code lines, or Git changes. Overall agent usage and answer verification are covered in the separate [paired task report](../optimized/report.md). [Methodology](../../README.md)

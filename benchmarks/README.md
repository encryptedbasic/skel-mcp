# Token benchmark

The benchmark gives Codex six small coding tasks and pairs each run against the same task with skel-mcp available. The per-task and batch reports use the actual token-usage counters reported by Codex. The payload report measures the MCP response text separately with `o200k_base`.

| Report | Comparison |
| --- | --- |
| [Six separate tasks](results/optimized/report.md) | Full-file reads or plain Git diff versus compact context with direct MCP tools in Codex |
| [Six tasks in a batch](results/optimized-batch/report.md) | A single shell call versus a single `get_context` call |
| [MCP response size](results/payload/report.md) | Legacy versus compact response text |
| [Legacy baseline](results/latest/report.md) | Full-file reads or plain Git diff versus the original three tools |

## Tasks

| Task | Without MCP | With `get_context` |
| --- | --- | --- |
| List public methods on a TypeScript class | Read all of `catalog.ts` | `outline` with public names |
| Compute the output of a JavaScript function | Read all of `cart.js` | `symbol` for `getCartTotal` |
| Propose a Python slice-boundary fix | Read all of `paging.py` | `lines` around the `end =` assignment |
| Propose a Go comparison fix | Read all of `shipping.go` | `lines` at the return in `Order.QualifiesForFreeShipping` |
| Review a discount-threshold change | Run `git diff` | `diff` with changed lines |
| Find a function in a small TypeScript file | Read all of `tiny.ts` | `outline` with names |

Most files contain 85–100 lines of ordinary code. A tiny file and a short Git diff capture cases where the server can add more context overhead than it saves.

Each pair uses fresh sessions and the same prompt, verified by its SHA-256 hash. The prompt tells the agent to use MCP if available and otherwise read the whole file or run `git diff`. User CLI configuration and skill instructions are disabled consistently. Both arms of the batch scenario retrieve context in one call. The harness checks the answer against a reference, verifies tool arguments and MCP success, and checks that the baseline command returns the expected source or diff. Fix tasks ask for a proposed line of code.

## Reproduce

Run these commands from the source checkout. Use Node.js, Git, and an authenticated `codex` CLI. The paired benchmarks make live model calls.

```sh
npm install
npm run benchmark:optimized
npm run benchmark:optimized -- --batch
npm run benchmark:payload
```

`benchmark:optimized` enables the optional Codex direct-tool setting. `benchmark` uses the client's regular tool discovery, and `benchmark -- --legacy` exercises the original MCP tools. `benchmark:payload` measures tool response text locally and writes results under `benchmarks/runs/payload`.

Use `--task python-boundary` to run one task, `--repeats 3` for three repeats, and `--output benchmarks/runs/custom` to choose an output directory. Set `SKEL_BENCH_CODEX` to the executable path if `codex` is outside `PATH`. The harness writes reports and raw events under `benchmarks/runs/agent` by default. Raw benchmark logs are excluded from version control.

The saved runs used Codex CLI `0.167.0-alpha.4.1`, model `gpt-6.1-sol`, and the same sandbox mode for both arms. Their prompts were written in Russian. The current harness uses English prompts with the same tasks and reference answers. The default benchmark sandbox is read-only. Where that setting blocks fixture reads, pass an appropriate mode using `--sandbox`. The `--model-label` option labels the report, and the runner uses the model selected by the CLI with user configuration disabled.

## Read the numbers

The paired figures sum `input_tokens + output_tokens` from `turn.completed.usage`. Cached input is already included in input tokens. Reasoning tokens are already included in output tokens. Totals include the system prompt, tool context and responses, and conversation history transmitted during the run. [Codex non-interactive usage documentation](https://learn.chatgpt.com/docs/non-interactive-mode)

The full-file baseline measures a common retrieval strategy. More selective shell reads can use fewer tokens. Direct MCP tool configuration was part of the optimized runs, so the end-to-end change reflects the tool response and how the client invokes it. Each saved scenario was run once. Model variation and caching can affect the result. The AST cache helps parsing time.

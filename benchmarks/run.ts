import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completedToolCalls, finalAnswer, normalizeAnswer, parseEvents, readUsage, totalTokens, validRetrieval, type Usage } from './harness.js';
import { prepareFixtures, tasks, type BenchmarkTask } from './tasks.js';
import { compactRequests } from './compact-tasks.js';

type Mode = 'without-mcp' | 'with-mcp';
interface Measurement {
  taskId: string;
  mode: Mode;
  repeat: number;
  promptSha256: string;
  answer: string;
  expectedAnswer: string;
  passed: boolean;
  usage: Usage;
  totalTokens: number;
  elapsedMs: number;
  toolCalls: ReturnType<typeof completedToolCalls>;
  validRetrieval: boolean;
  log: string;
}
type RunTask = Omit<BenchmarkTask, 'retrieval' | 'baseline'> & {
  retrieval: { tool: string; arguments: Record<string, unknown> };
  baseline: BenchmarkTask['baseline'] | { kind: 'batch'; files: string[] };
};

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const repeats = Number(value('--repeats') ?? 1);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, '--repeats must be 1..10.');
const compact = !argv.includes('--legacy');
const direct = argv.includes('--direct');
const batch = argv.includes('--batch');
assert.ok(!batch || compact, '--batch requires get_context');
let selected: RunTask[] = (value('--task') ? tasks.filter((task) => task.id === value('--task')) : tasks)
  .map((task) => compact ? { ...task, retrieval: { tool: 'get_context', arguments: { requests: [compactRequests[task.id]!] } } } : task);
assert.ok(selected.length, 'Unknown task id.');
if (batch) {
  const individual = selected;
  selected = [{
    id: 'batch', title: 'All selected tasks in one request',
    instruction: individual.map((task, i) => `${i + 1}. ${task.instruction}`).join('\n')
      + '\nReturn a single answer string by joining the individual answers in order with | and no spaces around the separator.',
    expectedAnswer: individual.map((task) => task.expectedAnswer).join('|'),
    retrieval: { tool: 'get_context', arguments: { requests: individual.map((task) => compactRequests[task.id]!) } },
    baseline: { kind: 'batch', files: individual.flatMap((task) => task.baseline.kind === 'file' ? [task.baseline.filePath] : []) },
  }];
}
const output = path.resolve(value('--output') ?? path.join(root, 'benchmarks', 'runs', 'agent'));
const codex = process.env.SKEL_BENCH_CODEX ?? 'codex';
const sandbox = value('--sandbox') ?? 'read-only';
assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox), 'Invalid --sandbox.');
const modelLabel = value('--model-label') ?? 'CLI default (not recorded)';
const version = execFileSync(codex, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
const serverPath = path.resolve(value('--server') ?? path.join(root, 'dist', 'index.js'));

// JSON string literals are valid TOML basic strings; normalize local paths for clarity.
const toml = (text: string): string => JSON.stringify(text.replaceAll('\\', '/'));
const scratch = await mkdtemp(path.join(tmpdir(), 'skel-mcp-benchmark-'));
await mkdir(output, { recursive: true });
const workspace = path.join(scratch, 'workspace');
await mkdir(workspace);
await prepareFixtures(workspace);
const schemaPath = path.join(scratch, 'answer.schema.json');
await writeFile(schemaPath, JSON.stringify({
  type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false,
}));
const measurements: Measurement[] = [];

function promptFor(task: RunTask): string {
  const fallback = task.baseline.kind === 'git-diff'
    ? 'run plain git diff without reading additional files'
    : task.baseline.kind === 'batch'
      ? `use one shell call to read the complete contents of ${task.baseline.files.join(', ')} in that order and run git diff. The call can contain multiple reads`
    : `read the complete contents of ${task.baseline.filePath} in one shell call, as the full-file baseline`;
  return [
    'This is a standalone task for a paired benchmark. The working directory already contains the necessary files.',
    'Both benchmark modes receive the same prompt.',
    `If the skel MCP server is available, retrieve context with ${task.retrieval.tool}(${JSON.stringify(task.retrieval.arguments)}).`,
    `If the skel server is unavailable, ${fallback}.`,
    'Retrieve context in one call. Discover the MCP tool first if needed.',
    'Do not use other MCP servers, network access, delegation, skills, or additional commands. Leave files unchanged.',
    'Use only the benchmark workspace. Reference answers and other run results are outside it.',
    'Solve the task using the retrieved context. For fixes, return the proposed line of code.',
    'Respond with JSON in the form {"answer":"..."} without explanation or Markdown.',
    '',
    task.instruction,
  ].join('\n');
}

async function measure(task: RunTask, mode: Mode, repeat: number): Promise<Measurement> {
  const prompt = promptFor(task);
  const baselineText = task.baseline.kind === 'file'
    ? await readFile(path.join(workspace, task.baseline.filePath), 'utf8')
    : task.baseline.kind === 'batch'
      ? (await Promise.all(task.baseline.files.map((file) => readFile(path.join(workspace, file), 'utf8')))).map((text) => text.trim()).join('\n')
        + '\n' + execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color'], { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim()
      : execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  const args = [
    '-a', 'never', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--skip-git-repo-check',
    '-s', sandbox, '-C', workspace, '--output-schema', schemaPath,
    '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
    '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false', '-c', 'skills.max_context_tokens=1',
  ];
  if (direct) args.push('-c', 'features.code_mode.direct_only_tool_namespaces=["mcp__skel"]');
  if (mode === 'with-mcp') {
    args.push(
      '-c', `mcp_servers.skel.command=${toml(process.execPath)}`,
      '-c', `mcp_servers.skel.args=[${toml(serverPath)},${JSON.stringify(compact ? '--compact' : '--legacy')}]`,
      '-c', `mcp_servers.skel.cwd=${toml(workspace)}`,
      '-c', 'mcp_servers.skel.startup_timeout_sec=20',
      '-c', 'mcp_servers.skel.tool_timeout_sec=30',
    );
  }
  args.push('-');
  const log = `${task.id}.${repeat}.${mode}`;
  const start = performance.now();
  console.log(`Running ${task.id} / ${mode} / repeat ${repeat}...`);
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(codex, args, { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Benchmark timed out after 180 seconds: ${log}`));
    }, 180_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.stdin.end(prompt);
  });
  await writeFile(path.join(output, `${log}.jsonl`), stdout);
  await writeFile(path.join(output, `${log}.stderr.log`), stderr);
  await writeFile(path.join(output, `${task.id}.prompt.txt`), prompt);
  if (code !== 0) throw new Error(`CLI exited ${code}: ${log}. See saved logs.`);
  const events = parseEvents(stdout);
  const usage = readUsage(events);
  const answer = finalAnswer(events);
  const calls = completedToolCalls(events);
  const retrievalValid = task.baseline.kind === 'batch' && mode === 'without-mcp'
    ? await validateBatch(events, task.baseline.files)
    : validRetrieval(events, mode, task.retrieval, baselineText);
  const result: Measurement = {
    taskId: task.id, mode, repeat,
    promptSha256: createHash('sha256').update(prompt).digest('hex'),
    answer, expectedAnswer: task.expectedAnswer,
    passed: normalizeAnswer(answer) === normalizeAnswer(task.expectedAnswer),
    usage, totalTokens: totalTokens(usage), elapsedMs: Math.round(performance.now() - start),
    toolCalls: calls, validRetrieval: retrievalValid, log: `${log}.jsonl`,
  };
  console.log(`${result.passed && retrievalValid ? 'PASS' : 'FAIL'} ${log}: ${result.totalTokens} tokens (input ${usage.input_tokens}, cached ${usage.cached_input_tokens}, output ${usage.output_tokens}).`);
  return result;
}

async function validateBatch(events: ReturnType<typeof parseEvents>, files: string[]): Promise<boolean> {
  const calls = completedToolCalls(events).filter((item) => item?.type !== 'tool_search');
  const call = calls[0];
  if (calls.length !== 1 || call?.type !== 'command_execution' || call.status !== 'completed' || call.exit_code !== 0 || typeof call.aggregated_output !== 'string') return false;
  const normalize = (text: string): string => text.replace(/\r\n/g, '\n').trim();
  const output = normalize(call.aggregated_output);
  const texts = await Promise.all(files.map((file) => readFile(path.join(workspace, file), 'utf8')));
  const diff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  return [...texts, diff].every((text) => output.includes(normalize(text)));
}

function report(): string {
  const sumMode = (mode: Mode): number => measurements.filter((row) => row.mode === mode)
    .reduce((sum, row) => sum + row.totalTokens, 0);
  const withoutTotal = sumMode('without-mcp');
  const withTotal = sumMode('with-mcp');
  const complete = measurements.length === selected.length * repeats * 2
    && measurements.every((row) => row.passed && row.validRetrieval);
  const lines = [
    '# Paired benchmark runs with and without skel-mcp',
    '',
    `CLI ${version}, model ${modelLabel}, sandbox ${sandbox}. Compact ${compact}, direct ${direct}, batch ${batch}. UTC ${new Date().toISOString()}. Repeats per pair ${repeats}.`,
    '',
    complete
      ? `**The benchmark used ${withoutTotal} tokens without MCP and ${withTotal} with MCP. The change was ${withTotal - withoutTotal >= 0 ? '+' : ''}${withTotal - withoutTotal} tokens (${((withTotal / withoutTotal - 1) * 100).toFixed(2)}%). All ${measurements.length} answers and retrieval methods passed.**`
      : 'Only completed pairs with passing checks can be used to evaluate token savings.',
    '',
    'Each run starts a fresh ephemeral session. Both modes use the same model, CLI settings, and prompt. User configuration is skipped.',
    '',
    'Totals sum input_tokens and output_tokens from turn.completed.usage. Input already includes cached tokens and output already includes reasoning tokens. The agent totals include instructions, tool schemas, and history.',
    '',
    'The baseline reads whole files or runs plain git diff. Fix tasks ask for a proposed line of code. Answers are checked against references. The AST cache accelerates parsing.',
    '',
    '| Task | Without MCP | With skel-mcp | Reduction | Check |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  for (const task of selected) {
    const rows = measurements.filter((row) => row.taskId === task.id);
    const without = rows.filter((row) => row.mode === 'without-mcp').reduce((sum, row) => sum + row.totalTokens, 0);
    const withMcp = rows.filter((row) => row.mode === 'with-mcp').reduce((sum, row) => sum + row.totalTokens, 0);
    const valid = rows.length === repeats * 2 && rows.every((row) => row.passed && row.validRetrieval);
    lines.push(`| ${task.title} | ${without} | ${withMcp} | ${valid ? `${((1 - withMcp / without) * 100).toFixed(2)}%` : 'n/a'} | ${valid ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', '| Mode | Input | Cached input included | Output | Total |', '| --- | ---: | ---: | ---: | ---: |');
  for (const mode of ['without-mcp', 'with-mcp'] as const) {
    const rows = measurements.filter((row) => row.mode === mode);
    const sum = (key: keyof Usage): number => rows.reduce((total, row) => total + (row.usage[key] ?? 0), 0);
    lines.push(`| ${mode} | ${sum('input_tokens')} | ${sum('cached_input_tokens')} | ${sum('output_tokens')} | ${rows.reduce((total, row) => total + row.totalTokens, 0)} |`);
  }
  lines.push('', 'The runner alternates mode order across tasks and repeats. Model variation and caching can affect token counts. Raw events and verification details are saved as JSON and JSONL.', '', '[Codex usage documentation](https://learn.chatgpt.com/docs/non-interactive-mode)', '');
  return lines.join('\n');
}

try {
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (let index = 0; index < selected.length; index++) {
      const task = selected[index]!;
      const modes: Mode[] = (index + repeat) % 2 ? ['without-mcp', 'with-mcp'] : ['with-mcp', 'without-mcp'];
      for (const mode of modes) {
        measurements.push(await measure(task, mode, repeat));
        await writeFile(path.join(output, 'results.json'), JSON.stringify({ version, modelLabel, sandbox, compact, direct, batch, serverPath, repeats, measurements }, null, 2));
        await writeFile(path.join(output, 'report.md'), report());
      }
    }
  }
  assert.ok(measurements.every((row) => row.passed && row.validRetrieval), 'Some answers or context retrievals failed. See report.');
  console.log(`Report: ${path.join(output, 'report.md')}`);
} finally {
  assert.ok(path.resolve(scratch).startsWith(path.join(path.resolve(tmpdir()), 'skel-mcp-benchmark-')));
  await rm(scratch, { recursive: true, force: true });
}

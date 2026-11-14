import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}

export interface Event {
  type: string;
  usage?: Usage;
  item?: {
    type: string;
    text?: string;
    command?: string;
    server?: string;
    tool?: string;
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function parseEvents(output: string): Event[] {
  return output.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try {
      return JSON.parse(line) as Event;
    } catch {
      throw new Error(`Invalid CLI JSONL event: ${line.slice(0, 150)}`);
    }
  });
}

export function readUsage(events: Event[]): Usage {
  const completed = events.filter((event) => event.type === 'turn.completed');
  assert.equal(completed.length, 1, 'Expected exactly one completed agent turn.');
  const usage = completed[0]?.usage;
  assert.ok(usage, 'CLI did not report usage.');
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const) {
    assert.ok(Number.isInteger(usage[key]) && usage[key] >= 0, `Invalid ${key}.`);
  }
  assert.ok(usage.cached_input_tokens <= usage.input_tokens, 'Cached input is a subset of input.');
  return usage;
}

export function totalTokens(usage: Usage): number {
  // Cached input is ALREADY included in input; reasoning is included in output.
  return usage.input_tokens + usage.output_tokens;
}

export function normalizeAnswer(answer: string): string {
  return answer.trim().replace(/\s+/g, ' ');
}

export function finalAnswer(events: Event[]): string {
  const messages = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message');
  const text = messages.at(-1)?.item?.text;
  assert.ok(text, 'CLI did not produce a final answer.');
  const decoded = JSON.parse(text) as { answer?: unknown };
  assert.equal(typeof decoded.answer, 'string', 'Expected JSON with an answer string.');
  return decoded.answer as string;
}

export function completedToolCalls(events: Event[]): Event['item'][] {
  return events.filter((event) => event.type === 'item.completed'
    && ['command_execution', 'mcp_tool_call', 'tool_search'].includes(event.item?.type ?? ''))
    .map((event) => event.item);
}

export function validRetrieval(
  events: Event[],
  mode: 'without-mcp' | 'with-mcp',
  expected: { tool: string; arguments: Record<string, unknown> },
  baselineText: string,
): boolean {
  const calls = completedToolCalls(events).filter((item) => item?.type !== 'tool_search');
  if (calls.length !== 1) return false;
  const item = calls[0];
  if (!item || item.status !== 'completed') return false;
  if (mode === 'with-mcp') {
    const result = item.result as { isError?: boolean; is_error?: boolean; content?: unknown[] } | undefined;
    return item.type === 'mcp_tool_call' && item.server === 'skel' && item.tool === expected.tool
      && isDeepStrictEqual(item.arguments, expected.arguments) && !item.error
      && Boolean(result?.content?.length) && !result?.isError && !result?.is_error;
  }
  const normalize = (text: string): string => text.replace(/\r\n/g, '\n').trim();
  return item.type === 'command_execution' && item.exit_code === 0
    && typeof item.aggregated_output === 'string'
    && normalize(baselineText).length > 0
    && normalize(item.aggregated_output).includes(normalize(baselineText));
}

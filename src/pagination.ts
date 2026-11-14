import { createHash } from 'node:crypto';
import { countTokens as count, isWithinTokenLimit } from 'gpt-tokenizer/encoding/o200k_base';

export const DEFAULT_PAGE_TOKENS = 1200;
export const MIN_PAGE_TOKENS = 128;

// Read code containing token-like string literals as ordinary text.
const tokenOptions = { disallowedSpecial: new Set<never>() };

export function countTokens(text: string): number {
  return count(text, tokenOptions);
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Stateless pages tied to the rendered content. A null budget returns the remainder. */
export function paginate(text: string, maxTokens: number | null, cursor?: string): string {
  if (maxTokens !== null && (!Number.isSafeInteger(maxTokens) || maxTokens < MIN_PAGE_TOKENS)) {
    throw new Error(`maxTokens must be null or a safe integer >= ${MIN_PAGE_TOKENS}.`);
  }
  const revision = contentHash(text);
  let start = 0;
  if (cursor !== undefined) {
    const decoded = Buffer.from(cursor, 'base64url');
    const parts = /^([a-f0-9]{16}):(\d+)$/.exec(decoded.toString('utf8'));
    if (!parts || parts[1] !== revision || decoded.toString('base64url') !== cursor) {
      throw new Error('Stale or invalid cursor; restart without cursor.');
    }
    start = Number(parts[2]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= text.length) throw new Error('Invalid cursor offset.');
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) throw new Error('Invalid cursor boundary.');
  }

  const prefix = start ? '[continued]\n' : '';
  const remainder = prefix + text.slice(start);
  if (maxTokens === null) return remainder;
  const fits = (page: string): boolean => isWithinTokenLimit(page, maxTokens, tokenOptions) !== false;
  if (fits(remainder)) return remainder;

  const render = (end: number): string => {
    const next = Buffer.from(`${revision}:${end}`).toString('base64url');
    return prefix + text.slice(start, end) + `\n[truncated next=${next}]`;
  };
  const boundary = (index: number): number =>
    index > start && /[\uDC00-\uDFFF]/.test(text[index] ?? '') ? index - 1 : index;

  let low = start;
  let high = text.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const end = boundary(middle);
    if (end > start && fits(render(end))) low = middle;
    else high = middle - 1;
  }
  let end = boundary(low);
  const newline = text.lastIndexOf('\n', end - 1);
  // Long lines can span pages. Never split a Unicode surrogate pair.
  if (newline >= start) end = newline + 1;
  while (end > start && !fits(render(end))) end = boundary(end - 1);
  if (end <= start) throw new Error('Token budget too small for continuation metadata.');
  return render(end);
}

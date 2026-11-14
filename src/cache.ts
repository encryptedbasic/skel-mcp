import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** Bounded LRU cache, keyed by absolute file path + SHA-256 of the source. */
export class ParseCache<T> {
  private readonly entries = new Map<string, { filePath: string; value: T }>();

  constructor(
    private readonly maxEntries = 128,
    private readonly dispose?: (value: T) => void,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Cache capacity must be a positive integer.');
    }
  }

  private key(filePath: string, content: string): { filePath: string; key: string } {
    const absolutePath = resolve(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    return { filePath: absolutePath, key: `${absolutePath}\0${hash}` };
  }

  get(filePath: string, content: string): T | undefined {
    const { key } = this.key(filePath, content);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(filePath: string, content: string, value: T): void {
    const { filePath: absolutePath, key } = this.key(filePath, content);
    this.remove(key, value);
    this.entries.set(key, { filePath: absolutePath, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
  }

  private remove(key: string, replacement?: T): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.value !== replacement) this.dispose?.(entry.value);
  }

  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

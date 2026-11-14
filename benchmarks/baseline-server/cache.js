import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
/** Bounded LRU cache, keyed by absolute file path + SHA-256 of the source. */
export class ParseCache {
    maxEntries;
    dispose;
    entries = new Map();
    constructor(maxEntries = 128, dispose) {
        this.maxEntries = maxEntries;
        this.dispose = dispose;
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new Error('Cache capacity must be a positive integer.');
        }
    }
    key(filePath, content) {
        const absolutePath = resolve(filePath);
        const hash = createHash('sha256').update(content).digest('hex');
        return { filePath: absolutePath, key: `${absolutePath}\0${hash}` };
    }
    get(filePath, content) {
        const { key } = this.key(filePath, content);
        const entry = this.entries.get(key);
        if (!entry)
            return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }
    set(filePath, content, value) {
        const { filePath: absolutePath, key } = this.key(filePath, content);
        this.remove(key, value);
        this.entries.set(key, { filePath: absolutePath, value });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined)
                this.remove(oldest);
        }
    }
    remove(key, replacement) {
        const entry = this.entries.get(key);
        if (!entry)
            return;
        this.entries.delete(key);
        if (entry.value !== replacement)
            this.dispose?.(entry.value);
    }
    clear() {
        for (const key of this.entries.keys())
            this.remove(key);
    }
    get size() {
        return this.entries.size;
    }
}
//# sourceMappingURL=cache.js.map
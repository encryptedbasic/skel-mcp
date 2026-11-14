/** Bounded LRU cache, keyed by absolute file path + SHA-256 of the source. */
export declare class ParseCache<T> {
    private readonly maxEntries;
    private readonly dispose?;
    private readonly entries;
    constructor(maxEntries?: number, dispose?: ((value: T) => void) | undefined);
    private key;
    get(filePath: string, content: string): T | undefined;
    set(filePath: string, content: string, value: T): void;
    private remove;
    clear(): void;
    get size(): number;
}

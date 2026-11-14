import Parser from 'web-tree-sitter';
type LanguageName = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go';
export interface ParsedFile {
    filePath: string;
    content: string;
    tree: Parser.Tree;
    language: LanguageName;
}
export interface LineRange {
    startLine: number;
    endLine: number;
}
export interface ExtractedSymbol extends LineRange {
    name: string;
    kind: string;
    code: string;
}
export declare function isSupportedFile(filePath: string): boolean;
/** Parse text directly, including historical Git revisions without temporary files. */
export declare function parseSource(filePath: string, content: string): Promise<ParsedFile>;
export declare function parseFile(filePath: string): Promise<ParsedFile>;
export declare function getFileSkeleton(filePath: string): Promise<string>;
export declare function getSymbol(filePath: string, symbolName: string): Promise<string>;
/** Outermost affected definitions avoid repeating methods already included in a class. */
export declare function getEnclosingSymbols(parsed: ParsedFile, ranges: LineRange[]): ExtractedSymbol[];
export {};

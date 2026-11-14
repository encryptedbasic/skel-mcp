/**
 * Summarize ordinary `git diff`: unstaged tracked changes under cwd.
 * Zero-context hunks are used only to select AST nodes; patch text is never returned.
 * For deleted symbols, return their complete code from the index with an explicit label.
 */
export declare function getSmartDiff(cwd?: string): Promise<string>;

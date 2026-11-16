import path from 'node:path';
import { getFileSkeleton, getSymbol, getSymbolReturns, getSymbolSnippet } from './parser.js';
import { getSmartDiff } from './git.js';
import { contentHash, DEFAULT_PAGE_TOKENS, paginate } from './pagination.js';
import { resolveWorkspaceFile } from './source-files.js';

export { countTokens, paginate } from './pagination.js';

export interface ContextRequest {
  op: 'outline' | 'symbol' | 'lines' | 'diff';
  file?: string;
  symbol?: string;
  find?: string;
  detail?: 'signatures' | 'names' | 'full' | 'changes' | 'returns';
  contextLines?: number;
  publicOnly?: boolean;
  imports?: 'referenced' | 'all' | 'none';
  includeTypes?: boolean;
  ifHash?: string;
}

export interface ContextInput {
  file?: string;
  requests: ContextRequest[];
  maxTokens?: number | null;
  cursor?: string;
  versions?: boolean;
  sources?: boolean;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} required`);
  return value;
}

async function requestedFile(request: ContextRequest, root?: string): Promise<string> {
  const file = required(request.file, 'file');
  return root === undefined ? file : resolveWorkspaceFile(file, root);
}

function sectionLabel(index: number, request: ContextRequest, root: string): string {
  const file = request.file;
  let source: string = request.op;
  if (file) {
    const relative = path.relative(root, path.resolve(root, file));
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      const portable = relative.split(path.sep).join('/');
      source = /^[\p{L}\p{N}_.\-/]+$/u.test(portable) ? portable : JSON.stringify(portable);
    }
  }
  const symbol = request.symbol;
  return `[${index}] ${source}${symbol ? '#' + (/^[\p{L}\p{N}_.#$-]+$/u.test(symbol) ? symbol : JSON.stringify(symbol)) : ''}`;
}

async function retrieve(request: ContextRequest, root?: string): Promise<string> {
  switch (request.op) {
    case 'outline':
      return getFileSkeleton(await requestedFile(request, root), {
        symbolName: request.symbol,
        detail: request.detail === 'names' ? 'names' : 'signatures',
        publicOnly: request.publicOnly,
        includeImports: request.imports === 'all',
      });
    case 'symbol':
      if (request.detail === 'returns') {
        return getSymbolReturns(await requestedFile(request, root), required(request.symbol, 'symbol'));
      }
      return getSymbol(await requestedFile(request, root), required(request.symbol, 'symbol'), {
        imports: request.imports ?? 'referenced',
        includeTypes: request.includeTypes ?? true,
        root,
      });
    case 'lines':
      return getSymbolSnippet(await requestedFile(request, root), required(request.symbol, 'symbol'), {
        find: required(request.find, 'find'), contextLines: request.contextLines,
      });
    case 'diff':
      return getSmartDiff(root, {
        view: request.detail === 'full' ? 'full' : 'changes', file: request.file, symbol: request.symbol,
      });
    default:
      throw new Error('Unknown op');
  }
}

/** Batch unrelated AST reads into one model/tool round trip, without implicit state. */
export async function getContext(input: ContextInput, root?: string): Promise<string> {
  if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > 20) {
    throw new Error('requests must contain 1..20 items');
  }
  const sections: string[] = [];
  for (let index = 0; index < input.requests.length; index++) {
    const item = input.requests[index]!;
    const request = item.file === undefined && input.file !== undefined ? { ...item, file: input.file } : item;
    const label = input.sources ? sectionLabel(index, request, root ?? process.cwd()) : `[${index}]`;
    try {
      const body = await retrieve(request, root);
      const revision = input.versions || request.ifHash ? contentHash(body) : undefined;
      const version = revision ? ` h=${revision}` : '';
      sections.push(`${label}${version}\n${revision && request.ifHash === revision ? 'unchanged' : body}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sections.push(`${label} ERROR ${input.sources ? message.replace(/\r?\n|\r/g, ' ') : message}`);
    }
  }
  const budget = input.maxTokens === undefined ? DEFAULT_PAGE_TOKENS : input.maxTokens;
  return paginate(sections.join('\n'), budget, input.cursor);
}

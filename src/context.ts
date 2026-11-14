import { getFileSkeleton, getSymbol, getSymbolSnippet } from './parser.js';
import { getSmartDiff } from './git.js';
import { contentHash, DEFAULT_PAGE_TOKENS, paginate } from './pagination.js';
import { resolveWorkspaceFile } from './source-files.js';

export { countTokens, paginate } from './pagination.js';

export interface ContextRequest {
  op: 'outline' | 'symbol' | 'lines' | 'diff';
  file?: string;
  symbol?: string;
  find?: string;
  detail?: 'signatures' | 'names' | 'full' | 'changes';
  publicOnly?: boolean;
  imports?: 'referenced' | 'all' | 'none';
  includeTypes?: boolean;
  ifHash?: string;
}

export interface ContextInput {
  requests: ContextRequest[];
  maxTokens?: number | null;
  cursor?: string;
  versions?: boolean;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} required`);
  return value;
}

async function requestedFile(request: ContextRequest, root?: string): Promise<string> {
  const file = required(request.file, 'file');
  return root === undefined ? file : resolveWorkspaceFile(file, root);
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
      return getSymbol(await requestedFile(request, root), required(request.symbol, 'symbol'), {
        imports: request.imports ?? 'referenced',
        includeTypes: request.includeTypes ?? true,
      });
    case 'lines':
      return getSymbolSnippet(await requestedFile(request, root), required(request.symbol, 'symbol'), {
        find: required(request.find, 'find'), contextLines: 1,
      });
    case 'diff':
      return getSmartDiff(root, { view: request.detail === 'full' ? 'full' : 'changes' });
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
    const request = input.requests[index]!;
    const label = `[${index}]`;
    try {
      const body = await retrieve(request, root);
      const revision = contentHash(body);
      const version = input.versions || request.ifHash ? ` h=${revision}` : '';
      sections.push(`${label}${version}\n${request.ifHash === revision ? 'unchanged' : body}`);
    } catch (error) {
      sections.push(`${label} ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const budget = input.maxTokens === undefined ? DEFAULT_PAGE_TOKENS : input.maxTokens;
  return paginate(sections.join('\n'), budget, input.cursor);
}

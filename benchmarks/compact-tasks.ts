import type { ContextRequest } from '../src/context.js';

/** Same task answers; ask only for the AST evidence the task actually needs. */
export const compactRequests: Record<string, ContextRequest> = {
  'typescript-api': { op: 'outline', file: 'catalog.ts', symbol: 'Catalog', detail: 'names', publicOnly: true },
  'javascript-total': { op: 'symbol', file: 'cart.js', symbol: 'getCartTotal' },
  'python-boundary': { op: 'lines', file: 'paging.py', symbol: 'page_bounds', find: 'end =' },
  'go-boundary': { op: 'lines', file: 'shipping.go', symbol: 'Order.QualifiesForFreeShipping', find: 'return' },
  'git-review': { op: 'diff' },
  'tiny-file': { op: 'outline', file: 'tiny.ts', detail: 'names' },
};

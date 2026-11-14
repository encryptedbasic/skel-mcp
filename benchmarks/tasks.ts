import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export interface BenchmarkTask {
  id: string;
  title: string;
  instruction: string;
  expectedAnswer: string;
  retrieval: {
    tool: 'get_file_skeleton' | 'get_symbol' | 'get_smart_diff';
    arguments: Record<string, string>;
  };
  baseline: { kind: 'file'; filePath: string } | { kind: 'git-diff' };
}

export const tasks: BenchmarkTask[] = [
  {
    id: 'typescript-api',
    title: 'TypeScript public class methods',
    instruction: 'List the public method names of the Catalog class in catalog.ts. Exclude the constructor, private methods, and functions outside the class. In the answer field, list the names in alphabetical order separated by commas without spaces.',
    expectedAnswer: 'add,find,list,remove',
    retrieval: { tool: 'get_file_skeleton', arguments: { filePath: 'catalog.ts' } },
    baseline: { kind: 'file', filePath: 'catalog.ts' },
  },
  {
    id: 'javascript-total',
    title: 'JavaScript function result',
    instruction: 'Calculate the result of getCartTotal([{ price: 19.9, quantity: 2 }, { price: 5, quantity: 3 }], 10) in cart.js without running the code. Put only the number in the answer field, using a period as the decimal separator.',
    expectedAnswer: '49.32',
    retrieval: { tool: 'get_symbol', arguments: { filePath: 'cart.js', symbolName: 'getCartTotal' } },
    baseline: { kind: 'file', filePath: 'cart.js' },
  },
  {
    id: 'python-boundary',
    title: 'Python slice boundary',
    instruction: 'In paging.py, page_bounds should return a half-open range [start, end) containing exactly page_size elements when enough elements remain. Fix the off-by-one error in the assignment to end. Return only the complete corrected assignment line in the answer field, without indentation or file edits.',
    expectedAnswer: 'end = min(total, start + page_size)',
    retrieval: { tool: 'get_symbol', arguments: { filePath: 'paging.py', symbolName: 'page_bounds' } },
    baseline: { kind: 'file', filePath: 'paging.py' },
  },
  {
    id: 'go-boundary',
    title: 'Go free-shipping threshold',
    instruction: 'In shipping.go, free shipping should apply when the order subtotal equals or exceeds the minimum. Fix the comparison in Order.QualifiesForFreeShipping. Return only the complete corrected return line in the answer field, without indentation or file edits.',
    expectedAnswer: 'return order.SubtotalCents >= minimumCents',
    retrieval: { tool: 'get_symbol', arguments: { filePath: 'shipping.go', symbolName: 'Order.QualifiesForFreeShipping' } },
    baseline: { kind: 'file', filePath: 'shipping.go' },
  },
  {
    id: 'git-review',
    title: 'Git discount-threshold review',
    instruction: 'Review the unstaged change in pricing.ts. For subtotal = 150, determine the discount rate in calculateTotal after the change. Put only the number in the answer field. The working-tree diff contains everything needed for this task.',
    expectedAnswer: '0',
    retrieval: { tool: 'get_smart_diff', arguments: {} },
    baseline: { kind: 'git-diff' },
  },
  {
    id: 'tiny-file',
    title: 'Function name in a small TypeScript file',
    instruction: 'Find the name of the only exported function in tiny.ts. Put only that name in the answer field.',
    expectedAnswer: 'isEven',
    retrieval: { tool: 'get_file_skeleton', arguments: { filePath: 'tiny.ts' } },
    baseline: { kind: 'file', filePath: 'tiny.ts' },
  },
];

const execFileAsync = promisify(execFile);
const fixtureFiles = ['catalog.ts', 'cart.js', 'paging.py', 'shipping.go', 'pricing.ts', 'tiny.ts'];

/** Create a disposable fixture repository; expected answers stay outside model cwd. */
export async function prepareFixtures(destination: string): Promise<void> {
  const fixtureDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));
  for (const fileName of fixtureFiles) {
    await copyFile(path.join(fixtureDirectory, fileName), path.join(destination, fileName));
  }
  const git = async (...args: string[]): Promise<void> => {
    await execFileAsync('git', args, { cwd: destination, windowsHide: true });
  };
  await git('init', '--quiet');
  await git('config', 'core.autocrlf', 'false');
  await git('add', '--', ...fixtureFiles);
  const pricingPath = path.join(destination, 'pricing.ts');
  const baseline = await readFile(pricingPath, 'utf8');
  const needle = 'const discountRate = subtotal >= 100 ? 0.1 : 0;';
  if (!baseline.includes(needle)) throw new Error('Pricing benchmark baseline no longer matches its known change.');
  await writeFile(pricingPath, baseline.replace(needle, 'const discountRate = subtotal >= 200 ? 0.1 : 0;'), 'utf8');
}

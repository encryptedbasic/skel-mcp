import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { getFileSkeleton, getSymbol, getSymbolSnippet } from '../src/parser.js';

const directory = await mkdtemp(path.join(tmpdir(), 'skel-mcp-compact-parser-'));
after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'skel-mcp-compact-parser-')));
  await rm(directory, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const filePath = path.join(directory, name);
  await writeFile(filePath, content);
  return filePath;
}

test('focused public name outline omits private members, constructors, nested implementations and unrelated symbols', async () => {
  const filePath = await fixture('public.ts', `import unused from 'unused';
interface Item { id: string }
export class Catalog {
  private count = 0;
  constructor() { this.count++; }
  public add(item: Item): void { function implementationDetail() {} this.count++; }
  find(id: string): Item | undefined { return undefined; }
  private hidden() { function shouldStayHidden() {} }
  protected reserved() { return 1; }
  #secret() { return 2; }
}
function unrelated() { return 3; }
`);
  const compact = await getFileSkeleton(filePath, { symbolName: 'Catalog', detail: 'names', publicOnly: true });
  assert.equal(compact, 'class Catalog\nmethod Catalog.add\nmethod Catalog.find');
  assert.doesNotMatch(compact, /import|Item|count|constructor|hidden|reserved|secret|implementationDetail|unrelated/);
  const signatures = await getFileSkeleton(filePath, { symbolName: 'Catalog', publicOnly: true, includeImports: false });
  assert.match(signatures, /class Catalog/);
  assert.match(signatures, /add\(item: Item\): void/);
  assert.match(signatures, /find\(id: string\): Item \| undefined/);
  assert.doesNotMatch(signatures, /constructor|hidden|reserved|secret|private count|import unused|function unrelated/);
  const complete = await getFileSkeleton(filePath);
  assert.match(complete, /interface Item/);
  assert.match(complete, /private hidden/);
  assert.match(complete, /import unused/);
});

test('focused arrow signature keeps its declaration while imports can be omitted', async () => {
  const filePath = await fixture('arrow.js', `import unused from 'unused';
export const secret = 'DO_NOT_RETURN', transform = value => value + 'BODY';
function neighbor() { return 'UNRELATED'; }
`);
  const skeleton = await getFileSkeleton(filePath, { symbolName: 'transform', includeImports: false });
  assert.equal(skeleton, 'export const transform = value => { ... };');
  assert.equal(await getFileSkeleton(filePath, { symbolName: 'transform', detail: 'names' }), 'function transform');
  assert.doesNotMatch(skeleton, /DO_NOT_RETURN|BODY|UNRELATED|import/);
});

test('public-only focused outlines inherit field visibility for arrows and class expressions', async () => {
  const filePath = await fixture('field-visibility.ts', `export class FieldApi {
  public run = () => 'PUBLIC';
  private secret = () => 'PRIVATE';
  protected reserved = () => 'PROTECTED';
  #hidden = () => 'HASH_PRIVATE';
  private HiddenClass = class { exposed() { return 'NESTED_PRIVATE'; } };
  public VisibleClass = class { exposed() { return 'NESTED_PUBLIC'; } };
}
`);
  const names = await getFileSkeleton(filePath, { symbolName: 'FieldApi', detail: 'names', publicOnly: true });
  assert.match(names, /method FieldApi\.run/);
  assert.match(names, /class FieldApi\.VisibleClass/);
  assert.match(names, /method FieldApi\.VisibleClass\.exposed/);
  assert.doesNotMatch(names, /secret|reserved|hidden|HiddenClass/);
  const signatures = await getFileSkeleton(filePath, { symbolName: 'FieldApi', publicOnly: true, includeImports: false });
  assert.match(signatures, /public run/);
  assert.doesNotMatch(signatures, /secret|reserved|hidden|HiddenClass/);
  for (const symbolName of ['FieldApi.secret', 'FieldApi.reserved', 'FieldApi.#hidden', 'FieldApi.HiddenClass', 'FieldApi.HiddenClass.exposed']) {
    const focusedNames = await getFileSkeleton(filePath, { symbolName, detail: 'names', publicOnly: true });
    assert.equal(focusedNames, '(No matching symbols.)', symbolName);
    const focusedSignatures = await getFileSkeleton(filePath, { symbolName, publicOnly: true, includeImports: false });
    assert.equal(focusedSignatures, '(No imports, type declarations, functions or classes found.)', symbolName);
  }
  const unfiltered = await getFileSkeleton(filePath, { symbolName: 'FieldApi', detail: 'names' });
  assert.match(unfiltered, /FieldApi\.secret/);
  assert.match(unfiltered, /FieldApi\.#hidden/);
  assert.match(unfiltered, /FieldApi\.HiddenClass\.exposed/);
});

test('omitting CommonJS imports still retains functions declared alongside require bindings', async () => {
  const filePath = await fixture('commonjs.cjs', `const fs = require('fs'), run = name => fs.readFileSync(name, 'HIDDEN_BODY');\n`);
  assert.doesNotMatch(await getFileSkeleton(filePath), /HIDDEN_BODY/);
  const withoutImports = await getFileSkeleton(filePath, { includeImports: false });
  assert.match(withoutImports, /const run = name => \{ \.\.\. \}/);
  assert.doesNotMatch(withoutImports, /require|HIDDEN_BODY/);
});

test('referenced TS imports use local aliases and preserve side-effect and namespace imports', async () => {
  const filePath = await fixture('imports.ts', `import { parse as decode } from 'codec';
import { unused } from 'other';
import DefaultUnused from 'default';
import * as globalNamespace from 'namespace';
import 'side-effect';
export function selected(value: string) { return decode(value); }
`);
  const selected = await getSymbol(filePath, 'selected', { imports: 'referenced' });
  assert.match(selected, /parse as decode/);
  assert.match(selected, /namespace/);
  assert.match(selected, /import 'side-effect'/);
  assert.doesNotMatch(selected, /from 'other'|DefaultUnused/);
  assert.match(await getSymbol(filePath, 'selected'), /DefaultUnused/);
  assert.doesNotMatch(await getSymbol(filePath, 'selected', { imports: 'none' }), /import/);
});

test('referenced Python imports preserve aliases, wildcard and future features conservatively', async () => {
  const filePath = await fixture('imports.py', `from __future__ import annotations
from codec import parse as decode
from other import unused
from plugins import *
import json as jsonlib
import pathlib
def selected(value: str):
    return decode(jsonlib.dumps(value))
`);
  const selected = await getSymbol(filePath, 'selected', { imports: 'referenced' });
  assert.match(selected, /from __future__ import annotations/);
  assert.match(selected, /parse as decode/);
  assert.match(selected, /from plugins import \*/);
  assert.match(selected, /import json as jsonlib/);
  assert.doesNotMatch(selected, /from other|import pathlib/);
});

test('referenced Go imports filter explicit aliases but retain unknown implicit packages and side effects', async () => {
  const filePath = await fixture('imports.go', `package sample
import used "example.com/used"
import unused "example.com/unused"
import "fmt"
import _ "example.com/side"
func Selected() string { return used.Render() }
`);
  const selected = await getSymbol(filePath, 'Selected', { imports: 'referenced' });
  assert.match(selected, /import used/);
  assert.match(selected, /import "fmt"/);
  assert.match(selected, /import _ "example.com\/side"/);
  assert.doesNotMatch(selected, /import unused/);
});

test('AST-scoped snippets retain source line numbers and explicitly mark omitted code', async () => {
  const filePath = await fixture('snippet.py', '# Привет 🌲\r\n\r\ndef page_bounds(total, page, size):\r\n    start = page * size\r\n    end = min(total, start + size - 1)\r\n    return start, end\r\n\r\ndef unrelated():\r\n    end = "UNRELATED_BODY"\r\n    return end\r\n');
  const snippet = await getSymbolSnippet(filePath, 'page_bounds', { find: 'end =', contextLines: 0 });
  assert.equal(snippet, 'snippet page_bounds\n...\n5:     end = min(total, start + size - 1)\n...');
  assert.doesNotMatch(snippet, /UNRELATED_BODY|return start|def unrelated/);
  const expanded = await getSymbolSnippet(filePath, 'page_bounds', { find: 'end', contextLines: 1 });
  assert.equal(expanded.match(/5: /g)?.length, 1, 'overlapping contexts must merge');
  assert.match(expanded, /4:     start = page \* size/);
  assert.match(expanded, /6:     return start, end/);
  await assert.rejects(getSymbolSnippet(filePath, 'page_bounds', { find: 'UNRELATED_BODY' }), /No match/);
  await assert.rejects(getSymbolSnippet(filePath, 'missing', { find: 'end' }), /not found/);
  await assert.rejects(getSymbolSnippet(filePath, 'page_bounds', { find: '' }), /must not be empty/);
  await assert.rejects(getSymbolSnippet(filePath, 'page_bounds', { find: 'end', contextLines: 6 }), /0 to 5/);
});

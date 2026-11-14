import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ParseCache } from '../src/cache.js';
import { getFileSkeleton, getSymbol, parseFile } from '../src/parser.js';

const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'skel-mcp-parser-test-'));
after(async () => {
  assert.ok(fixtureDirectory.startsWith(path.join(tmpdir(), 'skel-mcp-parser-test-')));
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const filePath = path.join(fixtureDirectory, name);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

test('TypeScript skeleton keeps imports, types and signatures without implementations', async () => {
  const filePath = await fixture('typescript.ts', `import { join } from 'node:path';
export interface Person { name: string }
export type Kind = 'one' | 'two';
export async function greet(person: Person): Promise<string> {
  return join('TS_FUNCTION_BODY', person.name);
}
export const twice = (value: number): number => value * 287;
export class Greeter {
  constructor(private prefix: string) { console.log('TS_CONSTRUCTOR_BODY'); }
  welcome(person: Person): string { return this.prefix + 'TS_METHOD_BODY' + person.name; }
}
`);
  const skeleton = await getFileSkeleton(filePath);
  assert.match(skeleton, /import \{ join \} from 'node:path'/);
  assert.match(skeleton, /interface Person/);
  assert.match(skeleton, /name: string/);
  assert.match(skeleton, /type Kind = 'one' \| 'two'/);
  assert.match(skeleton, /async function greet\(person: Person\): Promise<string>/);
  assert.match(skeleton, /twice.*value: number/);
  assert.match(skeleton, /class Greeter/);
  assert.match(skeleton, /welcome\(person: Person\): string/);
  assert.match(skeleton, /\{ \.\.\. \}/);
  assert.doesNotMatch(skeleton, /TS_FUNCTION_BODY|TS_CONSTRUCTOR_BODY|TS_METHOD_BODY|value \* 287/);
});

test('JavaScript skeleton hides class methods and arrow function bodies', async () => {
  const filePath = await fixture('javascript.mjs', `import fs from 'node:fs';
export function load(name) { return fs.readFileSync(name, 'JS_FUNCTION_BODY'); }
export const transform = value => ({ marker: 'JS_ARROW_BODY', value });
class Worker {
  run(task) { return task + 'JS_METHOD_BODY'; }
}
`);
  const skeleton = await getFileSkeleton(filePath);
  assert.match(skeleton, /import fs from 'node:fs'/);
  assert.match(skeleton, /function load\(name\)/);
  assert.match(skeleton, /transform.*value/);
  assert.match(skeleton, /class Worker/);
  assert.match(skeleton, /run\(task\)/);
  assert.doesNotMatch(skeleton, /JS_FUNCTION_BODY|JS_ARROW_BODY|JS_METHOD_BODY/);
});

test('Python skeleton keeps imports and nested method signatures', async () => {
  const filePath = await fixture('python.py', `from pathlib import Path
import json

def read_name(file: Path) -> str:
    return json.loads(file.read_text())['PY_FUNCTION_BODY']

class Reader:
    def run(self, file: Path) -> str:
        return 'PY_METHOD_BODY'

    async def fetch(self, url: str) -> str:
        return 'PY_ASYNC_BODY'
`);
  const skeleton = await getFileSkeleton(filePath);
  assert.match(skeleton, /from pathlib import Path/);
  assert.match(skeleton, /import json/);
  assert.match(skeleton, /def read_name\(file: Path\) -> str/);
  assert.match(skeleton, /class Reader/);
  assert.match(skeleton, /def run\(self, file: Path\) -> str/);
  assert.match(skeleton, /async def fetch\(self, url: str\) -> str/);
  assert.doesNotMatch(skeleton, /PY_FUNCTION_BODY|PY_METHOD_BODY|PY_ASYNC_BODY/);
});

test('Python class skeleton omits docstrings and executable class statements', async () => {
  const filePath = await fixture('python-class.py', `class Reporter:
    """PY_CLASS_DOCSTRING_SECRET"""
    secret = 'PY_CLASS_ASSIGNMENT_SECRET'
    print('PY_CLASS_STATEMENT_SECRET')

    def report(self, title: str) -> str:
        return 'PY_CLASS_METHOD_SECRET' + title
`);
  const skeleton = await getFileSkeleton(filePath);
  assert.match(skeleton, /class Reporter:/);
  assert.match(skeleton, /def report\(self, title: str\) -> str:\s*\.\.\./);
  assert.doesNotMatch(skeleton, /PY_CLASS_DOCSTRING_SECRET|PY_CLASS_ASSIGNMENT_SECRET|PY_CLASS_STATEMENT_SECRET|PY_CLASS_METHOD_SECRET/);
});

test('mixed exported declarations retain only function signatures', async () => {
  const filePath = await fixture('mixed-exports.ts', `export const secret = 'EXPORTED_SECRET_VALUE', target = (name: string): string => 'ARROW_SECRET_BODY' + name;
`);
  const skeleton = await getFileSkeleton(filePath);
  assert.match(skeleton, /export const target/);
  assert.match(skeleton, /name: string/);
  assert.doesNotMatch(skeleton, /EXPORTED_SECRET_VALUE|ARROW_SECRET_BODY|\bsecret\s*=/);
});

test('Go skeleton keeps package, imports, structs, interfaces and receiver signatures', async () => {
  const filePath = await fixture('golang.go', `package sample

import "fmt"

type Person struct { Name string }
type Runner interface { Run(string) string }

func Greet(person Person) string {
    return fmt.Sprintf("GO_FUNCTION_BODY %s", person.Name)
}

func (person Person) Run(value string) string {
    return "GO_METHOD_BODY" + value
}
`);
  const skeleton = await getFileSkeleton(filePath);
  assert.match(skeleton, /package sample/);
  assert.match(skeleton, /import "fmt"/);
  assert.match(skeleton, /type Person struct/);
  assert.match(skeleton, /Name string/);
  assert.match(skeleton, /type Runner interface/);
  assert.match(skeleton, /func Greet\(person Person\) string/);
  assert.match(skeleton, /func \(person Person\) Run\(value string\) string/);
  assert.doesNotMatch(skeleton, /GO_FUNCTION_BODY|GO_METHOD_BODY/);
  const symbol = await getSymbol(filePath, 'Run');
  assert.match(symbol, /import "fmt"/);
  assert.match(symbol, /GO_METHOD_BODY/);
  assert.doesNotMatch(symbol, /GO_FUNCTION_BODY/);
});

test('TSX and JSX functions retain signatures while hiding JSX implementations', async () => {
  const tsx = await fixture('component.tsx', `import React from 'react';
interface Props { title: string }
export function Panel({ title }: Props) { return <section data-marker="TSX_BODY">{title}</section>; }
`);
  const jsx = await fixture('component.jsx', `import React from 'react';
export const Button = ({ title }) => <button data-marker="JSX_BODY">{title}</button>;
`);
  const tsxSkeleton = await getFileSkeleton(tsx);
  assert.match(tsxSkeleton, /interface Props/);
  assert.match(tsxSkeleton, /function Panel/);
  assert.doesNotMatch(tsxSkeleton, /TSX_BODY|<section/);
  const jsxSkeleton = await getFileSkeleton(jsx);
  assert.match(jsxSkeleton, /Button/);
  assert.doesNotMatch(jsxSkeleton, /JSX_BODY|<button/);
  assert.match(await getSymbol(tsx, 'Panel'), /TSX_BODY/);
  assert.match(await getSymbol(jsx, 'Button'), /JSX_BODY/);
});

test('getSymbol returns complete named functions, arrows, methods and classes with imports', async () => {
  const filePath = await fixture('symbols.ts', `import { join } from 'node:path';
const irrelevant = 'UNRELATED_TOP_LEVEL';
export function target(name: string): string {
  return join('FULL_FUNCTION_BODY', name);
}
export const arrowTarget = (value: number) => value + 991;
export class Service {
  methodTarget(): string { return 'FULL_METHOD_BODY'; }
}
function unrelated(): string { return 'UNRELATED_FUNCTION'; }
`);
  const fn = await getSymbol(filePath, 'target');
  assert.match(fn, /import \{ join \} from 'node:path'/);
  assert.match(fn, /FULL_FUNCTION_BODY/);
  assert.doesNotMatch(fn, /UNRELATED_TOP_LEVEL|UNRELATED_FUNCTION|FULL_METHOD_BODY/);

  const arrow = await getSymbol(filePath, 'arrowTarget');
  assert.match(arrow, /value \+ 991/);
  const method = await getSymbol(filePath, 'methodTarget');
  assert.match(method, /FULL_METHOD_BODY/);
  const cls = await getSymbol(filePath, 'Service');
  assert.match(cls, /class Service/);
  assert.match(cls, /FULL_METHOD_BODY/);
});

test('getSymbol preserves Python decorators, imports and full Unicode source', async () => {
  const filePath = await fixture('unicode.py', `from functools import lru_cache
# Привет 🌲 — Unicode before the symbol
@lru_cache(maxsize=4)
def привет(имя: str) -> str:
    return 'Здравствуйте 🌍 ' + имя

def neighbor():
    return 'UNRELATED_PYTHON_BODY'
`);
  const symbol = await getSymbol(filePath, 'привет');
  assert.match(symbol, /from functools import lru_cache/);
  assert.match(symbol, /@lru_cache\(maxsize=4\)/);
  assert.match(symbol, /def привет\(имя: str\) -> str:/);
  assert.match(symbol, /Здравствуйте 🌍/);
  assert.doesNotMatch(symbol, /UNRELATED_PYTHON_BODY/);
});

test('unchanged content reuses parsed results and edits invalidate the content hash', async () => {
  const filePath = await fixture('cache.ts', `export function cached() { return 'VERSION_ONE'; }\n`);
  const first = await parseFile(filePath);
  assert.strictEqual(await parseFile(filePath), first);
  await writeFile(filePath, `export function cached() { return 'VERSION_TWO'; }\n`, 'utf8');
  const second = await parseFile(filePath);
  assert.notStrictEqual(second, first);
  assert.equal(second.content, await readFile(filePath, 'utf8'));
  assert.match(await getSymbol(filePath, 'cached'), /VERSION_TWO/);
});

test('ParseCache keys contain both path and content', () => {
  const cache = new ParseCache<object>();
  const value = {};
  cache.set('first.ts', 'same content', value);
  assert.strictEqual(cache.get('first.ts', 'same content'), value);
  assert.equal(cache.get('first.ts', 'changed content'), undefined);
  assert.equal(cache.get('second.ts', 'same content'), undefined);
  cache.clear();
  assert.equal(cache.get('first.ts', 'same content'), undefined);
});

test('bounded cache keeps recently used entries and disposes only removed values', () => {
  const disposed: string[] = [];
  const cache = new ParseCache<{ id: string }>(2, ({ id }) => disposed.push(id));
  const first = { id: 'first' };
  const second = { id: 'second' };
  const third = { id: 'third' };
  cache.set('one.ts', 'one', first);
  cache.set('two.ts', 'two', second);
  assert.strictEqual(cache.get('one.ts', 'one'), first);
  cache.set('three.ts', 'three', third);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('two.ts', 'two'), undefined);
  assert.strictEqual(cache.get('one.ts', 'one'), first);
  assert.deepEqual(disposed, ['second']);
  cache.set('one.ts', 'one', first);
  assert.deepEqual(disposed, ['second']);
  cache.set('one.ts', 'one', { id: 'replacement' });
  assert.deepEqual(disposed, ['second', 'first']);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.deepEqual(disposed.sort(), ['second', 'first', 'third', 'replacement'].sort());
});

test('unsupported extensions, missing files and missing symbols fail clearly', async () => {
  const unsupported = await fixture('unsupported.txt', 'plain text');
  await assert.rejects(getFileSkeleton(unsupported), /unsupported|support|extension/i);
  await assert.rejects(getFileSkeleton(path.join(fixtureDirectory, 'missing.ts')), /ENOENT|not found|exist/i);
  const supported = await fixture('missing-symbol.js', 'function available() { return 1; }\n');
  await assert.rejects(getSymbol(supported, 'missing'), /missing|not found/i);
});

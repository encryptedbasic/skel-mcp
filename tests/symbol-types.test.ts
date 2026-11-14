import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { getSymbol } from '../src/parser.js';

const testsDirectory = await realpath(path.join(process.cwd(), 'tests'));
const directory = await mkdtemp(path.join(testsDirectory, '.skel-symbol-types-'));
after(async () => {
  const target = await realpath(directory);
  assert.ok(target.startsWith(path.join(testsDirectory, '.skel-symbol-types-')));
  await rm(target, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const file = path.join(directory, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

const linked = { includeTypes: true, imports: 'referenced' } as const;

test('TypeScript symbol includes a cyclic local type closure and imports used by those types', async () => {
  const file = await fixture('local.ts', `import type { Meta as Header } from 'metadata';
import type { UnusedImport } from 'unused';
import 'register';
interface Base { header: Header; }
export interface Item extends Base { next?: Wrapper; }
type Wrapper = { item: Item; };
type Unrelated = { data: UnusedImport; };
interface Shadow { notReferenced: boolean; }
function unrelated() { return 'IGNORE_BODY'; }
export function selected<Shadow>(arg: Wrapper, shadow: Shadow): Item {
  return arg.item;
}
`);
  const result = await getSymbol(file, 'selected', linked);
  assert.match(result, /Meta as Header/);
  assert.match(result, /import 'register'/);
  assert.match(result, /interface Base \{ header: Header/);
  assert.match(result, /export interface Item extends Base/);
  assert.match(result, /type Wrapper = \{ item: Item/);
  assert.match(result, /return arg\.item/);
  assert.equal(result.match(/interface Item/g)?.length, 1);
  assert.doesNotMatch(result, /UnusedImport|Unrelated|interface Shadow|IGNORE_BODY/);
  const legacy = await getSymbol(file, 'selected', { imports: 'referenced' });
  assert.doesNotMatch(legacy, /interface Base|interface Item|type Wrapper|Meta as Header/);
  const withoutImports = await getSymbol(file, 'selected', { includeTypes: true, imports: 'none' });
  assert.match(withoutImports, /interface Base/);
  assert.doesNotMatch(withoutImports, /import|metadata/);
});

test('relative TypeScript imports resolve one hop with aliases and file provenance', async () => {
  await fixture('deps/deep.ts', 'export interface Deep { LEAVE_AT_ONE_HOP: true; }');
  await fixture('deps/model.ts', `import { Deep } from './deep.js';
import { MissingUnused } from './missing.js';
interface Details { deep: Deep; }
interface Data { details: Details; }
export type { Data as PublicData };
export default interface Model { fields: Data; }
export interface Absent { UNUSED_EXPORT: boolean; }
export function ignore() { return 'IGNORE_FROM_MODULE'; }
`);
  const file = await fixture('consumer.ts', `import type DefaultModel, { PublicData as Payload } from './deps/model.js';
import type * as Names from './deps/model';
import type { Missing } from './missing.js';
interface Model { NOT_THE_IMPORTED_MODEL: true; }
export function selected(p: Payload): DefaultModel | Names.PublicData | Missing { return p; }
`);
  const result = await getSymbol(file, 'selected', linked);
  assert.match(result, /import type DefaultModel, \{ PublicData as Payload \}/);
  assert.match(result, /import type \* as Names/);
  assert.match(result, /import type \{ Missing \} from '\.\/missing\.js'/);
  assert.match(result, /\/\/ .*\/deps\/model\.ts/);
  assert.match(result, /import \{ Deep \} from '\.\/deep\.js'/);
  assert.match(result, /interface Details \{ deep: Deep/);
  assert.match(result, /interface Data \{ details: Details/);
  assert.match(result, /export default interface Model/);
  assert.doesNotMatch(result, /MissingUnused|UNUSED_EXPORT|IGNORE_FROM_MODULE|NOT_THE_IMPORTED_MODEL|LEAVE_AT_ONE_HOP/);
  assert.equal(result.match(/interface Data/g)?.length, 1);
});

test('JavaScript constructor reference resolves a relative class signature without its bodies', async () => {
  await fixture('schema/class.js', `export class Item {
  method() { return 'IGNORE_CLASS_BODY'; }
}
export class Unrelated {}
`);
  const file = await fixture('create.mjs', `import { Item as Entry } from './schema/class.js';
export function create() { return new Entry(); }
`);
  const result = await getSymbol(file, 'create', linked);
  assert.match(result, /import \{ Item as Entry \}/);
  assert.match(result, /export class Item/);
  assert.match(result, /method\(\) \{ \.\.\. \}/);
  assert.match(result, /return new Entry\(\)/);
  assert.doesNotMatch(result, /IGNORE_CLASS_BODY|class Unrelated/);
});

test('unresolved, ambiguous and node_modules relative imports retain their original declarations', async () => {
  await fixture('ambiguous.ts', 'export interface Data { SOURCE_TS: true }');
  await fixture('ambiguous.js', 'export class Data { SOURCE_JS() {} }');
  await fixture('node_modules/package/types.ts', 'export interface Vendor { VENDOR_SOURCE: true }');
  const file = await fixture('uncertain.ts', `import type { Data } from './ambiguous.js';
import type { Vendor } from './node_modules/package/types';
export function take(input: Data): Vendor { return input as Vendor; }
`);
  const result = await getSymbol(file, 'take', linked);
  assert.match(result, /from '\.\/ambiguous\.js'/);
  assert.match(result, /from '\.\/node_modules\/package\/types'/);
  assert.doesNotMatch(result, /SOURCE_TS|SOURCE_JS|VENDOR_SOURCE/);
});

test('Go method returns only referenced grouped types and imports used by their fields', async () => {
  const file = await fixture('model.go', `package model
import wire "example.org/wire"
import unused "example.org/unused"
type (
    Envelope struct { Next *Envelope; Header wire.Header }
    Alias = Envelope
    Payload struct { Envelope; Data Alias }
    Label string
    Shadow bool
    Unused struct { Field unused.Data }
)
func (value *Payload) Read(input Alias) *Payload { return value }
func Copy[Shadow any](value Shadow) Shadow { return value }
`);
  const result = await getSymbol(file, 'Payload.Read', linked);
  assert.match(result, /import wire "example\.org\/wire"/);
  assert.match(result, /type Envelope struct \{ Next \*Envelope; Header wire\.Header/);
  assert.match(result, /type Alias = Envelope/);
  assert.match(result, /type Payload struct \{ Envelope; Data Alias/);
  assert.match(result, /func \(value \*Payload\) Read/);
  assert.doesNotMatch(result, /type Label|type Shadow|type Unused|example\.org\/unused/);
  assert.doesNotMatch(await getSymbol(file, 'Copy', linked), /type Shadow/);
});

test('Python follows explicit aliases, class bases and simple quoted annotations', async () => {
  const file = await fixture('annotations.py', `from typing import NewType as NT, TypeAlias as TA, TypedDict
from third_party import Meta as Header
from elsewhere import Ignore

RecordId = NT('RecordId', int)
Alias: TA = list[RecordId]
class Base(TypedDict):
    header: Header
class Data(Base):
    ids: 'Alias'
class Noise:
    other: Ignore
type Output = Data

def selected(payload: 'Data') -> Output:
    return payload
`);
  const result = await getSymbol(file, 'selected', linked);
  assert.match(result, /from typing import NewType as NT, TypeAlias as TA, TypedDict/);
  assert.match(result, /from third_party import Meta as Header/);
  assert.match(result, /RecordId = NT\('RecordId', int\)/);
  assert.match(result, /Alias: TA = list\[RecordId\]/);
  assert.match(result, /class Base\(TypedDict\):/);
  assert.match(result, /class Data\(Base\):/);
  assert.match(result, /type Output = Data/);
  assert.match(result, /return payload/);
  assert.doesNotMatch(result, /class Noise|from elsewhere/);
});

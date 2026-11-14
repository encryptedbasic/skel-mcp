import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import Parser from 'web-tree-sitter';
import { ParseCache } from './cache.js';
import { linkedTypeContext } from './symbol-types.js';
import { readSourceFile } from './source-files.js';

type LanguageName = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go';
type Node = Parser.SyntaxNode;

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

export interface SkeletonOptions {
  symbolName?: string;
  detail?: 'signatures' | 'names';
  publicOnly?: boolean;
  includeImports?: boolean;
}

export interface SymbolOptions {
  imports?: 'all' | 'referenced' | 'none';
  includeTypes?: boolean;
}

export interface SymbolSnippetOptions {
  find: string;
  contextLines?: number;
}

interface Definition {
  node: Node;
  displayNode: Node;
  name: string;
  qualifiedName: string;
  kind: 'function' | 'method' | 'class';
}

const extensions = new Map<string, LanguageName>([
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.tsx', 'tsx'], ['.js', 'javascript'], ['.mjs', 'javascript'],
  ['.cjs', 'javascript'], ['.jsx', 'javascript'], ['.py', 'python'], ['.go', 'go'],
]);
const require = createRequire(import.meta.url);
const languages = new Map<LanguageName, Promise<Parser.Language>>();
const cache = new ParseCache<ParsedFile>(128, (parsed) => parsed.tree.delete());
let initialization: Promise<void> | undefined;

const functionKinds = new Set([
  'function_declaration', 'generator_function_declaration', 'function_expression',
  'function', 'generator_function', 'arrow_function', 'method_definition',
  'function_definition', 'method_declaration', 'function_literal',
]);
const classKinds = new Set(['class_declaration', 'abstract_class_declaration', 'class', 'class_definition']);
const typeKinds = new Set([
  'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'package_clause',
  'type_declaration', 'function_signature', 'declare_statement',
  'ambient_declaration', 'module', 'internal_module', 'type_alias_statement',
]);
const importKinds = new Set([
  'import_statement', 'import_from_statement', 'future_import_statement',
  'import_declaration', 'import_alias',
]);

export function isSupportedFile(filePath: string): boolean {
  return extensions.has(extname(filePath).toLowerCase());
}

async function loadLanguage(name: LanguageName): Promise<Parser.Language> {
  initialization ??= Parser.init({
    locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm'),
  });
  await initialization;
  let language = languages.get(name);
  if (!language) {
    language = Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`));
    languages.set(name, language);
    void language.catch(() => languages.delete(name));
  }
  return language;
}

/** Parse text directly, including historical Git revisions without temporary files. */
export async function parseSource(filePath: string, content: string): Promise<ParsedFile> {
  const absolutePath = resolve(filePath);
  const language = extensions.get(extname(absolutePath).toLowerCase());
  if (!language) throw new Error(`Unsupported file extension: ${extname(filePath) || '(none)'}. Supported: TS, TSX, JS, JSX, Python, Go.`);
  const cached = cache.get(absolutePath, content);
  if (cached) return cached;
  const grammar = await loadLanguage(language);
  // Loading a WASM grammar yields; a concurrent request may already have cached it.
  const loaded = cache.get(absolutePath, content);
  if (loaded) return loaded;
  const parser = new Parser();
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(content);
    const parsed: ParsedFile = { filePath: absolutePath, content, tree, language };
    cache.set(absolutePath, content, parsed);
    return parsed;
  } finally {
    parser.delete();
  }
}

export async function parseFile(filePath: string): Promise<ParsedFile> {
  const absolutePath = resolve(filePath);
  if (!isSupportedFile(absolutePath)) {
    throw new Error(`Unsupported source file: ${filePath}`);
  }
  return parseSource(absolutePath, await readSourceFile(absolutePath));
}

function walk(node: Node, visit: (node: Node) => boolean | void): void {
  if (visit(node) === false) return;
  for (const child of node.namedChildren) walk(child, visit);
}

function isRequireImport(node: Node): boolean {
  if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') return false;
  return node.namedChildren.some((declaration) => {
    const value = declaration.childForFieldName('value');
    return value?.type === 'call_expression' && value.childForFieldName('function')?.text === 'require';
  });
}

function isImport(node: Node): boolean {
  return importKinds.has(node.type) || isRequireImport(node);
}

function imports(parsed: ParsedFile): string[] {
  return parsed.tree.rootNode.namedChildren.filter(isImport).map((node) => node.text);
}

/** Unknown binding shapes are retained: this is a conservative syntactic filter. */
function importBindings(node: Node, language: LanguageName): string[] | undefined {
  if (node.hasError) return undefined;
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    if (node.type !== 'import_statement') return undefined;
    const clause = node.namedChildren.find((child) => child.type === 'import_clause');
    if (!clause || clause.namedChildren.some((child) => child.type === 'namespace_import')) return undefined;
    const bindings: string[] = [];
    for (const child of clause.namedChildren) {
      if (child.type === 'identifier') bindings.push(child.text);
      else if (child.type === 'named_imports') {
        for (const specifier of child.namedChildren) {
          if (specifier.type !== 'import_specifier') return undefined;
          const local = specifier.childForFieldName('alias') ?? specifier.childForFieldName('name');
          if (!local) return undefined;
          bindings.push(local.text);
        }
      } else return undefined;
    }
    return bindings.length ? bindings : undefined;
  }
  if (language === 'python') {
    if (node.type === 'future_import_statement' || node.namedChildren.some((child) => child.type === 'wildcard_import')) return undefined;
    const bindings: string[] = [];
    for (const name of node.childrenForFieldName('name')) {
      if (name.type === 'aliased_import') {
        const alias = name.childForFieldName('alias');
        if (!alias) return undefined;
        bindings.push(alias.text);
      } else if (name.type === 'dotted_name') {
        const first = name.namedChildren[0];
        if (!first || first.type !== 'identifier') return undefined;
        bindings.push(first.text);
      } else return undefined;
    }
    return bindings.length ? bindings : undefined;
  }
  if (language === 'go') {
    const specs = node.descendantsOfType('import_spec');
    const bindings: string[] = [];
    for (const spec of specs) {
      const name = spec.childForFieldName('name');
      // An unnamed Go import's package name need not equal its path basename.
      // Dot/blank imports and unknown implicit names must therefore stay.
      if (!name || name.type !== 'package_identifier') return undefined;
      bindings.push(name.text);
    }
    return bindings.length ? bindings : undefined;
  }
  return undefined;
}

function selectedImports(parsed: ParsedFile, nodes: Node[], policy: SymbolOptions['imports']): string[] {
  if (policy === 'none') return [];
  if (policy !== 'referenced') return imports(parsed);
  const used = new Set<string>();
  for (const root of nodes) walk(root, (node) => {
    if (node.type.endsWith('identifier')) used.add(node.text);
  });
  return parsed.tree.rootNode.namedChildren.filter(isImport).filter((node) => {
    const bindings = importBindings(node, parsed.language);
    return bindings === undefined || bindings.some((binding) => used.has(binding));
  }).map((node) => node.text);
}

function bindingNode(node: Node): Node | null {
  const parent = node.parent;
  if (!parent) return null;
  if (['variable_declarator', 'public_field_definition', 'field_definition', 'pair'].includes(parent.type)
      && parent.childForFieldName('value')?.id === node.id) {
    return parent.childForFieldName('name') ?? parent.childForFieldName('key');
  }
  if (parent.type === 'assignment_expression' && parent.childForFieldName('right')?.id === node.id) {
    return parent.childForFieldName('left');
  }
  return null;
}

function definitionName(node: Node): string | undefined {
  const binding = bindingNode(node);
  if (binding) return binding.text;
  const named = node.childForFieldName('name')?.text;
  if (named) return named;
  if (node.parent?.type === 'export_statement' && node.parent.children.some((child) => child.type === 'default')) return 'default';
  return undefined;
}

function displayNode(node: Node): Node {
  let result = node;
  const parent = node.parent;
  if (parent?.type === 'variable_declarator' || parent?.type === 'public_field_definition' || parent?.type === 'field_definition') result = parent;
  if (result.type === 'variable_declarator' && result.parent?.namedChildren.filter((child) => child.type === 'variable_declarator').length === 1) result = result.parent;
  while (result.parent && ['export_statement', 'decorated_definition'].includes(result.parent.type)) result = result.parent;
  return result;
}

function goReceiver(node: Node): string | undefined {
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return undefined;
  const parameter = receiver.namedChildren.find((child) => child.type === 'parameter_declaration');
  let type = parameter?.childForFieldName('type');
  if (type?.type === 'pointer_type') type = type.namedChildren[0] ?? null;
  return type?.text;
}

function definitions(parsed: ParsedFile): Definition[] {
  const result: Definition[] = [];
  const visit = (node: Node, owners: string[]): void => {
    const isClass = classKinds.has(node.type);
    const isFunction = functionKinds.has(node.type);
    const name = (isClass || isFunction) ? definitionName(node) : undefined;
    let childOwners = owners;
    if (name) {
      const receiver = node.type === 'method_declaration' ? goReceiver(node) : undefined;
      const qualifiedName = [...owners, ...(receiver ? [receiver] : []), name].join('.');
      result.push({
        node, displayNode: displayNode(node), name, qualifiedName,
        kind: isClass ? 'class' : (node.type === 'method_definition' || node.type === 'method_declaration' || owners.length > 0) ? 'method' : 'function',
      });
      childOwners = [...owners, name];
    }
    for (const child of node.namedChildren) visit(child, childOwners);
  };
  visit(parsed.tree.rootNode, []);
  return result;
}

interface Replacement { start: number; end: number; text: string }

function hiddenMember(node: Node): boolean {
  if (node.type === 'decorated_definition') {
    const definition = node.childForFieldName('definition') ?? node.namedChildren.find((child) => child.type !== 'decorator');
    return definition ? hiddenMember(definition) : false;
  }
  const name = node.childForFieldName('name')?.text ?? '';
  if (name === 'constructor' || name === '__init__' || name.startsWith('#')) return true;
  if (node.type === 'function_definition' && name.startsWith('_')) return true;
  return node.namedChildren.some((child) => child.type === 'accessibility_modifier'
    && ['private', 'protected'].includes(child.text));
}

function hiddenDefinition(definition: Definition): boolean {
  // Arrow functions and class expressions inherit visibility from their field;
  // nested definitions also inherit an enclosing private/protected member.
  let node: Node | null = definition.node;
  while (node) {
    if (hiddenMember(node)) return true;
    node = node.parent;
  }
  return false;
}

function pythonClassMembers(body: Node, options: SkeletonOptions): string {
  const members: string[] = [];
  for (const member of body.namedChildren) {
    if (options.publicOnly && hiddenMember(member)) continue;
    if (['function_definition', 'class_definition', 'decorated_definition'].includes(member.type)) {
      members.push(skeletonText(member, options));
    } else if (member.type === 'expression_statement') {
      const assignment = member.namedChildren[0];
      if (assignment?.type !== 'assignment' || !assignment.childForFieldName('type')) continue;
      const value = assignment.childForFieldName('right');
      members.push(value ? assignment.text.slice(0, value.startIndex - assignment.startIndex) + '...' : assignment.text);
    }
  }
  const indentation = ' '.repeat(body.startPosition.column);
  return members.length ? members.join(`\n\n${indentation}`) : '...';
}

/** Retain original source spelling, decorators, modifiers and whitespace around edits. */
function skeletonText(node: Node, options: SkeletonOptions = {}): string {
  const replacements: Replacement[] = [];
  walk(node, (child) => {
    if (options.publicOnly && child !== node && hiddenMember(child)) {
      replacements.push({ start: child.startIndex, end: child.endIndex, text: '' });
      return false;
    }
    if (child.type === 'class_definition') {
      const body = child.childForFieldName('body');
      if (body) replacements.push({ start: body.startIndex, end: body.endIndex, text: pythonClassMembers(body, options) });
      return false;
    }
    if (functionKinds.has(child.type)) {
      const body = child.childForFieldName('body');
      if (body) {
        replacements.push({ start: body.startIndex, end: body.endIndex, text: child.type === 'function_definition' ? '...' : '{ ... }' });
        return false;
      }
    }
    if (['public_field_definition', 'field_definition'].includes(child.type)) {
      const value = child.childForFieldName('value');
      if (value && !functionKinds.has(value.type) && !classKinds.has(value.type)) {
        replacements.push({ start: value.startIndex, end: value.endIndex, text: '...' });
        return false;
      }
    }
    if (child.type === 'class_static_block') {
      const body = child.childForFieldName('body') ?? child.namedChildren.find((part) => part.type === 'statement_block');
      if (body) replacements.push({ start: body.startIndex, end: body.endIndex, text: '{ ... }' });
      return false;
    }
  });
  let text = node.text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, replacement.start - node.startIndex) + replacement.text + text.slice(replacement.end - node.startIndex);
  }
  return text;
}

function skeletonDeclarations(node: Node, options: SkeletonOptions = {}): string[] {
  if (options.publicOnly && hiddenMember(node)) return [];
  if (isImport(node)) {
    if (options.includeImports !== false) return [skeletonText(node, options)];
    // A CommonJS declaration can mix require() bindings with named functions.
    if (!['lexical_declaration', 'variable_declaration'].includes(node.type)) return [];
  }
  if (typeKinds.has(node.type) || classKinds.has(node.type) || functionKinds.has(node.type)) return [skeletonText(node, options)];
  if (node.type === 'export_statement' || node.type === 'decorated_definition') {
    const declaration = node.childForFieldName('declaration') ?? node.childForFieldName('definition');
    if (declaration && ['lexical_declaration', 'variable_declaration'].includes(declaration.type)) {
      const prefix = node.text.slice(0, declaration.startIndex - node.startIndex);
      return skeletonDeclarations(declaration, options).map((text) => prefix + text);
    }
    if (declaration && skeletonDeclarations(declaration, options).length > 0) return [skeletonText(node, options)];
    // Python and some grammar versions expose the declaration only as a named child.
    if (node.namedChildren.some((child) => skeletonDeclarations(child, options).length > 0)) return [skeletonText(node, options)];
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const declarators = node.namedChildren.filter((child) => child.type === 'variable_declarator');
    const prefix = node.children.find((child) => !child.isNamed)?.text ?? 'const';
    return declarators.filter((declaration) => {
      const value = declaration.childForFieldName('value');
      return value && (functionKinds.has(value.type) || classKinds.has(value.type));
    }).map((declaration) => `${prefix} ${skeletonText(declaration, options)};`);
  }
  return [];
}

function matchingDefinitions(parsed: ParsedFile, symbolName: string): Definition[] {
  if (!symbolName.trim()) throw new Error('symbolName must not be empty.');
  const matches = definitions(parsed).filter((definition) => definition.name === symbolName || definition.qualifiedName === symbolName);
  if (!matches.length) throw new Error(`Symbol "${symbolName}" not found in ${parsed.filePath}.`);
  return matches;
}

export async function getFileSkeleton(filePath: string, options: SkeletonOptions = {}): Promise<string> {
  const parsed = await parseFile(filePath);
  const scope = options.symbolName === undefined ? undefined : matchingDefinitions(parsed, options.symbolName);
  if (options.detail === 'names') {
    const all = definitions(parsed);
    const scoped = scope ? all.filter((definition) => scope.some((owner) =>
      definition.node.startIndex >= owner.node.startIndex && definition.node.endIndex <= owner.node.endIndex)) : all;
    const visible = scoped.filter((definition) => (!options.publicOnly || !hiddenDefinition(definition))
      && !all.some((owner) => owner !== definition && owner.kind !== 'class'
        && owner.node.startIndex < definition.node.startIndex && owner.node.endIndex >= definition.node.endIndex));
    const names = visible.map((definition) => `${definition.kind} ${definition.qualifiedName}`);
    return [...(options.includeImports ? imports(parsed) : []), ...new Set(names)].join('\n') || '(No matching symbols.)';
  }
  const declarations = scope
    ? scope.filter((definition) => !options.publicOnly || !hiddenDefinition(definition)).map((definition) => {
      const rendered = skeletonText(definition.displayNode, options);
      if (definition.displayNode.type !== 'variable_declarator') return rendered;
      const code = definitionCode(definition);
      const start = code.indexOf(definition.displayNode.text);
      return code.slice(0, start) + rendered + code.slice(start + definition.displayNode.text.length);
    })
    : parsed.tree.rootNode.namedChildren.flatMap((node) => skeletonDeclarations(node, options));
  const chunks = scope && options.includeImports !== false ? [...imports(parsed), ...declarations] : declarations;
  return chunks.join('\n\n') || '(No imports, type declarations, functions or classes found.)';
}

function definitionCode(definition: Definition): string {
  const node = definition.displayNode;
  if (node.type === 'variable_declarator') {
    const declaration = node.parent;
    const prefix = declaration?.children.find((child) => !child.isNamed)?.text ?? 'const';
    const exported = declaration?.parent?.type === 'export_statement' ? 'export ' : '';
    return `${exported}${prefix} ${node.text};`;
  }
  return node.text;
}

export async function getSymbol(filePath: string, symbolName: string, options: SymbolOptions = {}): Promise<string> {
  const parsed = await parseFile(filePath);
  const matches = matchingDefinitions(parsed, symbolName);
  // Preserve all module-level imports, including side effects and Python future imports.
  const nodes = matches.map((match) => match.displayNode);
  // Copy the requested text before importing related files can evict old ASTs.
  const symbols = matches.map(definitionCode);
  const related = options.includeTypes ? await linkedTypeContext(parsed, nodes, {
    parse: parseFile,
    render: skeletonText,
    imports: (source, declarations, dependency) => selectedImports(source, declarations,
      dependency && options.imports !== 'none' ? 'referenced' : options.imports),
  }) : undefined;
  const imported = related?.imports ?? selectedImports(parsed, nodes, options.imports);
  const chunks = [...imported, ...(related?.declarations ?? []), ...symbols];
  return [...new Set(chunks)].join('\n\n');
}

/** A deliberately partial, line-numbered view inside an AST-resolved symbol. */
export async function getSymbolSnippet(filePath: string, symbolName: string, options: SymbolSnippetOptions): Promise<string> {
  if (!options.find.length) throw new Error('find must not be empty.');
  const context = options.contextLines ?? 1;
  if (!Number.isInteger(context) || context < 0 || context > 5) throw new Error('contextLines must be an integer from 0 to 5.');
  const parsed = await parseFile(filePath);
  const matches = matchingDefinitions(parsed, symbolName);
  const snippets: string[] = [];
  for (const definition of matches) {
    const node = definition.displayNode;
    const text = node.text;
    const lines = text.split(/\r?\n/);
    const ranges: Array<{ start: number; end: number }> = [];
    let offset = 0;
    while (offset <= text.length) {
      const found = text.indexOf(options.find, offset);
      if (found === -1) break;
      const start = text.slice(0, found).split('\n').length - 1;
      const end = start + options.find.split('\n').length - 1;
      const range = { start: Math.max(0, start - context), end: Math.min(lines.length - 1, end + context) };
      const previous = ranges.at(-1);
      if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
      else ranges.push(range);
      offset = found + Math.max(1, options.find.length);
    }
    if (!ranges.length) continue;
    const result = [`snippet ${definition.qualifiedName}`];
    let next = 0;
    for (const range of ranges) {
      if (range.start > next) result.push('...');
      for (let index = range.start; index <= range.end; index++) {
        result.push(`${node.startPosition.row + index + 1}: ${lines[index] ?? ''}`);
      }
      next = range.end + 1;
    }
    if (next < lines.length) result.push('...');
    snippets.push(result.join('\n'));
  }
  if (!snippets.length) throw new Error(`No match for ${JSON.stringify(options.find)} in symbol ${JSON.stringify(symbolName)}.`);
  return snippets.join('\n\n');
}

function endLine(node: Node): number {
  return node.endPosition.row + (node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row ? 0 : 1);
}

/** Outermost affected definitions avoid repeating methods already included in a class. */
export function getEnclosingSymbols(parsed: ParsedFile, ranges: LineRange[]): ExtractedSymbol[] {
  const affected = definitions(parsed).filter(({ displayNode: node }) => ranges.some((range) =>
    range.startLine <= endLine(node) && range.endLine >= node.startPosition.row + 1));
  return affected.filter((definition) => !affected.some((outer) => outer !== definition
    && outer.displayNode.startIndex <= definition.displayNode.startIndex
    && outer.displayNode.endIndex >= definition.displayNode.endIndex
    && (outer.displayNode.startIndex < definition.displayNode.startIndex || outer.displayNode.endIndex > definition.displayNode.endIndex)))
    .map((definition) => ({
      name: definition.qualifiedName,
      kind: definition.kind,
      startLine: definition.displayNode.startPosition.row + 1,
      endLine: endLine(definition.displayNode),
      code: definitionCode(definition),
    }));
}

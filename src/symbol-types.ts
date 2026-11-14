import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type Parser from 'web-tree-sitter';
import type { ParsedFile } from './parser.js';
import { resolveWorkspaceFile } from './source-files.js';

type Node = Parser.SyntaxNode;
type Language = ParsedFile['language'];

interface Declaration {
  name: string;
  node: Node;
  display: Node;
}

interface TypeReference {
  name: string;
  member?: string;
}

const tsDeclarations = new Set(['interface_declaration', 'type_alias_declaration', 'enum_declaration', 'class_declaration', 'abstract_class_declaration', 'class']);
const functionNodes = new Set(['function_declaration', 'function_definition', 'function_expression', 'function', 'arrow_function', 'method_definition', 'method_declaration', 'function_literal', 'generator_function', 'generator_function_declaration']);

function isEcmaScript(language: Language): boolean {
  return language === 'javascript' || language === 'typescript' || language === 'tsx';
}

function assignment(node: Node): Node | undefined {
  const child = node.type === 'expression_statement' ? node.namedChildren[0] : undefined;
  return child?.type === 'assignment' ? child : undefined;
}

function pythonTypingNames(parsed: ParsedFile): { aliases: Set<string>; factories: Set<string> } {
  const aliases = new Set<string>();
  const factories = new Set<string>();
  for (const statement of parsed.tree.rootNode.namedChildren) {
    const module = statement.childForFieldName('module_name')?.text;
    if (statement.type === 'import_from_statement' && (module === 'typing' || module === 'typing_extensions')) {
      for (const item of statement.childrenForFieldName('name')) {
        const name = item.childForFieldName('name')?.text ?? item.text;
        const local = item.childForFieldName('alias')?.text ?? name;
        if (name === 'TypeAlias') aliases.add(local);
        if (name === 'NewType') factories.add(local);
      }
    }
    if (statement.type === 'import_statement') {
      for (const item of statement.childrenForFieldName('name')) {
        const name = item.childForFieldName('name')?.text ?? item.text;
        if (name !== 'typing' && name !== 'typing_extensions') continue;
        const local = item.childForFieldName('alias')?.text ?? name;
        aliases.add(`${local}.TypeAlias`);
        factories.add(`${local}.NewType`);
      }
    }
  }
  return { aliases, factories };
}

function pythonAliasName(node: Node): string | undefined {
  const left = node.namedChildren[0]?.namedChildren[0];
  if (left?.type === 'identifier') return left.text;
  if (left?.type === 'generic_type') return left.namedChildren[0]?.text;
  return undefined;
}

function moduleDeclarations(parsed: ParsedFile): Declaration[] {
  const result: Declaration[] = [];
  const typing = parsed.language === 'python' ? pythonTypingNames(parsed) : undefined;
  for (const statement of parsed.tree.rootNode.namedChildren) {
    if (parsed.language === 'go' && statement.type === 'type_declaration') {
      for (const node of statement.namedChildren) {
        const name = node.childForFieldName('name')?.text;
        if (name && ['type_spec', 'type_alias'].includes(node.type)) result.push({ name, node, display: node });
      }
      continue;
    }
    if (typing) {
      const definition = statement.childForFieldName('definition') ?? statement;
      if (definition.type === 'class_definition') {
        const name = definition.childForFieldName('name')?.text;
        if (name) result.push({ name, node: definition, display: statement });
      } else if (statement.type === 'type_alias_statement') {
        const name = pythonAliasName(statement);
        if (name) result.push({ name, node: statement, display: statement });
      } else {
        const node = assignment(statement);
        const name = node?.childForFieldName('left');
        const value = node?.childForFieldName('right');
        const annotation = node?.childForFieldName('type')?.text;
        const factory = value?.type === 'call' ? value.childForFieldName('function')?.text : undefined;
        if (node && name?.type === 'identifier' && (typing.aliases.has(annotation ?? '') || typing.factories.has(factory ?? ''))) {
          result.push({ name: name.text, node, display: statement });
        }
      }
      continue;
    }
    let node = statement;
    if (node.type === 'export_statement') node = node.childForFieldName('declaration') ?? node.childForFieldName('value') ?? node;
    if (node.type === 'ambient_declaration') node = node.namedChildren[0] ?? node;
    if (tsDeclarations.has(node.type)) {
      const name = node.childForFieldName('name')?.text ?? (hasExportModifier(statement, 'default') ? 'default' : undefined);
      if (name) result.push({ name, node, display: statement });
      continue;
    }
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const declaration of node.namedChildren) {
        const name = declaration.childForFieldName('name');
        const value = declaration.childForFieldName('value');
        if (name?.type !== 'identifier' || value?.type !== 'class') continue;
        const display = node.namedChildren.filter((child) => child.type === 'variable_declarator').length === 1 ? statement : declaration;
        result.push({ name: name.text, node: value, display });
      }
    }
  }
  return result;
}

function hasExportModifier(node: Node, modifier: string): boolean {
  return node.type === 'export_statement' && node.children.some((child) => child.type === modifier);
}

function introducedNames(node: Node, language: Language): string[] {
  const typeParameters = node.childForFieldName('type_parameters');
  const names = typeParameters?.namedChildren.flatMap((parameter) => parameter.childrenForFieldName('name').map((name) => name.text)) ?? [];
  if (language === 'go' && node.type === 'method_declaration') {
    const receiver = node.childForFieldName('receiver');
    for (const generic of receiver?.descendantsOfType('generic_type') ?? []) {
      const args = generic.childForFieldName('type_arguments');
      for (const argument of args?.namedChildren ?? []) if (argument.type === 'type_identifier') names.push(argument.text);
    }
  }
  if (node.type === 'type_alias_statement') {
    const left = node.namedChildren[0]?.namedChildren[0];
    if (left?.type === 'generic_type') names.push(...left.namedChildren.slice(1).flatMap((part) => part.descendantsOfType('identifier').map((id) => id.text)));
  }
  if (node.type === 'statement_block' || node.type === 'block') {
    for (const statement of node.namedChildren) {
      if (!tsDeclarations.has(statement.type)) continue;
      const name = statement.childForFieldName('name')?.text;
      if (name) names.push(name);
    }
  }
  return names;
}

function isDeclaredName(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (tsDeclarations.has(parent.type) || ['type_spec', 'type_alias', 'type_parameter', 'mapped_type_clause'].includes(parent.type))
    && parent.childForFieldName('name')?.id === node.id;
}

function runtimeType(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'new_expression') return parent.childForFieldName('constructor')?.id === node.id;
  return parent.type === 'type_query' || parent.type === 'extends_clause' || parent.type === 'class_heritage';
}

function pythonTypeString(node: Node): string | undefined {
  const content = node.namedChildren.find((child) => child.type === 'string_content');
  if (!content || !/^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?$/u.test(content.text)) return undefined;
  for (let parent = node.parent; parent && parent.type !== 'module'; parent = parent.parent) {
    if (['generic_type', 'subscript'].includes(parent.type)) {
      const base = parent.namedChildren[0]?.text.split('.').at(-1);
      if (base === 'Literal' || base === 'Annotated') return undefined;
    }
    if (parent.type === 'typed_parameter' || parent.type === 'typed_default_parameter' || parent.type === 'function_definition') break;
  }
  return content.text;
}

function references(root: Node, language: Language, declaration?: Declaration): TypeReference[] {
  const result = new Map<string, TypeReference>();
  const add = (name: string, shadowed: ReadonlySet<string>, member?: string): void => {
    if (!shadowed.has(name)) result.set(member ? `${name}.${member}` : name, { name, member });
  };
  function visit(node: Node, inherited: ReadonlySet<string>, inPythonType: boolean): void {
    const names = introducedNames(node, language);
    const shadowed = names.length ? new Set([...inherited, ...names]) : inherited;
    const pythonType = inPythonType || (language === 'python' && node.type === 'type');
    if (node.type === 'nested_type_identifier' && isEcmaScript(language)) {
      const module = node.childForFieldName('module');
      const member = node.childForFieldName('name');
      if (module?.type === 'identifier' && member) add(module.text, shadowed, member.text);
      return;
    }
    if (language === 'go' && node.type === 'qualified_type') return;
    if (isEcmaScript(language) && runtimeType(node)) {
      if (node.type === 'identifier') add(node.text, shadowed);
      if (node.type === 'member_expression') {
        const object = node.childForFieldName('object');
        const property = node.childForFieldName('property');
        if (object?.type === 'identifier' && property) add(object.text, shadowed, property.text);
      }
    }
    if (node.type === 'type_identifier' && !isDeclaredName(node) && node.parent?.type !== 'infer_type') add(node.text, shadowed);
    if (language === 'python' && pythonType) {
      if (node.type === 'identifier') add(node.text, shadowed);
      if (node.type === 'attribute') {
        const object = node.childForFieldName('object');
        const property = node.childForFieldName('attribute');
        if (object?.type === 'identifier' && property) add(object.text, shadowed, property.text);
        return;
      }
      if (node.type === 'string') {
        const [name, member] = pythonTypeString(node)?.split('.') ?? [];
        if (name) add(name, shadowed, member);
        return;
      }
    }
    const skipped = new Set<number>();
    if (declaration && functionNodes.has(node.type)) {
      const body = node.childForFieldName('body');
      if (body) skipped.add(body.id);
    }
    if (node.type === 'type_alias_statement') {
      const binder = node.namedChildren[0];
      if (binder) skipped.add(binder.id);
    }
    if (declaration && language === 'python' && node === root && node.type === 'assignment') {
      const right = node.childForFieldName('right');
      const left = node.childForFieldName('left');
      if (left) skipped.add(left.id);
      if (right) {
        if (right.type === 'call') {
          const underlying = right.childForFieldName('arguments')?.namedChildren[1];
          if (underlying) visit(underlying, shadowed, true);
        } else visit(right, shadowed, true);
        skipped.add(right.id);
      }
    }
    const bases = language === 'python' ? node.childForFieldName('superclasses') : null;
    for (const child of node.namedChildren) {
      if (!skipped.has(child.id)) visit(child, shadowed, pythonType || child.id === bases?.id);
    }
  }
  visit(root, new Set(), false);
  return [...result.values()];
}

interface Closure {
  declarations: Declaration[];
  unresolved: TypeReference[];
}

function closeTypes(parsed: ParsedFile, candidates: Declaration[], roots: Node[], initial: Declaration[] = []): Closure {
  const byName = new Map<string, Declaration[]>();
  for (const declaration of candidates) {
    const group = byName.get(declaration.name) ?? [];
    group.push(declaration);
    byName.set(declaration.name, group);
  }
  const chosen = new Set<Declaration>();
  const visited = new Set<Declaration>();
  const unresolved = new Map<string, TypeReference>();
  const queue = roots.flatMap((root) => references(root, parsed.language));
  function select(item: Declaration): void {
    if (visited.has(item)) return;
    visited.add(item);
    if (roots.some((root) => item.node.startIndex >= root.startIndex && item.node.endIndex <= root.endIndex)) return;
    chosen.add(item);
    queue.push(...references(item.node, parsed.language, item));
  }
  initial.forEach(select);
  for (const reference of queue) {
    const found = reference.member ? undefined : byName.get(reference.name);
    if (found) found.forEach(select);
    else unresolved.set(reference.member ? `${reference.name}.${reference.member}` : reference.name, reference);
  }
  return { declarations: [...chosen].sort((a, b) => a.node.startIndex - b.node.startIndex), unresolved: [...unresolved.values()] };
}

function exportNames(parsed: ParsedFile, candidates: Declaration[], exported: string): Declaration[] {
  const matches = candidates.filter((item) => hasExportModifier(item.display, 'default') ? exported === 'default' : item.display.type === 'export_statement' && item.name === exported);
  for (const node of parsed.tree.rootNode.namedChildren) {
    if (node.type !== 'export_statement' || node.childForFieldName('source')) continue;
    const clause = node.namedChildren.find((child) => child.type === 'export_clause');
    for (const specifier of clause?.namedChildren ?? []) {
      const name = specifier.childForFieldName('name')?.text;
      const alias = specifier.childForFieldName('alias')?.text ?? name;
      if (name && alias === exported) matches.push(...candidates.filter((item) => item.name === name));
    }
    const value = node.childForFieldName('value');
    if (exported === 'default' && hasExportModifier(node, 'default') && value?.type === 'identifier') {
      matches.push(...candidates.filter((item) => item.name === value.text));
    }
  }
  return [...new Set(matches)];
}

function relativeImports(parsed: ParsedFile, refs: TypeReference[]): Map<string, Set<string>> {
  const modules = new Map<string, Set<string>>();
  function add(source: string, local: string, name?: string): void {
    for (const ref of refs) {
      if (ref.name !== local || (name === undefined) !== (ref.member !== undefined)) continue;
      const imported = name ?? ref.member;
      if (!imported) continue;
      const list = modules.get(source) ?? new Set<string>();
      list.add(imported);
      modules.set(source, list);
    }
  }
  for (const node of parsed.tree.rootNode.namedChildren) {
    if (node.type !== 'import_statement') continue;
    const source = node.childForFieldName('source')?.namedChildren.find((child) => child.type === 'string_fragment')?.text;
    const literal = node.childForFieldName('source');
    if (!source || literal?.namedChildren.length !== 1 || !/^\.\.?\//.test(source)) continue;
    const clause = node.namedChildren.find((child) => child.type === 'import_clause');
    for (const binding of clause?.namedChildren ?? []) {
      if (binding.type === 'identifier') add(source, binding.text, 'default');
      if (binding.type === 'namespace_import') {
        const local = binding.namedChildren.find((child) => child.type === 'identifier');
        if (local) add(source, local.text);
      }
      if (binding.type === 'named_imports') {
        for (const specifier of binding.namedChildren) {
          const name = specifier.childForFieldName('name')?.text;
          const local = specifier.childForFieldName('alias')?.text ?? name;
          if (name && local) add(source, local, name);
        }
      }
    }
  }
  return modules;
}

const tsExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    && !relative.split(path.sep).some((part) => part === '..' || part.toLowerCase() === 'node_modules');
}

async function resolveRelativeTypeFile(from: string, specifier: string, root: string): Promise<string | undefined> {
  const target = path.resolve(path.dirname(from), specifier);
  if (!within(root, target)) return undefined;
  const extension = path.extname(target);
  if (extension && !tsExtensions.includes(extension)) return undefined;
  const stem = target.slice(0, extension ? -extension.length : undefined);
  const mapped = extension === '.js' ? ['.ts', '.tsx', '.d.ts'] : extension === '.jsx' ? ['.tsx'] : extension === '.mjs' ? ['.mts', '.d.mts'] : extension === '.cjs' ? ['.cts', '.d.cts'] : [];
  const candidates = extension && tsExtensions.includes(extension)
    ? [...mapped.map((ext) => stem + ext), target]
    : tsExtensions.flatMap((ext) => [target + ext, path.join(target, `index${ext}`)]);
  const existing = new Set<string>();
  for (const candidate of candidates) {
    try {
      const absolute = await resolveWorkspaceFile(candidate, root);
      if (within(root, absolute)) existing.add(absolute);
    } catch {
      // A relative import can refer to generated or unavailable source.
    }
  }
  return existing.size === 1 ? existing.values().next().value : undefined;
}

interface TypeContext {
  imports: string[];
  declarations: string[];
}

interface TypeReaders {
  parse: (file: string) => Promise<ParsedFile>;
  render: (node: Node) => string;
  imports: (parsed: ParsedFile, nodes: Node[], dependency: boolean) => string[];
}

function renderDeclaration(item: Declaration, language: Language, render: TypeReaders['render']): string {
  if (language === 'go') return `type ${item.display.text}`;
  if (item.display.type !== 'variable_declarator') return render(item.display);
  const declaration = item.display.parent;
  const keyword = declaration?.children.find((child) => ['const', 'let', 'var'].includes(child.type))?.text ?? 'const';
  return `${keyword} ${render(item.display)};`;
}

export async function linkedTypeContext(parsed: ParsedFile, roots: Node[], readers: TypeReaders): Promise<TypeContext> {
  const closure = closeTypes(parsed, moduleDeclarations(parsed), roots);
  const local = closure.declarations.map((item) => item.display);
  const imports = readers.imports(parsed, [...roots, ...local], false);
  const declarations = closure.declarations.map((item) => renderDeclaration(item, parsed.language, readers.render));
  // Tree-sitter nodes belong to a bounded cache. Only plain text crosses async reads.
  const result = { imports, declarations };
  if (!isEcmaScript(parsed.language)) return result;
  const pending = relativeImports(parsed, closure.unresolved);
  if (!pending.size) return result;
  let root: string;
  let source: string;
  try {
    root = await realpath(process.cwd());
    source = await realpath(parsed.filePath);
    if (!within(root, source)) return result;
  } catch {
    return result;
  }
  const external = new Map<string, Set<string>>();
  for (const [specifier, names] of pending) {
    const file = await resolveRelativeTypeFile(source, specifier, root);
    if (!file || file === source) continue;
    const allNames = external.get(file) ?? new Set<string>();
    for (const name of names) allNames.add(name);
    external.set(file, allNames);
  }
  for (const [file, names] of external) {
    try {
      const other = await readers.parse(file);
      if (!isEcmaScript(other.language)) continue;
      const candidates = moduleDeclarations(other);
      const exported = [...names].flatMap((name) => exportNames(other, candidates, name));
      const linked = closeTypes(other, candidates, [], exported).declarations;
      if (!linked.length) continue;
      const imports = readers.imports(other, linked.map((item) => item.display), true);
      const code = linked.map((item) => renderDeclaration(item, other.language, readers.render));
      const origin = path.relative(root, file).split(path.sep).join('/');
      declarations.push([`// ${origin}`, ...imports, ...code].join('\n'));
    } catch {
      // The original import still identifies the dependency when a local file can't be read.
    }
  }
  return result;
}

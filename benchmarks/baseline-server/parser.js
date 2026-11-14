import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import Parser from 'web-tree-sitter';
import { ParseCache } from './cache.js';
const extensions = new Map([
    ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
    ['.tsx', 'tsx'], ['.js', 'javascript'], ['.mjs', 'javascript'],
    ['.cjs', 'javascript'], ['.jsx', 'javascript'], ['.py', 'python'], ['.go', 'go'],
]);
const require = createRequire(import.meta.url);
const languages = new Map();
const cache = new ParseCache(128, (parsed) => parsed.tree.delete());
let initialization;
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
export function isSupportedFile(filePath) {
    return extensions.has(extname(filePath).toLowerCase());
}
async function loadLanguage(name) {
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
export async function parseSource(filePath, content) {
    const absolutePath = resolve(filePath);
    const language = extensions.get(extname(absolutePath).toLowerCase());
    if (!language)
        throw new Error(`Unsupported file extension: ${extname(filePath) || '(none)'}. Supported: TS, TSX, JS, JSX, Python, Go.`);
    const cached = cache.get(absolutePath, content);
    if (cached)
        return cached;
    const grammar = await loadLanguage(language);
    // Loading a WASM grammar yields; a concurrent request may already have cached it.
    const loaded = cache.get(absolutePath, content);
    if (loaded)
        return loaded;
    const parser = new Parser();
    try {
        parser.setLanguage(grammar);
        const tree = parser.parse(content);
        const parsed = { filePath: absolutePath, content, tree, language };
        cache.set(absolutePath, content, parsed);
        return parsed;
    }
    finally {
        parser.delete();
    }
}
export async function parseFile(filePath) {
    const absolutePath = resolve(filePath);
    return parseSource(absolutePath, await readFile(absolutePath, 'utf8'));
}
function walk(node, visit) {
    if (visit(node) === false)
        return;
    for (const child of node.namedChildren)
        walk(child, visit);
}
function isRequireImport(node) {
    if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration')
        return false;
    return node.namedChildren.some((declaration) => {
        const value = declaration.childForFieldName('value');
        return value?.type === 'call_expression' && value.childForFieldName('function')?.text === 'require';
    });
}
function isImport(node) {
    return importKinds.has(node.type) || isRequireImport(node);
}
function imports(parsed) {
    return parsed.tree.rootNode.namedChildren.filter(isImport).map((node) => node.text);
}
function bindingNode(node) {
    const parent = node.parent;
    if (!parent)
        return null;
    if (['variable_declarator', 'public_field_definition', 'field_definition', 'pair'].includes(parent.type)
        && parent.childForFieldName('value')?.id === node.id) {
        return parent.childForFieldName('name') ?? parent.childForFieldName('key');
    }
    if (parent.type === 'assignment_expression' && parent.childForFieldName('right')?.id === node.id) {
        return parent.childForFieldName('left');
    }
    return null;
}
function definitionName(node) {
    const binding = bindingNode(node);
    if (binding)
        return binding.text;
    const named = node.childForFieldName('name')?.text;
    if (named)
        return named;
    if (node.parent?.type === 'export_statement' && node.parent.children.some((child) => child.type === 'default'))
        return 'default';
    return undefined;
}
function displayNode(node) {
    let result = node;
    const parent = node.parent;
    if (parent?.type === 'variable_declarator' || parent?.type === 'public_field_definition' || parent?.type === 'field_definition')
        result = parent;
    if (result.type === 'variable_declarator' && result.parent?.namedChildren.filter((child) => child.type === 'variable_declarator').length === 1)
        result = result.parent;
    while (result.parent && ['export_statement', 'decorated_definition'].includes(result.parent.type))
        result = result.parent;
    return result;
}
function goReceiver(node) {
    const receiver = node.childForFieldName('receiver');
    if (!receiver)
        return undefined;
    const parameter = receiver.namedChildren.find((child) => child.type === 'parameter_declaration');
    let type = parameter?.childForFieldName('type');
    if (type?.type === 'pointer_type')
        type = type.namedChildren[0] ?? null;
    return type?.text;
}
function definitions(parsed) {
    const result = [];
    const visit = (node, owners) => {
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
        for (const child of node.namedChildren)
            visit(child, childOwners);
    };
    visit(parsed.tree.rootNode, []);
    return result;
}
function pythonClassMembers(body) {
    const members = [];
    for (const member of body.namedChildren) {
        if (['function_definition', 'class_definition', 'decorated_definition'].includes(member.type)) {
            members.push(skeletonText(member));
        }
        else if (member.type === 'expression_statement') {
            const assignment = member.namedChildren[0];
            if (assignment?.type !== 'assignment' || !assignment.childForFieldName('type'))
                continue;
            const value = assignment.childForFieldName('right');
            members.push(value ? assignment.text.slice(0, value.startIndex - assignment.startIndex) + '...' : assignment.text);
        }
    }
    const indentation = ' '.repeat(body.startPosition.column);
    return members.length ? members.join(`\n\n${indentation}`) : '...';
}
/** Retain original source spelling, decorators, modifiers and whitespace around edits. */
function skeletonText(node) {
    const replacements = [];
    walk(node, (child) => {
        if (child.type === 'class_definition') {
            const body = child.childForFieldName('body');
            if (body)
                replacements.push({ start: body.startIndex, end: body.endIndex, text: pythonClassMembers(body) });
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
            if (body)
                replacements.push({ start: body.startIndex, end: body.endIndex, text: '{ ... }' });
            return false;
        }
    });
    let text = node.text;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        text = text.slice(0, replacement.start - node.startIndex) + replacement.text + text.slice(replacement.end - node.startIndex);
    }
    return text;
}
function skeletonDeclarations(node) {
    if (isImport(node) || typeKinds.has(node.type) || classKinds.has(node.type) || functionKinds.has(node.type))
        return [skeletonText(node)];
    if (node.type === 'export_statement' || node.type === 'decorated_definition') {
        const declaration = node.childForFieldName('declaration') ?? node.childForFieldName('definition');
        if (declaration && ['lexical_declaration', 'variable_declaration'].includes(declaration.type)) {
            const prefix = node.text.slice(0, declaration.startIndex - node.startIndex);
            return skeletonDeclarations(declaration).map((text) => prefix + text);
        }
        if (declaration && skeletonDeclarations(declaration).length > 0)
            return [skeletonText(node)];
        // Python and some grammar versions expose the declaration only as a named child.
        if (node.namedChildren.some((child) => skeletonDeclarations(child).length > 0))
            return [skeletonText(node)];
    }
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        const declarators = node.namedChildren.filter((child) => child.type === 'variable_declarator');
        const prefix = node.children.find((child) => !child.isNamed)?.text ?? 'const';
        return declarators.filter((declaration) => {
            const value = declaration.childForFieldName('value');
            return value && (functionKinds.has(value.type) || classKinds.has(value.type));
        }).map((declaration) => `${prefix} ${skeletonText(declaration)};`);
    }
    return [];
}
export async function getFileSkeleton(filePath) {
    const parsed = await parseFile(filePath);
    return parsed.tree.rootNode.namedChildren.flatMap(skeletonDeclarations).join('\n\n') || '(No imports, type declarations, functions or classes found.)';
}
function definitionCode(definition) {
    const node = definition.displayNode;
    if (node.type === 'variable_declarator') {
        const declaration = node.parent;
        const prefix = declaration?.children.find((child) => !child.isNamed)?.text ?? 'const';
        const exported = declaration?.parent?.type === 'export_statement' ? 'export ' : '';
        return `${exported}${prefix} ${node.text};`;
    }
    return node.text;
}
export async function getSymbol(filePath, symbolName) {
    if (!symbolName.trim())
        throw new Error('symbolName must not be empty.');
    const parsed = await parseFile(filePath);
    const matches = definitions(parsed).filter((definition) => definition.name === symbolName || definition.qualifiedName === symbolName);
    if (!matches.length)
        throw new Error(`Symbol "${symbolName}" not found in ${parsed.filePath}.`);
    // Preserve all module-level imports, including side effects and Python future imports.
    const chunks = [...imports(parsed), ...matches.map(definitionCode)];
    return [...new Set(chunks)].join('\n\n');
}
function endLine(node) {
    return node.endPosition.row + (node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row ? 0 : 1);
}
/** Outermost affected definitions avoid repeating methods already included in a class. */
export function getEnclosingSymbols(parsed, ranges) {
    const affected = definitions(parsed).filter(({ displayNode: node }) => ranges.some((range) => range.startLine <= endLine(node) && range.endLine >= node.startPosition.row + 1));
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
//# sourceMappingURL=parser.js.map
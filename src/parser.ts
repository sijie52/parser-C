import * as TreeSitter from 'web-tree-sitter';
import * as UAST from '@ant-yasa/uast-spec';
import { version } from '../package.json';

type SyntaxNode = TreeSitter.Node;

let parserInstance: TreeSitter.Parser | null = null;

export async function init(): Promise<void> {
    await TreeSitter.Parser.init();
    const Lang = await TreeSitter.Language.load(
        require.resolve('tree-sitter-c/tree-sitter-c.wasm')
    );
    parserInstance = new TreeSitter.Parser();
    parserInstance.setLanguage(Lang);
}

function getParser(): TreeSitter.Parser {
    if (!parserInstance) {
        throw new Error('Parser not initialized. Call init() first.');
    }
    return parserInstance;
}

function toSourceLocation(node: SyntaxNode, sourcefile?: string) {
    return {
        start: {
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
        },
        end: {
            line: node.endPosition.row + 1,
            column: node.endPosition.column + 1,
        },
        sourcefile,
    };
}

function appendNodeMeta<T>(uastNode: T, tsNode: SyntaxNode | null | undefined, sourcefile?: string): T {
    if (!uastNode || typeof uastNode !== 'object' || !UAST.isNode(uastNode as any)) {
        return uastNode;
    }

    if (tsNode) {
        const loc = toSourceLocation(tsNode, sourcefile);
        (uastNode as any).loc = loc;
        (uastNode as any)._meta.loc = loc;
        (uastNode as any)._meta.origin = {
            type: tsNode.type,
            text: tsNode.text,
        };
    }

    return uastNode;
}

function visitList(nodes: SyntaxNode[], opts: Record<string, any>): Array<any> {
    return nodes
        .map((node) => visit(node, opts))
        .filter((node) => node !== null && node !== undefined);
}

function flattenInstructions(nodes: Array<any>): Array<any> {
    const instructions: Array<any> = [];
    for (const node of nodes) {
        if (!node) continue;
        if (UAST.isSequence(node)) {
            instructions.push(...node.expressions);
            continue;
        }
        instructions.push(node);
    }
    return instructions;
}

function namedChild(node: SyntaxNode, index: number): SyntaxNode | null {
    return node.namedChildren[index] || null;
}

function firstNamedExcept(node: SyntaxNode, types: string[]): SyntaxNode | null {
    return node.namedChildren.find((child) => !types.includes(child.type)) || null;
}

function getOperator(node: SyntaxNode): string {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (!child.isNamed && !['(', ')', '[', ']', '{', '}', ',', ';', ':'].includes(child.text)) {
            return child.text;
        }
    }
    return '';
}

function cIdentifier(name: string, node?: SyntaxNode | null, sourcefile?: string): UAST.Identifier {
    return appendNodeMeta(UAST.identifier(name || '_'), node, sourcefile);
}

function dynamicType(node?: SyntaxNode | null, sourcefile?: string): UAST.DynamicType {
    return appendNodeMeta(UAST.dynamicType(), node, sourcefile);
}

function voidType(node?: SyntaxNode | null, sourcefile?: string): UAST.VoidType {
    return appendNodeMeta(UAST.voidType(cIdentifier('void', node, sourcefile)), node, sourcefile);
}

function primitiveType(name: string, node?: SyntaxNode | null, sourcefile?: string): UAST.PrimitiveType {
    const normalized = name.replace(/\s+/g, ' ').trim();
    const typeNode = UAST.primitiveType(cIdentifier(normalized, node, sourcefile));
    const kind = normalized === '_Bool' || normalized === 'bool' ? 'boolean'
        : normalized === 'char' || normalized.includes('char') ? 'string'
            : 'number';
    (typeNode as any).kind = kind;
    return appendNodeMeta(typeNode, node, sourcefile);
}

function pointerType(element: UAST.Type, node?: SyntaxNode | null, sourcefile?: string): UAST.PointerType {
    const ptr = UAST.pointerType(cIdentifier('pointer', node, sourcefile), element);
    (ptr as any).kind = 'pointer';
    return appendNodeMeta(ptr, node, sourcefile);
}

function arrayType(element: UAST.Type, size?: UAST.Expression | null, node?: SyntaxNode | null, sourcefile?: string): UAST.ArrayType {
    return appendNodeMeta(UAST.arrayType(cIdentifier('array', node, sourcefile), element, null, size || null), node, sourcefile);
}

function mapTypeSpecifier(node: SyntaxNode | null | undefined, opts: Record<string, any>): UAST.Type {
    const sourcefile = opts?.sourcefile as string | undefined;
    if (!node) return dynamicType(null, sourcefile);

    switch (node.type) {
        case 'primitive_type':
            if (node.text === 'void') return voidType(node, sourcefile);
            return primitiveType(node.text, node, sourcefile);
        case 'sized_type_specifier':
            return primitiveType(node.text, node, sourcefile);
        case 'type_identifier':
        case 'identifier':
            return cIdentifier(node.text, node, sourcefile) as any;
        case 'struct_specifier':
        case 'union_specifier':
        case 'enum_specifier': {
            const nameNode = node.childForFieldName('name') || node.namedChildren.find((child) => child.type === 'type_identifier');
            const id = cIdentifier(nameNode ? nameNode.text : node.type.replace('_specifier', ''), nameNode || node, sourcefile);
            const st = UAST.scopedType(id, null);
            (st as any)._meta.kind = node.type.replace('_specifier', '');
            return appendNodeMeta(st, node, sourcefile);
        }
        default:
            if (node.namedChildren.length === 1) {
                return mapTypeSpecifier(node.namedChildren[0], opts);
            }
            return cIdentifier(node.text, node, sourcefile) as any;
    }
}

function declaratorName(node: SyntaxNode | null | undefined): SyntaxNode | null {
    if (!node) return null;
    if (node.type === 'identifier' || node.type === 'field_identifier') return node;
    const named = node.childForFieldName('declarator')
        || node.childForFieldName('name')
        || node.childForFieldName('function')
        || node.childForFieldName('field');
    if (named) return declaratorName(named);
    for (const child of node.namedChildren) {
        const found = declaratorName(child);
        if (found) return found;
    }
    return null;
}

function applyDeclaratorType(base: UAST.Type, declarator: SyntaxNode | null | undefined, opts: Record<string, any>): UAST.Type {
    const sourcefile = opts?.sourcefile as string | undefined;
    if (!declarator) return base;

    switch (declarator.type) {
        case 'pointer_declarator':
        case 'abstract_pointer_declarator':
            return pointerType(applyDeclaratorType(base, declarator.childForFieldName('declarator') || namedChild(declarator, 0), opts), declarator, sourcefile);
        case 'array_declarator':
        case 'abstract_array_declarator': {
            const inner = declarator.childForFieldName('declarator') || namedChild(declarator, 0);
            const sizeNode = declarator.childForFieldName('size');
            const size = sizeNode ? visit(sizeNode, opts) as UAST.Expression : null;
            return arrayType(applyDeclaratorType(base, inner, opts), size, declarator, sourcefile);
        }
        case 'function_declarator':
        case 'abstract_function_declarator': {
            const paramsNode = declarator.childForFieldName('parameters') || declarator.namedChildren.find((c) => c.type === 'parameter_list');
            const params = paramsNode
                ? paramsNode.namedChildren
                    .filter((p) => p.type === 'parameter_declaration')
                    .map((p) => parameterType(p, opts))
                : [];
            return appendNodeMeta(UAST.funcType(cIdentifier('function', declarator, sourcefile), [], params, [base]), declarator, sourcefile);
        }
        case 'parenthesized_declarator':
            return applyDeclaratorType(base, namedChild(declarator, 0), opts);
        case 'init_declarator':
            return applyDeclaratorType(base, declarator.childForFieldName('declarator') || namedChild(declarator, 0), opts);
        default:
            return base;
    }
}

function returnTypeFromFunction(typeNode: SyntaxNode | null, declarator: SyntaxNode | null, opts: Record<string, any>): UAST.Type {
    const base = mapTypeSpecifier(typeNode, opts);
    if (declarator?.type === 'function_declarator') {
        return applyDeclaratorType(base, declarator.childForFieldName('declarator') || namedChild(declarator, 0), opts);
    }
    return applyDeclaratorType(base, declarator, opts);
}

function parameterType(paramNode: SyntaxNode, opts: Record<string, any>): UAST.Type {
    const typeNode = paramNode.childForFieldName('type') || namedChild(paramNode, 0);
    const declarator = paramNode.childForFieldName('declarator') || paramNode.namedChildren.find((c) => c !== typeNode);
    return applyDeclaratorType(mapTypeSpecifier(typeNode, opts), declarator, opts);
}

function createParameter(paramNode: SyntaxNode, opts: Record<string, any>): UAST.VariableDeclaration {
    const sourcefile = opts?.sourcefile as string | undefined;
    const nameNode = declaratorName(paramNode);
    const id = cIdentifier(nameNode ? nameNode.text : '_', nameNode || paramNode, sourcefile);
    const decl = UAST.variableDeclaration(id, null, false, parameterType(paramNode, opts));
    decl._meta.isParameter = true;
    if (!nameNode) decl._meta.unnamed = true;
    return appendNodeMeta(decl, paramNode, sourcefile);
}

function createDeclaration(node: SyntaxNode, opts: Record<string, any>): any {
    const sourcefile = opts?.sourcefile as string | undefined;
    const typeNode = node.childForFieldName('type') || namedChild(node, 0);
    const typeOnlyDefinition = createTypeDefinition(typeNode, opts);
    const declarators = node.namedChildren.filter((child) => child !== typeNode);

    if (declarators.length === 0) {
        return typeOnlyDefinition || appendNodeMeta(UAST.noop(), node, sourcefile);
    }

    const declarations = declarators.map((declNode) => {
        const declarator = declNode.type === 'init_declarator'
            ? declNode.childForFieldName('declarator') || namedChild(declNode, 0)
            : declNode;
        const valueNode = declNode.childForFieldName('value') || (declNode.type === 'init_declarator' ? namedChild(declNode, 1) : null);
        const nameNode = declaratorName(declarator);
        const id = cIdentifier(nameNode ? nameNode.text : '_', nameNode || declNode, sourcefile);
        const init = valueNode ? visit(valueNode, opts) as UAST.Expression : null;
        const varType = applyDeclaratorType(mapTypeSpecifier(typeNode, opts), declarator, opts);
        const varDecl = UAST.variableDeclaration(id, init, false, varType);
        if (!nameNode) varDecl._meta.unnamed = true;
        return appendNodeMeta(varDecl, declNode, sourcefile);
    });

    const all = typeOnlyDefinition ? [typeOnlyDefinition, ...declarations] : declarations;
    if (all.length === 1) return all[0];
    return appendNodeMeta(UAST.sequence(all), node, sourcefile);
}

function createTypeDefinition(node: SyntaxNode | null | undefined, opts: Record<string, any>): any {
    const sourcefile = opts?.sourcefile as string | undefined;
    if (!node || !['struct_specifier', 'union_specifier', 'enum_specifier'].includes(node.type)) {
        return null;
    }
    const bodyNode = node.childForFieldName('body') || node.namedChildren.find((c) => c.type.endsWith('declaration_list'));
    if (!bodyNode) return null;

    const nameNode = node.childForFieldName('name') || node.namedChildren.find((c) => c.type === 'type_identifier');
    const id = cIdentifier(nameNode ? nameNode.text : `anonymous_${node.type.replace('_specifier', '')}`, nameNode || node, sourcefile);
    const body = flattenInstructions(visitList(bodyNode.namedChildren, opts));
    const cdef = UAST.classDefinition(id, body, []);
    cdef._meta.kind = node.type.replace('_specifier', '');
    return appendNodeMeta(cdef, node, sourcefile);
}

function createFunction(node: SyntaxNode, opts: Record<string, any>): UAST.FunctionDefinition {
    const sourcefile = opts?.sourcefile as string | undefined;
    const typeNode = node.childForFieldName('type') || namedChild(node, 0);
    const declarator = node.childForFieldName('declarator') || node.namedChildren.find((child) => child.type.endsWith('declarator'));
    const nameNode = declaratorName(declarator);
    const id = nameNode ? cIdentifier(nameNode.text, nameNode, sourcefile) : null;
    const paramsNode = declarator?.childForFieldName('parameters') || declarator?.namedChildren.find((c) => c.type === 'parameter_list');
    const parameters = paramsNode
        ? paramsNode.namedChildren
            .filter((p) => p.type === 'parameter_declaration')
            .map((p) => createParameter(p, opts))
        : [];
    const bodyNode = node.childForFieldName('body') || node.namedChildren.find((child) => child.type === 'compound_statement');
    const body = bodyNode ? visit(bodyNode, opts) as UAST.Instruction : appendNodeMeta(UAST.scopedStatement([]), node, sourcefile);
    const fdef = UAST.functionDefinition(id, parameters, returnTypeFromFunction(typeNode, declarator || null, opts), body, []);
    return appendNodeMeta(fdef, node, sourcefile);
}

function literalFromText(node: SyntaxNode, sourcefile?: string): UAST.Literal {
    const text = node.text;
    if (node.type === 'string_literal') {
        return appendNodeMeta(UAST.literal(text.replace(/^u8|^u|^U|^L/, '').replace(/^"|"$/g, ''), 'string'), node, sourcefile);
    }
    if (node.type === 'char_literal') {
        return appendNodeMeta(UAST.literal(text.replace(/^L?'/, '').replace(/'$/g, ''), 'string'), node, sourcefile);
    }
    if (/^(true|false)$/i.test(text)) {
        return appendNodeMeta(UAST.literal(text.toLowerCase() === 'true', 'boolean'), node, sourcefile);
    }
    const numeric = Number(text.replace(/[uUlLfF]+$/g, ''));
    return appendNodeMeta(UAST.literal(Number.isNaN(numeric) ? text : numeric, Number.isNaN(numeric) ? 'string' : 'number'), node, sourcefile);
}

function expressionOrNoop(node: SyntaxNode | null | undefined, opts: Record<string, any>): UAST.Expression {
    const sourcefile = opts?.sourcefile as string | undefined;
    return node ? visit(node, opts) as UAST.Expression : appendNodeMeta(UAST.noop(), node || null, sourcefile) as any;
}

function visit(node: SyntaxNode | null | undefined, opts: Record<string, any>): any {
    if (!node) return null;

    const sourcefile = opts?.sourcefile as string | undefined;

    switch (node.type) {
        case 'translation_unit': {
            const body = flattenInstructions(visitList(node.namedChildren, opts));
            // NOTE: uast-spec 0.2.x 的 compileUnit() 在 builder() 里做运行时校验，
            // language 字段只接受 'javascript'|'typescript'|'java'|'golang'|'python'|'php'，
            // 不认 'c'。因此先传合法值通过运行时校验，再手动修正为 'c'。
            // 待上游 uast-spec 将 'c' 加入合法语言枚举后可移除此 workaround。
            const compileUnit = UAST.compileUnit(body, 'php' as any, 'c11', sourcefile || '', version);
            (compileUnit as any).language = 'c';
            return appendNodeMeta(compileUnit, node, sourcefile);
        }

        case 'comment':
            return null;

        case 'identifier':
        case 'field_identifier':
        case 'type_identifier':
            return cIdentifier(node.text, node, sourcefile);

        case 'number_literal':
        case 'string_literal':
        case 'char_literal':
            return literalFromText(node, sourcefile);

        case 'true':
        case 'false':
            return appendNodeMeta(UAST.literal(node.type === 'true', 'boolean'), node, sourcefile);

        case 'null':
            return appendNodeMeta(UAST.literal(null, 'null'), node, sourcefile);

        case 'parenthesized_expression':
            return expressionOrNoop(namedChild(node, 0), opts);

        case 'expression_statement': {
            const child = namedChild(node, 0);
            if (!child) return appendNodeMeta(UAST.noop(), node, sourcefile);
            const expr = visit(child, opts);
            if (expr && UAST.isNode(expr) && !UAST.isExpression(expr)) return appendNodeMeta(expr, node, sourcefile);
            return appendNodeMeta(UAST.expressionStatement(expr as UAST.Expression), node, sourcefile);
        }

        case 'compound_statement': {
            const body = flattenInstructions(visitList(node.namedChildren, opts));
            return appendNodeMeta(UAST.scopedStatement(body), node, sourcefile);
        }

        case 'function_definition':
            return createFunction(node, opts);

        case 'declaration':
        case 'field_declaration':
        case 'parameter_declaration':
            return node.type === 'parameter_declaration' ? createParameter(node, opts) : createDeclaration(node, opts);

        case 'preproc_include': {
            const pathNode = node.childForFieldName('path') || namedChild(node, 0);
            const raw = pathNode ? pathNode.text : '';
            const from = UAST.literal(raw.replace(/^["<]|[">]$/g, ''), 'string');
            appendNodeMeta(from, pathNode || node, sourcefile);
            const imp = UAST.importExpression(from);
            imp._meta.raw = node.text;
            imp._meta.system = raw.startsWith('<');
            return appendNodeMeta(imp, node, sourcefile);
        }

        case 'preproc_def':
        case 'preproc_function_def':
        case 'preproc_if':
        case 'preproc_ifdef':
        case 'preproc_else':
        case 'preproc_elif':
        case 'preproc_call': {
            const noop = UAST.noop();
            noop._meta.preprocessor = {
                kind: node.type,
                raw: node.text,
            };
            return appendNodeMeta(noop, node, sourcefile);
        }

        case 'if_statement': {
            const test = expressionOrNoop(node.childForFieldName('condition') || namedChild(node, 0), opts);
            const consequent = visit(node.childForFieldName('consequence') || namedChild(node, 1), opts) as UAST.Instruction || UAST.scopedStatement([]);
            const altNode = node.childForFieldName('alternative');
            const alternative = altNode ? visit(altNode, opts) as UAST.Instruction : null;
            return appendNodeMeta(UAST.ifStatement(test, consequent, alternative), node, sourcefile);
        }

        case 'else_clause':
            return visit(namedChild(node, 0), opts);

        case 'for_statement': {
            const initNode = node.childForFieldName('initializer');
            const testNode = node.childForFieldName('condition');
            const updateNode = node.childForFieldName('update');
            const bodyNode = node.childForFieldName('body') || node.namedChildren.find((child) => child.type.endsWith('statement'));
            const init = initNode ? visit(initNode, opts) as UAST.Expression | UAST.VariableDeclaration : null;
            const test = testNode ? visit(testNode, opts) as UAST.Expression : null;
            const update = updateNode ? visit(updateNode, opts) as UAST.Expression : null;
            const body = bodyNode ? visit(bodyNode, opts) as UAST.Instruction : UAST.scopedStatement([]);
            return appendNodeMeta(UAST.forStatement(init, test, update, body), node, sourcefile);
        }

        case 'while_statement': {
            const test = expressionOrNoop(node.childForFieldName('condition') || namedChild(node, 0), opts);
            const body = visit(node.childForFieldName('body') || namedChild(node, 1), opts) as UAST.Instruction || UAST.scopedStatement([]);
            return appendNodeMeta(UAST.whileStatement(test, body, false), node, sourcefile);
        }

        case 'do_statement': {
            const body = visit(node.childForFieldName('body') || namedChild(node, 0), opts) as UAST.Instruction || UAST.scopedStatement([]);
            const test = expressionOrNoop(node.childForFieldName('condition') || namedChild(node, 1), opts);
            return appendNodeMeta(UAST.whileStatement(test, body, true), node, sourcefile);
        }

        case 'switch_statement': {
            const discriminant = expressionOrNoop(node.childForFieldName('condition') || namedChild(node, 0), opts);
            const bodyNode = node.childForFieldName('body') || node.namedChildren.find((child) => child.type === 'compound_statement');
            const cases = bodyNode
                ? bodyNode.namedChildren.filter((child) => child.type === 'case_statement').map((child) => visit(child, opts))
                : [];
            return appendNodeMeta(UAST.switchStatement(discriminant, cases), node, sourcefile);
        }

        case 'case_statement': {
            const valueNode = node.childForFieldName('value') || (node.child(0)?.text === 'default' ? null : namedChild(node, 0));
            const test = valueNode ? visit(valueNode, opts) as UAST.Expression : null;
            const bodyChildren = valueNode ? node.namedChildren.slice(1) : node.namedChildren;
            const body = appendNodeMeta(UAST.scopedStatement(flattenInstructions(visitList(bodyChildren, opts))), node, sourcefile);
            return appendNodeMeta(UAST.caseClause(test, body), node, sourcefile);
        }

        case 'return_statement': {
            const argument = namedChild(node, 0) ? visit(namedChild(node, 0), opts) as UAST.Expression : null;
            return appendNodeMeta(UAST.returnStatement(argument), node, sourcefile);
        }

        case 'break_statement':
            return appendNodeMeta(UAST.breakStatement(), node, sourcefile);

        case 'continue_statement':
            return appendNodeMeta(UAST.continueStatement(), node, sourcefile);

        case 'labeled_statement': {
            const labelNode = node.childForFieldName('label') || namedChild(node, 0);
            const bodyNode = node.childForFieldName('body') || namedChild(node, 1);
            return appendNodeMeta(UAST.labeledStatement(cIdentifier(labelNode ? labelNode.text : '_', labelNode || node, sourcefile), visit(bodyNode, opts) || UAST.noop()), node, sourcefile);
        }

        case 'goto_statement': {
            const noop = UAST.noop();
            noop._meta.goto = namedChild(node, 0)?.text || null;
            return appendNodeMeta(noop, node, sourcefile);
        }

        case 'binary_expression': {
            const left = expressionOrNoop(node.childForFieldName('left') || namedChild(node, 0), opts);
            const right = expressionOrNoop(node.childForFieldName('right') || namedChild(node, 1), opts);
            return appendNodeMeta(UAST.binaryExpression((getOperator(node) || '+') as any, left, right), node, sourcefile);
        }

        case 'assignment_expression': {
            const left = expressionOrNoop(node.childForFieldName('left') || namedChild(node, 0), opts) as UAST.LVal;
            const right = expressionOrNoop(node.childForFieldName('right') || namedChild(node, 1), opts);
            return appendNodeMeta(UAST.assignmentExpression(left, right, (getOperator(node) || '=') as any, false), node, sourcefile);
        }

        case 'conditional_expression': {
            const test = expressionOrNoop(node.childForFieldName('condition') || namedChild(node, 0), opts);
            const consequent = expressionOrNoop(node.childForFieldName('consequence') || namedChild(node, 1), opts);
            const alternative = expressionOrNoop(node.childForFieldName('alternative') || namedChild(node, 2), opts);
            return appendNodeMeta(UAST.conditionalExpression(test, consequent, alternative), node, sourcefile);
        }

        case 'unary_expression':
        case 'sizeof_expression': {
            const op = node.type === 'sizeof_expression' ? 'sizeof' : getOperator(node);
            const expr = expressionOrNoop(firstNamedExcept(node, ['primitive_type', 'type_identifier']) || namedChild(node, 0), opts);
            if (op === 'sizeof') {
                const call = UAST.callExpression(cIdentifier('sizeof', node, sourcefile), [expr]);
                return appendNodeMeta(call, node, sourcefile);
            }
            return appendNodeMeta(UAST.unaryExpression((op || '+') as any, expr, false), node, sourcefile);
        }

        case 'update_expression': {
            const first = node.child(0);
            const isSuffix = !!first?.isNamed;
            const expr = expressionOrNoop(namedChild(node, 0), opts);
            return appendNodeMeta(UAST.unaryExpression((getOperator(node) || '++') as any, expr, isSuffix), node, sourcefile);
        }

        case 'pointer_expression': {
            const op = getOperator(node);
            const argument = expressionOrNoop(node.childForFieldName('argument') || namedChild(node, 0), opts);
            if (op === '&') return appendNodeMeta(UAST.referenceExpression(argument), node, sourcefile);
            return appendNodeMeta(UAST.dereferenceExpression(argument), node, sourcefile);
        }

        case 'cast_expression': {
            const typeNode = node.childForFieldName('type') || namedChild(node, 0);
            const valueNode = node.childForFieldName('value') || namedChild(node, 1);
            return appendNodeMeta(UAST.castExpression(expressionOrNoop(valueNode, opts), mapTypeSpecifier(typeNode, opts)), node, sourcefile);
        }

        case 'call_expression': {
            const callee = expressionOrNoop(node.childForFieldName('function') || namedChild(node, 0), opts);
            const argsNode = node.childForFieldName('arguments') || node.namedChildren.find((child) => child.type === 'argument_list');
            const args = argsNode ? visitList(argsNode.namedChildren, opts) as Array<UAST.Expression> : [];
            return appendNodeMeta(UAST.callExpression(callee, args), node, sourcefile);
        }

        case 'argument_list':
            return appendNodeMeta(UAST.tupleExpression(visitList(node.namedChildren, opts)), node, sourcefile);

        case 'field_expression': {
            const object = expressionOrNoop(node.childForFieldName('argument') || namedChild(node, 0), opts);
            const field = expressionOrNoop(node.childForFieldName('field') || node.namedChildren[node.namedChildren.length - 1], opts);
            const member = UAST.memberAccess(object, field, false);
            member._meta.operator = node.text.includes('->') ? '->' : '.';
            return appendNodeMeta(member, node, sourcefile);
        }

        case 'subscript_expression': {
            const object = expressionOrNoop(node.childForFieldName('argument') || namedChild(node, 0), opts);
            const index = expressionOrNoop(node.childForFieldName('index') || namedChild(node, 1), opts);
            return appendNodeMeta(UAST.memberAccess(object, index, true), node, sourcefile);
        }

        case 'comma_expression': {
            const items = visitList(node.namedChildren, opts);
            return appendNodeMeta(UAST.sequence(items), node, sourcefile);
        }

        case 'initializer_list': {
            const elements = visitList(node.namedChildren, opts) as Array<UAST.Expression>;
            const tuple = UAST.tupleExpression(elements);
            tuple._meta.initializerList = true;
            return appendNodeMeta(tuple, node, sourcefile);
        }

        case 'struct_specifier':
        case 'union_specifier':
        case 'enum_specifier':
            return createTypeDefinition(node, opts) || mapTypeSpecifier(node, opts);

        case 'empty_statement':
            return appendNodeMeta(UAST.noop(), node, sourcefile);

        default: {
            if (node.namedChildren.length === 1) {
                return visit(node.namedChildren[0], opts);
            }
            const noop = UAST.noop();
            noop._meta.unhandled = {
                kind: node.type,
                raw: node.text,
            };
            return appendNodeMeta(noop, node, sourcefile);
        }
    }
}

export function parse(content: string, opts: Record<string, any> = {}): UAST.Node {
    const tree = getParser().parse(content);
    return visit(tree.rootNode, opts);
}

import 'mocha';
import * as assert from 'assert';
import { init, parse } from '../src/parser';

describe('benchmark for c', () => {
    before(async () => {
        await init();
    });

    it('parses functions, declarations and control flow', () => {
        const ast: any = parse(`
            #include <stdio.h>

            int add(int a, int b) {
                int c = a + b;
                if (c > 0) {
                    return c;
                }
                return 0;
            }
        `, { sourcefile: 'basic.c' });

        assert.strictEqual(ast.type, 'CompileUnit');
        assert.strictEqual(ast.language, 'c');
        assert.ok(ast.body.some((node: any) => node.type === 'ImportExpression'));

        const fn = ast.body.find((node: any) => node.type === 'FunctionDefinition');
        assert.ok(fn);
        assert.strictEqual(fn.id.name, 'add');
        assert.strictEqual(fn.parameters.length, 2);
        assert.ok(fn.body.body.some((node: any) => node.type === 'VariableDeclaration'));
        assert.ok(fn.body.body.some((node: any) => node.type === 'IfStatement'));
    });

    it('parses pointers, calls, arrays and members', () => {
        const ast: any = parse(`
            struct Item { int value; };

            int read(struct Item *item, int xs[4]) {
                int *p = &xs[0];
                return item->value + *p;
            }
        `, { sourcefile: 'pointers.c' });

        const fn = ast.body.find((node: any) => node.type === 'FunctionDefinition');
        assert.ok(fn);
        assert.strictEqual(fn.parameters.length, 2);
        assert.strictEqual(fn.parameters[0].varType.type, 'PointerType');
        assert.strictEqual(fn.parameters[1].varType.type, 'ArrayType');
    });
});

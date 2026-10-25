import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import { init, parse } from '../src/parser';

function findFunctionCalls(ast: any): string[] {
    const fns: string[] = [];
    function walk(n: any) {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'CallExpression' && n.callee?.name) fns.push(n.callee.name);
        if (n.type === 'FunctionDefinition') fns.push('fn:' + n.id?.name);
        for (const k in n) {
            if (k === 'parent' || k === 'loc' || k === '_meta') continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (typeof v === 'object') walk(v);
        }
    }
    walk(ast);
    return [...new Set(fns)].sort();
}

function findNoops(ast: any): any[] {
    const noops: any[] = [];
    function walk(n: any) {
        if (!n || typeof n !== 'object') return;
        if (n._meta?.unhandled) noops.push(n);
        for (const k in n) {
            if (k === 'parent' || k === 'loc' || k === '_meta') continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (typeof v === 'object') walk(v);
        }
    }
    walk(ast);
    return noops;
}

describe('expanded C rules verification', () => {
    let ast: any;

    before(async () => {
        await init();
        const code = fs.readFileSync(
            '/home/dys1013/projects/yasa-rule-optimizer/ma_yisheng/test-c-cases/vulnerable.c',
            'utf8'
        );
        ast = parse(code, { sourcefile: 'vulnerable.c' });
    });

    it('recognizes all 4 vulnerability scenarios', () => {
        const fns = findFunctionCalls(ast);
        console.log('\n  函数调用:', fns.join(', '));

        // 四个场景的关键函数
        assert.ok(fns.includes('getenv'), '场景1: getenv (source)');
        assert.ok(fns.includes('system'), '场景1: system (sink)');
        assert.ok(fns.includes('fgets'), '场景2: fgets (source)');
        assert.ok(fns.includes('printf'), '场景2: printf (sink)');
        assert.ok(fns.includes('recv'), '场景3: recv (source)');
        assert.ok(fns.includes('memcpy'), '场景3: memcpy (sink)');
        assert.ok(fns.includes('execl'), '场景4: execl (sink)');

        // 四个函数定义
        assert.ok(fns.includes('fn:test_command_injection'));
        assert.ok(fns.includes('fn:test_format_string'));
        assert.ok(fns.includes('fn:test_buffer_overflow'));
        assert.ok(fns.includes('fn:test_exec_family'));
    });

    it('has no unhandled syntax nodes', () => {
        const noops = findNoops(ast);
        if (noops.length > 0) {
            console.log('\n  未处理节点:');
            noops.forEach(n => console.log('    -', n._meta.unhandled.kind, ':', n._meta.unhandled.raw?.substring(0, 50)));
        }
        assert.strictEqual(noops.length, 0, 'All C syntax should be handled');
    });
});

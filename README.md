# @ant-yasa/uast-parser-c

Converts C source code into YASA UAST.

This parser follows the same shape as `parser-PHP`: `web-tree-sitter` parses C syntax and a visitor maps tree-sitter nodes into `@ant-yasa/uast-spec` nodes.

## Current coverage

- Translation units, functions, parameter declarations.
- Local and global variable declarations.
- Primitive, pointer, array, function, struct/union/enum-ish types.
- Blocks, if/switch/case, for/while/do, return/break/continue/goto/labels.
- Binary, assignment, unary/update, cast, conditional, call, member, subscript, address-of and dereference expressions.
- `#include` as `ImportExpression`; other preprocessor directives are preserved as `Noop._meta`.

## Usage

```ts
import { Parser } from '@ant-yasa/uast-parser-c';

const parser = new Parser({ sourcefile: 'example.c' });
await parser.init();
const ast = parser.parse('int add(int a, int b) { return a + b; }');
```

## Development

```bash
npm install
npm test
npm run build
```

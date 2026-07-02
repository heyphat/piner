/**
 * Point the CJS node adapter at the CJS core.
 *
 * `build:node:cjs` keeps the core `require("./index.js")` EXTERNAL (via `--external
 * "*​/index.js"`) so `dist/node.cjs` shares one copy of every class/singleton
 * (CompileError, Engine, the NA sentinel, …) with the main `.` entry instead of
 * inlining a second — otherwise `err instanceof CompileError` is false across the two
 * entries and structured diagnostics are silently dropped. In CommonJS the sibling
 * core file is `index.cjs`, so rewrite the single specifier from the ESM `.js` name.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../dist/node.cjs', import.meta.url);
const src = readFileSync(file, 'utf8');
const out = src.replace(/require\("\.\/index\.js"\)/g, 'require("./index.cjs")');
if (out === src) {
  throw new Error('postbuild-node-cjs: expected require("./index.js") in dist/node.cjs — did the build/external flag change?');
}
writeFileSync(file, out);

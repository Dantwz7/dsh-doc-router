#!/usr/bin/env node
/**
 * Regenerate the test fixtures by locating a usable Python interpreter with the
 * plugin's own discovery logic (`resolvePython`) and running
 * `tests/fixtures/generate.py`.
 *
 * Reusing `resolvePython` rather than calling `python` directly is deliberate:
 * on Windows a bare `python` is frequently the Microsoft Store stub (exit code
 * 9009, no output), and inside a DSH install the interpreter that actually has
 * PyMuPDF is the packaged runtime. This way `npm run fixtures` behaves the same
 * as the plugin does at runtime, and dogfoods the discovery path.
 *
 * Usage: node scripts/generate-fixtures.mjs [--no-check] [--gap-lines N]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolvePython } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const script = join(repoRoot, 'tests', 'fixtures', 'generate.py');

const python = resolvePython({ timeoutMs: 0, maxChars: 0 });
console.error(`[fixtures] using interpreter: ${python}`);

const child = spawn(python, [script, ...process.argv.slice(2)], {
    stdio: 'inherit',
    // PYTHONDONTWRITEBYTECODE: `generate.py` sets `sys.dont_write_bytecode` itself,
    // but a module's own flag cannot stop *its own* `.pyc` — the bytecode is written
    // when the module is compiled, before its body runs. The flag therefore has to
    // come from the runner. It is harmless here (a script run directly is never
    // cached) and load-bearing for anything that *imports* the fixture module.
    env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
    },
});

child.on('error', (error) => {
    console.error(
        `[fixtures] could not start "${python}": ${error.message}\n` +
            '[fixtures] set DOC_ROUTER_PYTHON to a Python with PyMuPDF installed.',
    );
    process.exit(2);
});

child.on('exit', (code, signal) => {
    if (signal !== null) {
        console.error(`[fixtures] interpreter terminated by ${signal}`);
        process.exit(1);
    }
    process.exit(code ?? 1);
});

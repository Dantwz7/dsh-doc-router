/**
 * Shared test utilities: fixture paths, a fake Cordis context, and interpreter
 * detection for the integration tests.
 *
 * Not a test file itself — the `node --test "tests/*.test.mjs"` glob only picks
 * up `*.test.mjs`, so helpers and stubs are never mistaken for tests.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePython } from '../lib/index.js';
import * as plugin from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Environment for every Python child this suite starts.
 *
 * `PYTHONDONTWRITEBYTECODE` is set by the *runner* on purpose. A module that sets
 * `sys.dont_write_bytecode = True` in its own body still gets a `.pyc` for itself,
 * because compilation happens before the body runs; only the parent process can
 * prevent it. Without this, importing `tests/fixtures/generate.py` left a stray
 * `tests/fixtures/__pycache__/` in the working tree.
 */
const PY_ENV = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
};

/** Repository root. */
export const repoRoot = resolve(here, '..');
/** Directory holding the synthetic fixtures. */
export const fixturesDir = join(here, 'fixtures');
/** Absolute path to the probe script under test. */
export const probeScript = join(repoRoot, 'lib', 'docprobe.py');

/** Absolute path to a fixture by file name. */
export function fixture(name) {
    return join(fixturesDir, name);
}

/** Validated configuration with DSH's own defaults applied. */
export function defaultConfig() {
    return plugin.Config({});
}

/**
 * A minimal fake of the Cordis context the plugin registers into.
 * `effect` runs its callback immediately and records the label, so a test can
 * assert that every registration is effect-scoped (and therefore cleaned up on
 * reload) rather than performed bare.
 */
export function makeCtx() {
    const tools = [];
    const skills = [];
    const effectLabels = [];
    const ctx = {
        effect(fn, label) {
            effectLabels.push(label);
            return fn();
        },
        tools: {
            register(tool) {
                tools.push(tool);
                return () => {};
            },
        },
        get(key) {
            if (key === 'skills') {
                return {
                    register(skill) {
                        skills.push(skill);
                        return () => {};
                    },
                };
            }
            // No `fs` / `sandboxPolicy` seam: the plugin must fall back to its
            // own existsSync path resolution, which is what these tests cover.
            return undefined;
        },
    };
    return { ctx, tools, skills, effectLabels };
}

/**
 * Load the plugin against a fake context.
 * @param config - optional configuration; defaults to `Config({})`.
 * @param options.withSkills - set false to model a composition without the
 *   skills registry, where the plugin must still load.
 */
export function loadPlugin(config = defaultConfig(), { withSkills = true } = {}) {
    const state = makeCtx();
    if (!withSkills) {
        state.ctx.get = (key) => (key === 'skills' ? undefined : undefined);
    }
    plugin.apply(state.ctx, config);
    return { ...state, plugin };
}

/** Tool execution context: a session cwd plus a cancellation signal. */
export function makeExec(cwd = fixturesDir) {
    return { signal: undefined, agent: { session: { header: { cwd } } } };
}

/** Look up a registered tool by name, failing loudly if it is absent. */
export function toolNamed(state, name) {
    const tool = state.tools.find((t) => t.name === name);
    if (tool === undefined) {
        throw new Error(`tool not registered: ${name} (have: ${state.tools.map((t) => t.name).join(', ')})`);
    }
    return tool;
}

let cached;

/**
 * Find an interpreter that can import PyMuPDF and pymupdf4llm.
 *
 * Returns `{ python, available, reason }`. Skips only on *absence*
 * (no interpreter, or the modules are missing). A spawn failure such as EPERM —
 * which is what the DSH file sandbox raises for piped child stdio — is rethrown,
 * because that is an environment problem the caller must see rather than a
 * reason to silently pass.
 */
export function probeInterpreter() {
    if (cached !== undefined) return cached;

    const python =
        process.env.DOC_ROUTER_PYTHON ??
        resolvePython({ timeoutMs: 0, maxChars: 0 });

    const env = PY_ENV;
    const result = spawnSync(python, ['-c', 'import pymupdf, pymupdf4llm'], {
        encoding: 'utf8',
        env,
    });

    if (result.error !== undefined) {
        const code = result.error.code;
        if (code === 'ENOENT') {
            cached = {
                python,
                available: false,
                reason: `interpreter not found: ${python}`,
            };
            return cached;
        }
        throw result.error;
    }

    if (result.status !== 0) {
        cached = {
            python,
            available: false,
            reason:
                `PyMuPDF/pymupdf4llm not importable via ${python}: ` +
                `${(result.stderr ?? '').trim().split('\n').pop() ?? 'unknown error'}`,
        };
        return cached;
    }

    cached = { python, available: true, reason: 'ok' };
    return cached;
}

/** Run `lib/docprobe.py` directly, exactly as the plugin does. */
export function runProbe(python, args) {
    return spawnSync(python, [probeScript, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: PY_ENV,
    });
}

/**
 * Assert that a converted multi-column page did not come back "shredded".
 *
 * A naive converter rebuilds a multi-column page as a markdown **table**. Measured
 * on `two-column.pdf`: MarkItDown emits 24 `| --- |` separator rows and averages 43
 * characters per non-blank line; `pdf_markdown` emits none and averages 283. The
 * average also catches fragmentation *without* a table (a word or two per line),
 * which a table-only check would miss.
 *
 * `assert` is passed in so this stays a helper rather than a second test file —
 * the `tests/*.test.mjs` glob must not pick it up.
 */
export function assertNotShredded(assert, markdown, { label = 'markdown' } = {}) {
    const tableRows = markdown.match(/^\s*\|/gm) ?? [];
    assert.equal(
        tableRows.length,
        0,
        `${label} came back as a markdown table (${tableRows.length} table row(s)); ` +
            'a two-column prose page must stay prose',
    );
    const nonBlank = markdown.split('\n').filter((line) => line.trim() !== '');
    const avg = markdown.length / Math.max(1, nonBlank.length);
    assert.ok(
        avg > 100,
        `${label} looks shredded: ${Math.round(avg)} chars per non-blank line ` +
            '(pdf_markdown measures 283 on this fixture, MarkItDown 43)',
    );
}

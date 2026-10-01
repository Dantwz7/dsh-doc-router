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

    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
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
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
}

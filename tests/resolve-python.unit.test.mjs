/**
 * Interpreter-discovery tests.
 *
 * The original bug this guards: the DSH host process has no `DSH_*` variables
 * (`dsh-shell-env` injects them per shell call), so the first version fell back
 * to a bare `python`, which on Windows is frequently the Microsoft Store stub
 * (exit code 9009, no output). Every test here is spawn-free and portable, so
 * it runs under the DSH file sandbox and on any CI runner.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { dshHomeFromOwnPath, resolvePython } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const TMP = join(here, '.tmp');

/** Every return value must be usable: a bare command name, or a real file. */
function assertUsable(chosen, message) {
    assert.equal(typeof chosen, 'string', message);
    assert.notEqual(chosen.trim(), '', message);
    const isBareCommand = !chosen.includes('/') && !chosen.includes('\\');
    assert.ok(
        isBareCommand || existsSync(chosen),
        `${message}: "${chosen}" is neither a bare command nor an existing file`,
    );
}

/** Run a callback with the DSH_* variables removed, then restore them. */
function withoutDshEnv(callback) {
    const saved = {};
    const keys = ['DSH_HOME', 'DSH_PRIMARY_RUNTIME', 'DSH_BUNDLED_PRIMARY_RUNTIME', 'DOC_ROUTER_PYTHON'];
    for (const key of keys) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    try {
        return callback();
    } finally {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

test('an explicit pythonPath wins unconditionally, even as a bare command', async () => {
    withoutDshEnv(() => {
        // A bare command name must survive: existsSync('python3') is false, so an
        // existence check here would silently discard the user's choice.
        assert.equal(resolvePython({ pythonPath: 'python3' }), 'python3');
        assert.equal(resolvePython({ pythonPath: process.execPath }), process.execPath);
        // A path that does not exist is still honoured: failing loudly with the
        // interpreter you asked for beats silently running a different one.
        const missing = join(TMP, 'no-such-python');
        assert.equal(resolvePython({ pythonPath: missing }), missing);
    });
});

test('DOC_ROUTER_PYTHON is used when config does not name an interpreter', async () => {
    withoutDshEnv(() => {
        process.env.DOC_ROUTER_PYTHON = 'python3.12';
        assert.equal(resolvePython({}), 'python3.12');
        // config.pythonPath is the more specific setting, so it takes precedence.
        assert.equal(resolvePython({ pythonPath: 'explicit' }), 'explicit');
    });
});

test('discovery never returns an empty string and always yields something usable', async () => {
    withoutDshEnv(() => {
        assertUsable(resolvePython({}), 'auto-discovered interpreter');
    });
});

test('a DSH_HOME runtime is discovered by scanning dsh-runtimes', async () => {
    // Build a fake harness home: $DSH_HOME/dsh-runtimes/<name>/dependencies/python/<bin>
    const home = join(TMP, 'fake-home');
    const name = process.platform === 'win32' ? 'python.exe' : 'bin/python3';
    const interpreter = join(home, 'dsh-runtimes', 'some-renamed-runtime', 'dependencies', 'python', name);
    mkdirSync(dirname(interpreter), { recursive: true });
    writeFileSync(interpreter, '');

    try {
        withoutDshEnv(() => {
            process.env.DSH_HOME = home;
            assert.equal(
                resolvePython({}),
                interpreter,
                'the runtime directory name is an implementation detail; scanning must find it',
            );
        });
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('a bogus DSH_HOME falls through instead of winning', async () => {
    withoutDshEnv(() => {
        process.env.DSH_HOME = join(TMP, 'definitely-not-a-real-dsh-home');
        assertUsable(resolvePython({}), 'fallback after a bogus DSH_HOME');
    });
});

test('dshHomeFromOwnPath returns the harness home or nothing at all', async () => {
    const home = dshHomeFromOwnPath();
    if (home === undefined) {
        // Running from a plain checkout: there is no `profiles` ancestor, and
        // that must be reported as "unknown", never as a wrong guess.
        return;
    }
    assert.ok(
        existsSync(join(home, 'profiles')),
        `derived home must actually contain profiles/: ${home}`,
    );
});

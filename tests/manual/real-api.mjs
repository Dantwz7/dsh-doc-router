/**
 * Drives the plugin against the REAL `@deepseek-ai/dsh-tools` `defineTool` and
 * the real schemastery, loaded out of the DSH `app.asar`.
 *
 * Why this exists: the stub-based unit tests prove the plugin *registers* the
 * right things, but not that the real implementation *accepts* them. A schema
 * the real schemastery rejects throws at load time, which during a cold host
 * start is a failed startup — not a failed tool call. This script reproduces
 * that load-time surface outside the host.
 *
 * Run it with Electron-as-node (plain Node cannot read inside an asar):
 *
 *     $env:ELECTRON_RUN_AS_NODE='1'
 *     & '<DeepSeek Harness.exe>' --expose-internals ./tests/manual/real-api.mjs
 *
 * Electron is a GUI-subsystem binary, so its stdout is not reliably capturable:
 * the result is also written to tests/.tmp/real-api.log. Exit code is 0 on
 * success and 1 on failure, so it can be used as a gate.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Register the resolver that points the plugin's bare @deepseek-ai imports at
// the real packages inside app.asar. Must happen before the plugin is imported.
register('./real-loader.mjs', import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(here, '..', '.tmp');
const LOG = join(LOG_DIR, 'real-api.log');

const lines = [];
const say = (text) => {
    lines.push(text);
    try {
        console.log(text);
    } catch {
        /* stdout may be unusable under Electron-as-node */
    }
};

say('=== real-api probe start ===');
say(`node: ${process.version}  electron: ${process.versions.electron ?? '(none)'}`);

let failed = false;
try {
    const plugin = await import('../../lib/index.js');
    say(`exports        : ${Object.keys(plugin).sort().join(', ')}`);
    say(`name           : ${plugin.name}`);
    say(`inject         : ${JSON.stringify(plugin.inject)}`);
    say(`Config present : ${plugin.Config !== undefined}`);

    // 1. Does the real schemastery accept the Config schema with an empty
    //    config? A missing-but-required field would throw here, at load time.
    let config;
    try {
        config = plugin.Config({});
        say(`Config({})     : OK -> ${JSON.stringify(config)}`);
    } catch (error) {
        say(`Config({})     : THREW -> ${error.message}`);
        failed = true;
        config = { timeoutMs: 120_000, maxChars: 120_000 };
    }

    // 2. Does the real defineTool accept both tool definitions?
    const tools = [];
    const skills = [];
    const ctx = {
        effect(fn) {
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
            return undefined;
        },
    };

    try {
        plugin.apply(ctx, config);
        say('apply()        : OK');
    } catch (error) {
        say(`apply()        : THREW -> ${error.stack}`);
        failed = true;
    }

    say(`registered     : ${tools.map((t) => t.name).join(', ')}`);
    for (const tool of tools) {
        say(
            `  ${tool.name}: timeoutMs=${tool.timeoutMs} execute=${typeof tool.execute} ` +
                `presentCall=${typeof tool.presentCall} outputSchema=${tool.output?.schema !== undefined} ` +
                `render=${typeof tool.output?.render}`,
        );
    }
    say(`skills         : ${skills.map((s) => `${s.name}(${s.source})`).join(', ')}`);

    if (tools.length !== 2) {
        say(`EXPECTED 2 TOOLS, GOT ${tools.length}`);
        failed = true;
    }
    if (skills.length !== 1) {
        say(`EXPECTED 1 SKILL, GOT ${skills.length}`);
        failed = true;
    }
} catch (error) {
    say(`IMPORT FAILED -> ${error.stack}`);
    failed = true;
}

say(failed ? '\nREAL-API TEST FAILED' : '\nREAL-API TEST PASSED');
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(LOG, lines.join('\n'), 'utf8');
process.exit(failed ? 1 : 0);

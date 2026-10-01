/**
 * Registration-level tests: what the plugin exports and what it registers.
 *
 * These run with stubbed `@deepseek-ai/*` imports, so they need no DSH install,
 * no `npm install`, and no network. What they cannot prove is that the *real*
 * `defineTool` and schemastery accept these definitions — that is the job of
 * `tests/manual/real-api.mjs`, which loads the real modules out of `app.asar`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig, loadPlugin, makeExec, repoRoot, toolNamed } from './helpers.mjs';

test('plugin identity matches the package name', async () => {
    const { plugin } = loadPlugin();
    assert.equal(plugin.name, 'dsh-doc-router');
    assert.deepEqual(plugin.inject, ['tools']);
    assert.equal(typeof plugin.apply, 'function');
});

test('Config applies the documented defaults and leaves pythonPath unset', async () => {
    const config = defaultConfig();
    assert.equal(config.timeoutMs, 120_000);
    assert.equal(config.maxChars, 120_000);
    assert.equal(config.pythonPath, undefined);
});

test('apply registers exactly the two tools and the runtime skill', async () => {
    const state = loadPlugin();

    assert.deepEqual(
        state.tools.map((t) => t.name).sort(),
        ['doc_route', 'pdf_markdown'],
    );
    assert.equal(state.skills.length, 1);
    assert.equal(state.skills[0].name, 'doc-routing');
    assert.equal(state.skills[0].source, 'runtime');
    assert.deepEqual(state.skills[0].invocation, {
        modelInvocable: true,
        userInvocable: true,
    });
});

test('every registration is effect-scoped so reload leaves nothing behind', async () => {
    const state = loadPlugin();
    // Two tools + one skill, each wrapped in ctx.effect.
    assert.equal(state.effectLabels.length, 3);
    for (const label of state.effectLabels) {
        assert.match(label, /^dsh-doc-router: /);
    }
});

test('the plugin still loads in a composition without a skills registry', async () => {
    const state = loadPlugin(defaultConfig(), { withSkills: false });
    assert.deepEqual(
        state.tools.map((t) => t.name).sort(),
        ['doc_route', 'pdf_markdown'],
    );
    assert.equal(state.skills.length, 0);
});

test('the skill tells the model to route before converting', async () => {
    const state = loadPlugin();
    const skill = state.skills[0];
    assert.ok(skill.description.length > 100, 'description is written for retrieval');
    assert.ok(skill.whenToUse.length > 50);
    assert.match(skill.content, /doc_route/);
    // The whole point of the plugin: do not reach for markitdown first.
    assert.match(skill.content, /不要凭习惯直接上/);
});

test('doc_route declares a required path and a fully-described output', async () => {
    const state = loadPlugin();
    const tool = toolNamed(state, 'doc_route');

    assert.equal(tool.parameters.path.required, true);
    assert.equal(tool.parameters.path.type, 'string');
    assert.equal(tool.output.schema.additionalProperties, false);
    for (const key of ['path', 'format', 'recommend']) {
        assert.equal(tool.output.schema.properties[key].required, true, `${key} required`);
    }
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.presentCall, 'function');
    // The tool timeout must leave room for the probe's own timeout.
    assert.ok(tool.timeoutMs > defaultConfig().timeoutMs);
});

test('pdf_markdown declares optional pages/output and a required result shape', async () => {
    const state = loadPlugin();
    const tool = toolNamed(state, 'pdf_markdown');

    assert.equal(tool.parameters.path.required, true);
    assert.equal(tool.parameters.pages.required, undefined);
    assert.equal(tool.parameters.output.required, undefined);
    for (const key of ['path', 'chars', 'pagesUsed', 'truncated']) {
        assert.equal(tool.output.schema.properties[key].required, true, `${key} required`);
    }
});

test('doc_route renders its routing verdict as text', async () => {
    const config = defaultConfig();
    const state = loadPlugin(config);
    const tool = toolNamed(state, 'doc_route');

    const blocks = tool.output.render(
        { path: 'paper.pdf' },
        {
            path: 'paper.pdf',
            format: 'pdf',
            recommend: ['pdf_markdown'],
            pages: 7,
            text_layer: true,
            columns: 'multi-column',
            column_estimate: 2,
            notes: 'two columns of body text',
            probe: '{"1":"0.92/2col"}',
        },
    );

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    const text = blocks[0].text;
    assert.match(text, /Routed paper\.pdf — format: pdf/);
    assert.match(text, /pages: 7/);
    assert.match(text, /text layer: yes/);
    assert.match(text, /columns: multi-column \(est 2\)/);
    assert.match(text, /Recommended pipeline: pdf_markdown/);
    assert.match(text, /two columns of body text/);
    assert.match(text, /Probe detail:/);
});

test('doc_route reports the version of the copy that is actually loaded', async () => {
    // A `file:` install is a copy and the host caches the loaded module, so a
    // stale copy is otherwise invisible. This is the only supported way to
    // answer "which version is running?" — and the bug-report template asks for
    // it, so it has to exist.
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const state = loadPlugin(defaultConfig());
    const tool = toolNamed(state, 'doc_route');

    const [block] = tool.output.render(
        { path: 'paper.pdf' },
        { path: 'paper.pdf', format: 'pdf', recommend: ['pdf_markdown'] },
    );

    assert.match(block.text, new RegExp(`dsh-doc-router v${manifest.version.replace(/\./g, '\\.')}`));
});

test('the reported version tracks package.json instead of being hardcoded', async () => {
    // Guards the drift this test exists to catch: a hand-written version string
    // would silently disagree with the manifest after the next release.
    const source = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8');
    assert.match(source, /readOwnVersion\(\)/, 'the version must be read from the manifest');
    assert.doesNotMatch(
        source,
        /PLUGIN_VERSION\s*=\s*['"]\d/,
        'PLUGIN_VERSION must not be a hardcoded literal',
    );
});

test('doc_route reports a missing text layer as a scan, not as an empty document', async () => {
    const state = loadPlugin();
    const tool = toolNamed(state, 'doc_route');
    const [block] = tool.output.render(
        { path: 'scan.pdf' },
        {
            path: 'scan.pdf',
            format: 'pdf',
            recommend: ['render_to_png + read_image'],
            text_layer: false,
        },
    );
    assert.match(block.text, /text layer: NO \(scanned\)/);
    // Optional fields must not leak "undefined" into the model's view.
    assert.doesNotMatch(block.text, /undefined/);
    assert.doesNotMatch(block.text, /columns:/);
});

test('pdf_markdown warns when it truncated instead of writing to disk', async () => {
    const config = defaultConfig();
    const state = loadPlugin(config);
    const tool = toolNamed(state, 'pdf_markdown');

    const [truncated] = tool.output.render(
        { path: 'big.pdf' },
        {
            path: 'big.pdf',
            chars: 500_000,
            pagesUsed: 'all 40 pages',
            truncated: true,
            markdown: '# Heading',
        },
    );
    assert.match(truncated.text, /Converted big\.pdf \(all 40 pages\) — 500000 characters/);
    assert.match(truncated.text, new RegExp(`truncated to ${config.maxChars} characters`));
    assert.match(truncated.text, /# Heading/);

    const [written] = tool.output.render(
        { path: 'big.pdf', output: 'out.md' },
        {
            path: 'big.pdf',
            chars: 12,
            pagesUsed: 'all 1 pages',
            truncated: false,
            outputPath: 'out.md',
            notes: 'The full Markdown is on disk.',
        },
    );
    assert.match(written.text, /wrote 12 characters to out\.md/);
    assert.doesNotMatch(written.text, /truncated/);
});

test('presentCall surfaces a readable card for both tools', async () => {
    const state = loadPlugin();
    for (const name of ['doc_route', 'pdf_markdown']) {
        const tool = toolNamed(state, name);
        const call = tool.presentCall({ path: '/some/dir/paper.pdf' });
        assert.equal(call.card, 'generic');
        assert.equal(call.kind, 'read');
        assert.equal(call.rawInput, '/some/dir/paper.pdf');
        // The title must show the file name, not the whole path.
        assert.match(call.title, /paper\.pdf$/);
        assert.doesNotMatch(call.title, /\/some\/dir\//);
    }
});

test('execute rejects an empty path before spawning anything', async () => {
    const state = loadPlugin();
    const tool = toolNamed(state, 'doc_route');
    await assert.rejects(() => tool.execute({ path: '   ' }, makeExec()), /path is empty/);
});

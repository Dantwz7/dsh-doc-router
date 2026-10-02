/**
 * End-to-end tests: drive the registered tools the way the model would, with a
 * real Python child process and the real fixture files.
 *
 * Skipped (not failed) when no interpreter with PyMuPDF is available.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    assertNotShredded,
    defaultConfig,
    fixture,
    fixturesDir,
    loadPlugin,
    makeExec,
    probeInterpreter,
    toolNamed,
} from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TMP = join(here, '.tmp');
const interpreter = probeInterpreter();
const skip = !interpreter.available && interpreter.reason;

/** Load the plugin pinned to the interpreter the tests verified. */
function pluginForTests() {
    return loadPlugin({ ...defaultConfig(), pythonPath: interpreter.python });
}

test('doc_route recommends the layout-aware pipeline for a two-column paper', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'doc_route');
    const result = await tool.execute({ path: fixture('two-column.pdf') }, makeExec());

    assert.equal(result.format, 'pdf');
    assert.equal(result.columns, 'multi-column');
    assert.equal(result.column_estimate, 2);
    assert.equal(result.text_layer, true);
    assert.deepEqual(result.recommend, ['pdf_markdown']);
    assert.equal(result.path, fixture('two-column.pdf'));
    // `probe` is a JSON string of the per-page profile, for debugging a
    // misclassification. It must round-trip.
    assert.doesNotThrow(() => JSON.parse(result.probe));
    assert.match(result.notes, /多栏|columns/);
});

test('doc_route sends a scan to the image pipeline and a one-column PDF to markitdown', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'doc_route');

    const scanned = await tool.execute({ path: fixture('scanned.pdf') }, makeExec());
    assert.equal(scanned.text_layer, false);
    assert.deepEqual(scanned.recommend, ['render_to_png + read_image']);

    const single = await tool.execute({ path: fixture('single-column.pdf') }, makeExec());
    assert.equal(single.columns, 'single-column');
    assert.deepEqual(single.recommend, ['markitdown', 'pypdf']);
});

test('doc_route sends an unmeasurable layout to pdf_markdown, not to markitdown', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'doc_route');
    const result = await tool.execute({ path: fixture('unknown-columns.pdf') }, makeExec());

    assert.equal(result.columns, 'unknown');
    assert.equal(result.text_layer, true);
    assert.deepEqual(result.recommend, ['pdf_markdown']);
    assert.match(result.notes, /未能判定栏数/);
});

test('doc_route handles Office, image and text inputs', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'doc_route');
    const expectations = [
        ['sample.docx', 'docx'],
        ['sample.xlsx', 'xlsx'],
        ['sample.pptx', 'pptx'],
        ['sample.png', 'png'],
        ['sample.rtf', 'rtf'],
    ];
    for (const [file, format] of expectations) {
        const result = await tool.execute({ path: fixture(file) }, makeExec());
        assert.equal(result.format, format, file);
        assert.ok(result.recommend.length > 0, file);
    }
});

test('doc_route resolves a relative path against the session workspace', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'doc_route');
    const result = await tool.execute({ path: 'sample.docx' }, makeExec(fixturesDir));
    assert.equal(result.format, 'docx');
    assert.equal(result.path, 'sample.docx', 'the caller-supplied path is echoed back');
});

test('doc_route rejects a missing file and a directory', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'doc_route');
    await assert.rejects(
        () => tool.execute({ path: fixture('nope.pdf') }, makeExec()),
        /not found/,
    );
    await assert.rejects(
        () => tool.execute({ path: fixturesDir }, makeExec()),
        /directory/,
    );
});

test('pdf_markdown converts a two-column page with both columns intact', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'pdf_markdown');
    const result = await tool.execute(
        { path: fixture('two-column.pdf'), pages: '1' },
        makeExec(),
    );

    assert.equal(result.truncated, false);
    assert.ok(result.chars > 500, `expected real markdown, got ${result.chars} chars`);
    assert.equal(result.pagesUsed, 'pages 1');
    const flat = result.markdown.replace(/\s+/g, ' ');
    assert.match(flat, /Document routing decides/);
    // NOTE: both substrings come from the fixture's single shared sentence pool,
    // so this asserts that both columns' text survived — not that it is in the
    // right order. Reading order is asserted by the marker fixture below.
    assert.match(flat, /gutter between columns/);
    // "both columns intact" also means the output is still prose, not a table.
    assertNotShredded(assert, result.markdown, { label: 'pdf_markdown tool output' });
    assert.equal(result.outputPath, undefined);
});

test('pdf_markdown preserves column reading order through the tool layer', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'pdf_markdown');
    const result = await tool.execute(
        { path: fixture('two-column-reading-order.pdf') },
        makeExec(),
    );

    const markers = result.markdown.match(/\b[LR]\d{2}\b/g) ?? [];
    const left = markers.filter((m) => m.startsWith('L'));
    const right = markers.filter((m) => m.startsWith('R'));
    assert.ok(left.length >= 10 && right.length >= 10, `got ${markers.length} markers`);
    assert.deepEqual(markers, [...left, ...right], `reading order broken: ${markers.join(' ')}`);
});

test('pdf_markdown writes to disk and withholds the inline body', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'pdf_markdown');
    const outPath = join(TMP, 'two-column.md');
    mkdirSync(TMP, { recursive: true });

    try {
        const result = await tool.execute(
            { path: fixture('two-column.pdf'), output: outPath },
            makeExec(),
        );

        assert.equal(result.outputPath, outPath);
        assert.equal(result.markdown, undefined, 'no inline body when writing to disk');
        assert.match(result.notes, /on disk at/);

        const onDisk = readFileSync(outPath, 'utf8');
        assert.equal(onDisk.length, result.chars, 'chars must describe what was written');
        assert.match(onDisk.replace(/\s+/g, ' '), /Document routing decides/);
    } finally {
        rmSync(TMP, { recursive: true, force: true });
    }
});

test('pdf_markdown truncates inline output at maxChars instead of flooding the model', { skip }, async () => {
    const config = { ...defaultConfig(), pythonPath: interpreter.python, maxChars: 200 };
    const tool = toolNamed(loadPlugin(config), 'pdf_markdown');

    const result = await tool.execute({ path: fixture('two-column.pdf') }, makeExec());
    assert.equal(result.truncated, true);
    assert.equal(result.markdown.length, 200);
    assert.ok(result.chars > 200, 'the full length is still reported');
});

test('pdf_markdown surfaces a bad page selection as an error', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'pdf_markdown');
    await assert.rejects(
        () => tool.execute({ path: fixture('two-column.pdf'), pages: '99' }, makeExec()),
        /matched no pages/,
    );
});

test('pdf_markdown refuses a non-PDF and says which pipeline to use instead', { skip }, async () => {
    const tool = toolNamed(pluginForTests(), 'pdf_markdown');

    // Regression: PyMuPDF 1.28 opens a .docx as a one-page "document", so this
    // call used to succeed and return garbage. It must refuse, name the detected
    // format, and route the caller onward.
    await assert.rejects(
        () => tool.execute({ path: fixture('sample.docx') }, makeExec()),
        (error) => {
            assert.match(error.message, /only converts PDFs/);
            assert.match(error.message, /docx/);
            assert.match(error.message, /markitdown/);
            return true;
        },
    );

    await assert.rejects(
        () => tool.execute({ path: fixture('sample.png') }, makeExec()),
        /only converts PDFs/,
    );
});

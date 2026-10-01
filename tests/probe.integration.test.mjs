/**
 * Integration tests for `lib/docprobe.py`, driven exactly the way the plugin
 * drives it: a child process, JSON on stdout.
 *
 * Skipped (not failed) when no interpreter with PyMuPDF is available, so the
 * dependency-free CI job still passes on a machine without Python.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, probeInterpreter, runProbe } from './helpers.mjs';

const interpreter = probeInterpreter();

/** Run the probe and parse its JSON answer, asserting the transport contract. */
function probe(args) {
    const result = runProbe(interpreter.python, args);
    assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`);
    const stdout = (result.stdout ?? '').trim();
    assert.notEqual(stdout, '', `no stdout; stderr was: ${result.stderr}`);
    // The contract with the plugin: stdout carries one JSON object and nothing
    // else. A stray print() or a warning on stdout would break every tool call.
    const parsed = JSON.parse(stdout);
    assert.equal(typeof parsed, 'object');
    assert.notEqual(parsed, null);
    return { parsed, status: result.status, stderr: result.stderr ?? '' };
}

test('route classifies every fixture as documented', { skip: !interpreter.available && interpreter.reason }, async (t) => {
    const cases = [
        {
            file: 'two-column.pdf',
            format: 'pdf',
            columns: 'multi-column',
            column_estimate: 2,
            text_layer: true,
            recommend: ['pdf_markdown'],
        },
        {
            // A full-height ~7pt margin stamp must not be counted as a column:
            // it lands in every band, so the naive count reported 3 columns for
            // a two-column paper (18 of 74 real PDFs in a trial corpus).
            file: 'two-column-watermark.pdf',
            format: 'pdf',
            columns: 'multi-column',
            column_estimate: 2,
            text_layer: true,
            recommend: ['pdf_markdown'],
        },
        {
            // Text present, but in one block per page: no column evidence at
            // all. Must stay `unknown` and go to the safe side, never be
            // asserted to be single-column.
            file: 'unknown-columns.pdf',
            format: 'pdf',
            columns: 'unknown',
            column_estimate: null,
            text_layer: true,
            recommend: ['pdf_markdown'],
        },
        {
            file: 'single-column.pdf',
            format: 'pdf',
            columns: 'single-column',
            text_layer: true,
            recommend: ['markitdown', 'pypdf'],
        },
        {
            file: 'scanned.pdf',
            format: 'pdf',
            text_layer: false,
            recommend: ['render_to_png + read_image'],
        },
        { file: 'sample.docx', format: 'docx', recommend: ['markitdown'] },
        { file: 'sample.xlsx', format: 'xlsx', recommend: ['markitdown'] },
        { file: 'sample.pptx', format: 'pptx', recommend: ['markitdown'] },
        { file: 'sample.png', format: 'png', recommend: ['read_image'] },
        { file: 'sample.rtf', format: 'rtf', recommend: ['read'] },
        { file: 'sample.txt', format: 'text', recommend: ['read'] },
        { file: 'sample.csv', format: 'csv', recommend: ['markitdown'] },
        { file: 'sample.json', format: 'json', recommend: ['markitdown'] },
        { file: 'sample.html', format: 'html', recommend: ['markitdown'] },
        { file: 'magic-ole2.doc', format: 'ole2', recommend: ['markitdown'] },
        { file: 'magic-plain.zip', format: 'zip', recommend: ['markitdown', 'read'] },
    ];

    for (const expected of cases) {
        await t.test(expected.file, () => {
            const { parsed } = probe(['route', fixture(expected.file)]);
            assert.equal(parsed.error, undefined, `unexpected error: ${parsed.error}`);
            assert.equal(parsed.format, expected.format, 'format');
            if (expected.columns !== undefined) {
                assert.equal(parsed.columns, expected.columns, 'columns');
            }
            if (expected.column_estimate !== undefined) {
                assert.equal(parsed.column_estimate, expected.column_estimate, 'column_estimate');
            }
            if (expected.text_layer !== undefined) {
                assert.equal(parsed.text_layer, expected.text_layer, 'text_layer');
            }
            assert.deepEqual(parsed.recommend, expected.recommend, 'recommend');
        });
    }
});

test('route reports the page profile that justifies its verdict', { skip: !interpreter.available && interpreter.reason }, async () => {
    const { parsed } = probe(['route', fixture('two-column.pdf')]);
    assert.equal(parsed.pages, 1);
    assert.ok(parsed.chars_per_page > 1000, 'a real text layer');
    assert.ok(parsed.text_chars >= parsed.chars_per_page);
    // `page_profile` is what the tool surfaces as `probe` for debugging a
    // misclassification, so its shape is part of the contract.
    assert.equal(typeof parsed.page_profile, 'object');
    assert.match(parsed.page_profile['1'], /^\d\.\d\d\/\dcol$/);
    assert.ok(Array.isArray(parsed.notes) && parsed.notes.length > 0);
});

test('route never trusts the extension', { skip: !interpreter.available && interpreter.reason }, async () => {
    // magic-ole2.doc has a .doc extension but is not a ZIP container, so a
    // extension-first implementation would call it docx and be wrong.
    const { parsed } = probe(['route', fixture('magic-ole2.doc')]);
    assert.equal(parsed.format, 'ole2');
    assert.equal(parsed.recommend[0], 'markitdown');
});

test('markdown converts a two-column page without shredding the text', { skip: !interpreter.available && interpreter.reason }, async () => {
    const { parsed } = probe(['markdown', fixture('two-column.pdf'), '--pages', '1']);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.pages_total, 1);
    assert.deepEqual(parsed.pages_used, [1]);
    assert.ok(parsed.chars > 500, `expected real markdown, got ${parsed.chars} chars`);

    // Whitespace-normalise first: a line wrap inside the phrase is not a defect.
    const flat = parsed.markdown.replace(/\s+/g, ' ');
    assert.match(flat, /Document routing decides/);
    // Both columns must be present — the failure mode this plugin exists to
    // prevent is one column being dropped or interleaved.
    assert.match(flat, /gutter between columns/);
});

test('markdown honours a page selection and defaults to the whole document', { skip: !interpreter.available && interpreter.reason }, async () => {
    const all = probe(['markdown', fixture('two-column.pdf')]).parsed;
    assert.equal(all.pages_used, 'all');
    assert.equal(all.pages_total, 1);

    const single = probe(['markdown', fixture('two-column.pdf'), '--pages', '1-1']).parsed;
    assert.deepEqual(single.pages_used, [1]);

    const comma = probe(['markdown', fixture('two-column.pdf'), '--pages', '1,1']).parsed;
    assert.deepEqual(comma.pages_used, [1]);
});

test('an out-of-range page selection is an error, not the whole document', { skip: !interpreter.available && interpreter.reason }, async () => {
    // Regression: an empty selection used to fall through to "all pages" and
    // report success, so asking for page 99 of a 1-page PDF returned everything.
    const { parsed } = probe(['markdown', fixture('two-column.pdf'), '--pages', '99']);
    assert.match(parsed.error, /matched no pages/);
    assert.equal(parsed.pages_used, undefined);
    assert.equal(parsed.markdown, undefined);
});

test('a malformed page selection names the offending chunk', { skip: !interpreter.available && interpreter.reason }, async () => {
    const { parsed } = probe(['markdown', fixture('two-column.pdf'), '--pages', 'abc']);
    assert.match(parsed.error, /invalid page selection 'abc'/);
    assert.match(parsed.error, /expected forms like/);
    // The message is written for the user, so no internal exception class name
    // may leak into it (`Error: ValueError: ...` reads like a stack trace).
    assert.doesNotMatch(parsed.error, /ValueError/);

    const open_ended = probe(['markdown', fixture('two-column.pdf'), '--pages', '1-']);
    assert.match(open_ended.parsed.error, /open-ended ranges are not supported/);

    const reversed = probe(['markdown', fixture('two-column.pdf'), '--pages', '3-1']).parsed;
    assert.deepEqual(reversed.pages_used, [1], 'a reversed range is normalised, not rejected');
});

test('an undecidable layout is routed to the safe side, not asserted to be single-column', { skip: !interpreter.available && interpreter.reason }, async () => {
    // Regression: `unknown` and `single-column` used to share one branch, so a
    // file whose layout could not be measured was sent to markitdown with a
    // note asserting "single-column". For a genuinely multi-column paper that
    // is the failure mode this plugin exists to prevent — and it looks like
    // success. Guessing wrong is asymmetric: pdf_markdown on a single-column
    // file merely costs time; markitdown on a multi-column file destroys the
    // body text.
    const { parsed } = probe(['route', fixture('unknown-columns.pdf')]);
    assert.equal(parsed.columns, 'unknown');
    assert.deepEqual(parsed.recommend, ['pdf_markdown']);
    assert.equal(parsed.text_layer, true, 'a text layer exists; this is not a scan');
    const notes = parsed.notes.join(' ');
    assert.match(notes, /未能判定栏数/);
    assert.doesNotMatch(notes, /单栏/, 'must not claim a single column it never measured');
});

test('a margin stamp is not counted as a column', { skip: !interpreter.available && interpreter.reason }, async () => {
    // Regression: the estimator filtered edge artefacts out of its gap list but
    // then returned the *unfiltered* segment count, so a ~7pt full-height
    // publisher stamp (which lands in every band) made a two-column paper
    // report three columns. Verified against a 74-paper corpus: 18 files hit it.
    const stamped = probe(['route', fixture('two-column-watermark.pdf')]).parsed;
    const plain = probe(['route', fixture('two-column.pdf')]).parsed;
    assert.equal(stamped.columns, 'multi-column');
    assert.equal(stamped.column_estimate, plain.column_estimate, 'same layout, same estimate');
});

test('markdown refuses anything that is not a real PDF', { skip: !interpreter.available && interpreter.reason }, async (t) => {
    // PyMuPDF 1.28 happily "opens" docx/xlsx/pptx/png/txt/zip and reports one
    // page, so without a magic-byte guard this tool silently returns garbage for
    // a Word file. Each refusal must name the detected format and the pipeline
    // to use instead.
    const cases = [
        ['sample.docx', /docx/, /markitdown/],
        ['sample.xlsx', /xlsx/, /markitdown/],
        ['sample.png', /png/, /read_image/],
        ['sample.txt', /text/, /read/],
    ];
    for (const [file, formatPattern, pipelinePattern] of cases) {
        await t.test(file, () => {
            const { parsed } = probe(['markdown', fixture(file)]);
            assert.match(parsed.error, /only converts PDFs/);
            assert.match(parsed.error, formatPattern);
            assert.match(parsed.error, pipelinePattern);
            assert.equal(parsed.markdown, undefined);
        });
    }
});

test('a directory is rejected as a directory, not as a permission error', { skip: !interpreter.available && interpreter.reason }, async () => {
    const { parsed, status } = probe(['route', fixture('.')]);
    assert.equal(status, 1);
    assert.match(parsed.error, /is a directory, not a file/);
});

test('every failure is reported as JSON, never as a traceback', { skip: !interpreter.available && interpreter.reason }, async (t) => {
    await t.test('missing file', () => {
        const { parsed, status } = probe(['route', fixture('nope-does-not-exist.pdf')]);
        assert.equal(status, 1);
        assert.match(parsed.error, /not found/);
    });

    await t.test('unknown mode', () => {
        const { parsed, status } = probe(['explode', fixture('sample.txt')]);
        assert.equal(status, 2);
        assert.match(parsed.error, /unknown mode/);
    });

    await t.test('no arguments', () => {
        const { parsed, status } = probe([]);
        assert.equal(status, 2);
        assert.match(parsed.error, /usage/);
    });
});

test('stderr is not part of the protocol', { skip: !interpreter.available && interpreter.reason }, async () => {
    // A noisy stderr (fontTools warnings, for example) must not break parsing:
    // the plugin reads stdout only and uses stderr for the error message.
    const result = runProbe(interpreter.python, ['route', fixture('sample.txt')]);
    assert.equal(result.status, 0);
    assert.doesNotThrow(() => JSON.parse((result.stdout ?? '').trim()));
});

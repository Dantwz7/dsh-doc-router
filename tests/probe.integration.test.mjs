/**
 * Integration tests for `lib/docprobe.py`, driven exactly the way the plugin
 * drives it: a child process, JSON on stdout.
 *
 * Skipped (not failed) when no interpreter with PyMuPDF is available, so the
 * dependency-free CI job still passes on a machine without Python.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertNotShredded, fixture, probeInterpreter, runProbe } from './helpers.mjs';

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

/**
 * Assert that `markdown` reads `tags.length` columns in order: every marker of
 * column 0, then column 1, and so on, each column internally ascending.
 *
 * This is the assertion that makes the marker fixtures worth having. A fixture
 * whose columns share a sentence pool cannot fail on a wrong order; one with
 * `L##` / `M##` / `R##` markers fails on an interleaved result, a swapped pair of
 * columns, a dropped column, or a reordered column.
 */
function assertColumnReadingOrder(markdown, tags, minPerColumn = 10) {
    const pattern = new RegExp(`\\b[${tags.join('')}]\\d{2}\\b`, 'g');
    const markers = markdown.match(pattern) ?? [];
    const columns = tags.map((tag) => markers.filter((m) => m.startsWith(tag)));

    for (const [i, column] of columns.entries()) {
        assert.ok(
            column.length >= minPerColumn,
            `expected >=${minPerColumn} markers in column ${tags[i]}, got ${column.length}` +
                ` (all markers: ${markers.join(' ') || 'none'})`,
        );
        assert.deepEqual(
            column,
            column.map((_, n) => `${tags[i]}${String(n + 1).padStart(2, '0')}`),
            `column ${tags[i]} is out of order: ${column.join(' ')}`,
        );
    }
    assert.deepEqual(
        markers,
        columns.flat(),
        `columns are interleaved or swapped: ${markers.join(' ')}`,
    );
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
            // Covers the branch the watermark case only guards by accident: a
            // layout that genuinely HAS three columns. The original
            // implementation looked for a single gutter down the middle of the
            // page, so a middle column of body text was invisible to it.
            file: 'three-column.pdf',
            format: 'pdf',
            columns: 'multi-column',
            column_estimate: 3,
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
            // Two real columns, but the right one is entirely short blocks (a
            // figure/table list), so the 25-character filter discards it. The
            // surviving column used to look like a confident single-column page,
            // which routed the document to markitdown. Must be `unknown`.
            file: 'short-column.pdf',
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
    // Both columns' text must survive. NOTE: this fixture cannot detect a wrong
    // *order* — both of its columns are drawn from one shared sentence pool, so
    // every permutation reads as plausibly as the correct one. Reading order is
    // covered by the marker fixtures below.
    assert.match(flat, /gutter between columns/);

    // "without shredding" is in this test's name, so assert it rather than assume
    // it: the shredding failure mode is the text coming back as a markdown table.
    assertNotShredded(assert, parsed.markdown, { label: 'pdf_markdown output' });
});

test('markdown keeps left-to-right reading order across two columns', { skip: !interpreter.available && interpreter.reason }, async () => {
    // The failure this plugin exists to prevent is a naive converter interleaving
    // (or dropping) the columns of a paper. `two-column.pdf` cannot detect that:
    // its columns share one sentence pool. This fixture's columns do not — the
    // left carries only `L##` and the right only `R##`.
    const { parsed } = probe(['markdown', fixture('two-column-reading-order.pdf')]);
    assert.equal(parsed.error, undefined);
    assertColumnReadingOrder(parsed.markdown, ['L', 'R']);
});

test('markdown keeps reading order across three columns', { skip: !interpreter.available && interpreter.reason }, async () => {
    // Two columns can be served by "find the gutter down the middle"; three
    // cannot. A middle column of body text is exactly what that implementation
    // missed, so assert the whole L → M → R sequence, not just the extremes.
    const { parsed } = probe(['markdown', fixture('three-column.pdf')]);
    assert.equal(parsed.error, undefined);
    assertColumnReadingOrder(parsed.markdown, ['L', 'M', 'R']);
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
    // `--lang zh` is explicit: the default language is English now, so the
    // Chinese wording only appears when it is asked for. This test exists to pin
    // the Chinese wording, so it has to ask.
    const { parsed } = probe(['route', fixture('unknown-columns.pdf'), '--lang', 'zh']);
    assert.equal(parsed.columns, 'unknown');
    assert.deepEqual(parsed.recommend, ['pdf_markdown']);
    assert.equal(parsed.text_layer, true, 'a text layer exists; this is not a scan');
    const notes = parsed.notes.join(' ');
    assert.match(notes, /未能判定栏数/);
    assert.doesNotMatch(notes, /单栏/, 'must not claim a single column it never measured');
});

test('a column made entirely of short blocks is not reported as single-column', { skip: !interpreter.available && interpreter.reason }, async () => {
    // Regression for the 25-character block filter. `_column_profile` discards
    // short blocks before looking for gutters, and that filter is column-agnostic:
    // with the right-hand column reduced to "Fig. 3a", "Table 2" and friends it
    // contributed no evidence, the left column supplied all of it, and the page was
    // reported `single-column` — sending a genuinely two-column document to
    // markitdown, the one direction the asymmetric bet forbids.
    //
    // The verdict is `unknown`, not `multi-column`: the detector still has no
    // evidence for a second column, and claiming one would be a guess in the other
    // direction. The fix only refuses to overstate.
    const { parsed } = probe(['route', fixture('short-column.pdf')]);
    assert.notEqual(
        parsed.columns,
        'single-column',
        'short blocks must not hide a whole column',
    );
    assert.equal(parsed.columns, 'unknown');
    assert.equal(parsed.column_estimate, null);
    assert.deepEqual(parsed.recommend, ['pdf_markdown']);
    assert.equal(parsed.text_layer, true, 'a text layer exists; this is not a scan');
});

test('the default advisory language is English', { skip: !interpreter.available && interpreter.reason }, async () => {
    // The notes travel with the tool result and the npm README is English, so
    // English is the default; `--lang zh` selects Chinese. Before this option
    // existed the notes were Chinese only, and the English README had to print
    // "[2 advisory lines omitted]" over output this package emits itself.
    const { parsed } = probe(['route', fixture('unknown-columns.pdf')]);
    assert.equal(parsed.columns, 'unknown', 'the verdict itself is language-independent');
    assert.deepEqual(parsed.recommend, ['pdf_markdown']);
    const notes = parsed.notes.join(' ');
    assert.match(notes, /could not be determined/);
    // The same invariant as the Chinese note, in the other language: never claim a
    // single column that was never measured.
    assert.doesNotMatch(
        notes,
        /single column/i,
        'must not claim a single column it never measured',
    );
    assert.doesNotMatch(notes, /[\u4e00-\u9fff]/, 'no Chinese in the default English notes');
});

test('an unknown --lang falls back to the default instead of failing', { skip: !interpreter.available && interpreter.reason }, async () => {
    const { parsed, status } = probe(['route', fixture('unknown-columns.pdf'), '--lang', 'klingon']);
    assert.equal(status, 0);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.columns, 'unknown');
    assert.match(
        parsed.notes.join(' '),
        /could not be determined/,
        'falls back to the default language, which is English',
    );
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

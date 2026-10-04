#!/usr/bin/env node
/**
 * Verify the "real verdicts" table in both READMEs against the fixture
 * generator's own expectations.
 *
 * CONTRIBUTING §7.1 requires that anything the documentation claims a test
 * asserts must itself be checked — and the README's per-fixture verdict table
 * was the exception. `check-doc-links.mjs` checks links, anchors and structure
 * counts, but not the numbers: renaming a fixture, moving a column estimate, or
 * changing a recommendation updated one side and silently rotted the other. The
 * README is the first evidence a reader has that the routing works, so a stale
 * number there is worse than a stale comment.
 *
 * `generate.py` is Python and this script is Node — the `docs` CI job installs
 * no Python on purpose — so `EXPECTED` is read with a small, targeted parser
 * instead of by importing the module. A shape the parser cannot follow fails
 * loudly rather than silently checking nothing.
 *
 * What is checked, for both READMEs:
 *   1. every fixture named in the table exists in `generate.py`'s `EXPECTED`;
 *   2. each row's `est N` / `估 N 栏` equals `EXPECTED[name].column_estimate`
 *      (present exactly when the fixture has one);
 *   3. each row's pipeline cell names exactly the pipelines
 *      `EXPECTED[name].recommend` recommends;
 *   4. both READMEs list the same fixtures, and every `REQUIRED` fixture is
 *      present in both.
 *
 * Usage: node scripts/check-readme-facts.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Fixtures the "real verdicts" table must document. Not every fixture belongs
 * there — it is a curated sample, not an inventory — so the required subset is
 * explicit. Deleting a row from *both* READMEs still fails, which is the point:
 * a silently dropped example should be a conscious decision.
 */
const REQUIRED = [
    'two-column.pdf',
    'three-column.pdf',
    'two-column-watermark.pdf',
    'unknown-columns.pdf',
    'dense-script-column.pdf',
    'single-column.pdf',
    'scanned.pdf',
    'sample.docx',
    'sample.png',
    'sample.txt',
];

/**
 * Parse `EXPECTED` out of `tests/fixtures/generate.py`.
 *
 * Deliberately not a Python parser: the block is a flat dict of flat dicts, so
 * brace-matching plus a per-value regex is enough, and anything more exotic
 * fails loudly. Values are strings, booleans, numbers and lists of strings.
 * @returns a Map of fixture name -> expected properties.
 */
function parseExpected(source) {
    const start = source.indexOf('EXPECTED = {');
    if (start === -1) throw new Error('generate.py: `EXPECTED = {` not found');
    const open = source.indexOf('{', start);
    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close === -1) throw new Error('generate.py: `EXPECTED` block is not balanced');

    const body = source.slice(open + 1, close);
    const expected = new Map();
    for (const entry of body.matchAll(/"([^"]+)"\s*:\s*\{([^}]*)\}/g)) {
        const [, name, inner] = entry;
        const props = {};
        for (const field of inner.matchAll(
            /"(\w+)"\s*:\s*(\[[^\]]*\]|"[^"]*"|True|False|-?\d+)/g,
        )) {
            props[field[1]] = parseValue(field[2]);
        }
        expected.set(name, props);
    }
    if (expected.size === 0) throw new Error('generate.py: `EXPECTED` parsed to zero entries');
    return expected;
}

/** One Python literal value out of an `EXPECTED` entry. */
function parseValue(raw) {
    if (raw === 'True') return true;
    if (raw === 'False') return false;
    if (raw.startsWith('"')) return raw.slice(1, -1);
    if (raw.startsWith('[')) return [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    return Number(raw);
}

/**
 * The rows of a README's verdict table, located by its header rather than by
 * line number. Returns `{ name, verdict, pipeline }` for each data row.
 */
function readVerdictTable(text, label) {
    const lines = text.split(/\r?\n/);
    const header = lines.findIndex(
        (line) =>
            /^\|\s*(Fixture|夹具)\s*\|/.test(line) &&
            /(Verdict|判据)/.test(line) &&
            /(Pipeline|管线)/.test(line),
    );
    if (header === -1) throw new Error(`${label}: verdict table header not found`);

    const rows = [];
    for (let i = header + 2; i < lines.length; i += 1) {
        if (!lines[i].startsWith('|')) break;
        const cells = lines[i].split('|').slice(1, -1).map((cell) => cell.trim());
        if (cells.length < 3) continue;
        const name = /`([^`]+)`/.exec(cells[0]);
        if (name === null) throw new Error(`${label}: row has no \`fixture\` name: ${lines[i]}`);
        rows.push({ name: name[1], verdict: cells[1], pipeline: cells[2] });
    }
    if (rows.length === 0) throw new Error(`${label}: verdict table has no data rows`);
    return rows;
}

/** The pipelines a recommendation names, splitting `a + b` into two. */
function recommendedPipelines(recommend) {
    const set = new Set();
    for (const token of recommend ?? []) {
        for (const part of token.split('+')) {
            const name = part.trim();
            if (name !== '') set.add(name);
        }
    }
    return [...set].sort();
}

/** The pipelines a table cell names, e.g. `` `markitdown` → `pypdf` ``. */
function namedPipelines(cell) {
    return [...new Set([...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()))].sort();
}

const expected = parseExpected(
    readFileSync(join(repo, 'tests', 'fixtures', 'generate.py'), 'utf8'),
);

const problems = [];
const tables = new Map();
for (const file of ['README.md', 'README.zh.md']) {
    const rows = readVerdictTable(readFileSync(join(repo, file), 'utf8'), file);
    tables.set(file, rows);

    for (const row of rows) {
        if (!expected.has(row.name)) {
            problems.push(`${file}: \`${row.name}\` is not in generate.py's EXPECTED`);
            continue;
        }
        const want = expected.get(row.name);

        const est = /(?:est|估)\s*(\d+)/.exec(row.verdict);
        if (want.column_estimate === undefined) {
            if (est !== null) {
                problems.push(
                    `${file}: ${row.name} claims "est ${est[1]}" but EXPECTED has no column_estimate`,
                );
            }
        } else if (est === null) {
            problems.push(
                `${file}: ${row.name} is missing "est ${want.column_estimate}" ` +
                    '(EXPECTED has a column_estimate)',
            );
        } else if (Number(est[1]) !== want.column_estimate) {
            problems.push(
                `${file}: ${row.name} says "est ${est[1]}", EXPECTED says ` +
                    `${want.column_estimate}`,
            );
        }

        const named = namedPipelines(row.pipeline);
        const wantPipelines = recommendedPipelines(want.recommend);
        if (JSON.stringify(named) !== JSON.stringify(wantPipelines)) {
            problems.push(
                `${file}: ${row.name} pipelines [${named.join(', ')}] != ` +
                    `EXPECTED recommend [${wantPipelines.join(', ')}]`,
            );
        }
    }
}

// The two tables must document the same fixtures, so a row cannot be added to
// one README and forgotten in the other.
const [en, zh] = [...tables.values()].map((rows) => rows.map((row) => row.name));
if (JSON.stringify(en) !== JSON.stringify(zh)) {
    problems.push(
        `README.md and README.zh.md list different fixtures:\n` +
            `      en: ${en.join(', ')}\n      zh: ${zh.join(', ')}`,
    );
}

// And the curated subset must actually be there.
for (const name of REQUIRED) {
    for (const [file, rows] of tables) {
        if (!rows.some((row) => row.name === name)) {
            problems.push(`${file}: required fixture \`${name}\` is missing from the table`);
        }
    }
}

console.log(`checked the verdict tables of ${[...tables.keys()].join(', ')}`);
console.log(
    `fixtures documented: ${en.length}; EXPECTED entries: ${expected.size}; ` +
        `required: ${REQUIRED.length}`,
);

if (problems.length === 0) {
    console.log('OK: every README verdict matches generate.py');
} else {
    console.log('PROBLEMS:');
    for (const problem of problems) console.log('  - ' + problem);
    process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * Verify the documentation surface of the READMEs.
 *
 * A README is rendered in more than one place — the GitHub repository page, the
 * npm package page, editor previews, mirrors — and those renderers do not agree
 * on what a relative link means. The npm page is built from the tarball, and the
 * tarball only contains `package.json`'s `files` allow-list; a relative link to
 * anything else is a 404 for npm readers even though it works perfectly on
 * GitHub. That is not a hypothetical: eight such links shipped in `0.3.0`.
 *
 * So the rule this script enforces is:
 *
 *   1. every relative link resolves to a file that exists;
 *   2. every relative link in a *published* file resolves to a file that is
 *      itself published — anything else must use an absolute GitHub URL;
 *   3. every absolute GitHub `blob`/`raw` URL points at a path that exists in
 *      this checkout, and any `#anchor` on it names a real heading there;
 *   4. every in-page `#anchor` names a real heading;
 *   5. the two READMEs stay structurally parallel (same section/table/fence
 *      counts), so the Chinese mirror cannot silently drift from the English
 *      primary.
 *
 * Rule 2 is the one that turns "use absolute URLs for unpublished files" from a
 * convention into something the build fails on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));

/** The canonical repository, and the base every cross-file link must use. */
const REPO_URL = 'https://github.com/Dantwz7/dsh-doc-router';

/**
 * Files npm ships no matter what `files` says. `package.json`, the READMEs and
 * the license are always included; everything else must be listed explicitly.
 */
const ALWAYS_PUBLISHED = new Set(['package.json', 'README.md', 'README.zh.md', 'LICENSE']);

/**
 * Would `npm publish` put this repository-relative path in the tarball?
 *
 * A `files` entry is either a file or a directory prefix (`"lib"` means every
 * file under `lib/`). This mirrors `scripts/verify-package.mjs`, which asserts
 * the *actual* tarball by running `npm pack`; this one only needs the predicate,
 * so the `docs` CI job does not have to shell out.
 * @param pathPart - a repository-relative path, as written in a link.
 * @returns true when the path is part of the published package.
 */
function isPublished(pathPart) {
    const p = pathPart.replace(/^\.\//, '').replace(/\\/g, '/');
    if (ALWAYS_PUBLISHED.has(p)) return true;
    return (manifest.files ?? []).some((entry) => {
        const e = String(entry).replace(/\/+$/, '');
        return p === e || p.startsWith(`${e}/`);
    });
}

/** GitHub's heading -> anchor slug: lowercase, drop punctuation, spaces -> '-'. */
function slug(heading) {
    return heading
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-');
}

function anchorsOf(text) {
    const set = new Set();
    for (const line of text.split(/\r?\n/)) {
        const m = /^(#{1,6})\s+(.*)$/.exec(line);
        if (m) set.add(slug(m[2]));
    }
    return set;
}

const anchorsCache = new Map();
/** @returns the heading anchors of a repository-relative Markdown file. */
function anchorsFor(pathPart) {
    if (!anchorsCache.has(pathPart)) {
        const abs = resolve(repo, pathPart);
        anchorsCache.set(pathPart, existsSync(abs) ? anchorsOf(readFileSync(abs, 'utf8')) : new Set());
    }
    return anchorsCache.get(pathPart);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An absolute link back into this repository: .../blob/main/<path>[#frag]. */
const OWN_BLOB = new RegExp(`^${escapeRe(REPO_URL)}/(?:blob|raw)/main/(.+)$`);

const problems = [];

// [file, published] — `published` decides whether rule 2 applies.
const checked = [
    ['README.md', true],
    ['README.zh.md', true],
    ['CONTRIBUTING.md', false],
];

for (const [file, published] of checked) {
    const text = readFileSync(join(repo, file), 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const raw = m[1];

        // Absolute links: only our own GitHub URLs carry a checkable path.
        const own = OWN_BLOB.exec(raw);
        if (own !== null) {
            const [pathPart, frag] = own[1].split('#');
            const target = resolve(repo, pathPart);
            if (!existsSync(target)) {
                problems.push(`${file}: absolute GitHub link points at a missing path ${pathPart}`);
            } else if (frag !== undefined && pathPart.endsWith('.md')) {
                if (!anchorsFor(pathPart).has(frag)) {
                    problems.push(`${file}: dead anchor ${pathPart}#${frag}`);
                }
            }
            continue;
        }
        if (/^(https?:|mailto:)/.test(raw)) continue;

        const [pathPart, frag] = raw.split('#');
        if (pathPart === '') {
            if (frag !== undefined && frag !== '' && !anchorsFor(file).has(frag)) {
                problems.push(`${file}: dead in-page anchor #${frag}`);
            }
            continue;
        }

        const target = resolve(repo, pathPart);
        if (!existsSync(target)) {
            problems.push(`${file}: missing file ${pathPart}`);
            continue;
        }
        if (published && !isPublished(pathPart)) {
            problems.push(
                `${file}: relative link "${pathPart}" is not in the npm tarball — npm readers ` +
                    `get a 404; use ${REPO_URL}/blob/main/${pathPart}`,
            );
        }
        if (frag !== undefined && frag !== '' && pathPart.endsWith('.md')) {
            if (!anchorsFor(pathPart).has(frag)) {
                problems.push(`${file}: dead anchor ${pathPart}#${frag}`);
            }
        }
    }
}

// Anchors referenced from OUTSIDE the READMEs (issue template, docs).
for (const [file, frag] of [['.github/ISSUE_TEMPLATE/config.yml', 'how-the-routing-works']]) {
    const abs = resolve(repo, file);
    if (!existsSync(abs)) {
        problems.push(`missing ${file}`);
        continue;
    }
    const body = readFileSync(abs, 'utf8');
    if (body.includes(`#${frag}`) && !anchorsFor('README.md').has(frag)) {
        problems.push(`${file} links #${frag} but README.md has no such heading`);
    }
}

// Rule 5: the two READMEs must stay structurally parallel.
const count = (text, re) => (text.match(re) ?? []).length;
function structure(text) {
    const lines = text.split(/\r?\n/);
    return {
        'H2 headings': count(text, /^## /gm),
        'H3 headings': count(text, /^### /gm),
        'code fences': count(text, /^```/gm),
        tables: lines.filter((l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-')).length,
        '<details> blocks': count(text, /<details>/g),
        badges: count(text, /^\[!\[/gm),
    };
}
const en = structure(readFileSync(join(repo, 'README.md'), 'utf8'));
const zh = structure(readFileSync(join(repo, 'README.zh.md'), 'utf8'));
for (const key of Object.keys(en)) {
    if (en[key] !== zh[key]) {
        problems.push(`README.zh.md has ${zh[key]} ${key}, README.md has ${en[key]} — they must match`);
    }
}

console.log(`checked ${checked.map(([f]) => f).join(', ')}`);
console.log(`README.md headings: ${anchorsFor('README.md').size}`);
console.log(
    `structure: ${Object.entries(en)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
);

if (problems.length === 0) {
    console.log('OK: every link, anchor and structure count resolves');
} else {
    console.log('PROBLEMS:');
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
}

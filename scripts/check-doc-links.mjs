#!/usr/bin/env node
// Verify relative links and in-page anchors of the two READMEs.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['README.md', 'README.zh.md', 'CONTRIBUTING.md'];

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

const anchorsByFile = new Map();
for (const f of files) anchorsByFile.set(f, anchorsOf(readFileSync(join(repo, f), 'utf8')));

const problems = [];
for (const f of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(repo, f), 'utf8');
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    for (const raw of links) {
        if (/^(https?:|mailto:)/.test(raw)) continue;
        const [pathPart, frag] = raw.split('#');
        if (pathPart === '') {
            const own = anchorsByFile.get(f);
            if (frag && !own.has(frag)) problems.push(`${f}: dead in-page anchor #${frag}`);
            continue;
        }
        const target = resolve(repo, pathPart);
        if (!existsSync(target)) {
            problems.push(`${f}: missing file ${pathPart}`);
            continue;
        }
        if (frag && anchorsByFile.has(pathPart)) {
            if (!anchorsByFile.get(pathPart).has(frag)) {
                problems.push(`${f}: dead anchor ${pathPart}#${frag}`);
            }
        } else if (frag && pathPart.endsWith('.md')) {
            const abs = resolve(repo, pathPart);
            const target2 = existsSync(abs) ? anchorsOf(readFileSync(abs, 'utf8')) : new Set();
            if (!target2.has(frag)) problems.push(`${f}: dead anchor ${pathPart}#${frag}`);
        }
    }
}

// Anchors referenced from OUTSIDE the READMEs (issue template, docs).
for (const [file, frag] of [['.github/ISSUE_TEMPLATE/config.yml', 'how-the-routing-works']]) {
    const abs = resolve(repo, file);
    if (!existsSync(abs)) { problems.push(`missing ${file}`); continue; }
    const body = readFileSync(abs, 'utf8');
    if (body.includes(`#${frag}`) && !anchorsByFile.get('README.md').has(frag)) {
        problems.push(`${file} links #${frag} but README.md has no such heading`);
    }
}

console.log(`checked ${files.join(', ')}`);
console.log(`README.md headings: ${anchorsByFile.get('README.md').size}`);
if (problems.length === 0) {
    console.log('OK: every relative link and anchor resolves');
} else {
    console.log('PROBLEMS:');
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
}

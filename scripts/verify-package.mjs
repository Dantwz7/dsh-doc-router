#!/usr/bin/env node
/**
 * Verify what `npm publish` would actually upload.
 *
 * A `files` allow-list is easy to get subtly wrong — a missing LICENSE, a test
 * suite shipped to every consumer, a fixture directory adding a megabyte to the
 * tarball. This script asserts the contents explicitly and is wired into CI, so
 * the tarball cannot drift unnoticed.
 *
 * Usage: node scripts/verify-package.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Files that must be in the tarball, with the reason they matter. */
const REQUIRED = new Map([
    ['package.json', 'the manifest itself'],
    ['lib/index.js', 'the plugin entry point'],
    ['lib/docprobe.py', 'the probe script the plugin spawns'],
    ['cordis.patch.yml', 'the bundle layer — without it DSH rejects the package'],
    ['README.md', 'primary documentation'],
    ['README.zh.md', 'Chinese documentation'],
    ['CHANGELOG.md', 'release history'],
    ['LICENSE', 'MIT license text'],
    ['NOTICE', 'the PyMuPDF AGPL-3.0 disclosure'],
]);

/** Path prefixes that must never be published. */
const FORBIDDEN = [
    'tests/',
    'scripts/',
    '.github/',
    'node_modules/',
];

/**
 * Patterns that must never be published, wherever they appear. `__pycache__`
 * bit this project once: importing the probe from the fixture generator wrote a
 * `.pyc` next to it, and the `lib` allow-list shipped it in the tarball.
 */
const FORBIDDEN_PATTERNS = [
    [/__pycache__/, 'python bytecode cache'],
    [/\.pyc$/, 'python bytecode cache'],
    [/\.test\.mjs$/, 'test file'],
    [/\.log$/, 'log file'],
];

/**
 * `scripts` entries that reference development-only paths, and therefore cannot
 * run from the published tarball.
 *
 * This is not a defect to fix — `tests/` and `scripts/` are excluded above on
 * purpose, and no consumer runs `npm test` on an installed plugin. It is a
 * *deliberate* inconsistency that would otherwise rot silently: `package.json` is
 * shipped verbatim, so it keeps advertising entry points whose files are not.
 *
 * Enumerating them turns that into an invariant. A new script that touches a
 * forbidden prefix without being listed here fails the check, and a listed script
 * that no longer does fails too (no stale entries). Adding one should be a
 * conscious "yes, this is development-only".
 */
const DEV_ONLY_SCRIPTS = new Set([
    'test',
    'test:inline',
    'test:unit',
    'test:unit:inline',
    'test:integration',
    'fixtures',
    'verify:package',
    'verify:docs',
    'verify:readme-facts',
]);

/**
 * Locate npm's CLI entry point so it can be spawned as `node npm-cli.js …`
 * rather than through a shell.
 *
 * `npm run` exports `npm_execpath`, which is the direct answer. Invoked as a
 * plain `node scripts/verify-package.mjs` it is unset, and the previous fallback
 * was `spawnSync('npm', args, { shell: true })` — which Node warns about
 * (DEP0190: arguments passed alongside `shell: true` are concatenated, not
 * escaped). npm ships inside the Node installation, so it can be found from
 * `process.execPath` and spawned with `shell: false`, like every other child
 * process this repository starts.
 *
 * @returns the path to npm's CLI, or undefined when it cannot be located.
 */
function findNpmCli() {
    const fromEnv = process.env.npm_execpath;
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;

    const nodeDir = dirname(process.execPath);
    return [
        // Windows and Unix Node layouts both keep npm in this position.
        join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].find((candidate) => existsSync(candidate));
}

const npmCli = findNpmCli();
const packArgs = ['pack', '--dry-run', '--json'];
const result = spawnSync(
    npmCli === undefined ? 'npm' : process.execPath,
    npmCli === undefined ? packArgs : [npmCli, ...packArgs],
    {
        cwd: repoRoot,
        encoding: 'utf8',
        // Only reachable when npm's CLI could not be located at all. On Windows a
        // bare `npm` is a .cmd shim, which Node refuses to spawn without a shell.
        shell: npmCli === undefined && process.platform === 'win32',
    },
);

if (result.error !== undefined) {
    console.error(`could not run npm pack: ${result.error.message}`);
    process.exit(2);
}
if (result.status !== 0) {
    console.error('npm pack failed:');
    console.error(result.stderr ?? '');
    process.exit(2);
}

let report;
try {
    report = JSON.parse(result.stdout);
} catch {
    console.error('could not parse `npm pack --dry-run --json` output:');
    console.error(result.stdout);
    process.exit(2);
}

const [entry] = report;
if (entry === undefined) {
    console.error('npm pack returned no entry');
    process.exit(2);
}

const files = entry.files.map((f) => f.path);
const problems = [];

for (const [path, why] of REQUIRED) {
    if (!files.includes(path)) problems.push(`missing ${path} (${why})`);
}

for (const file of files) {
    const bad = FORBIDDEN.find((prefix) => file.startsWith(prefix));
    if (bad !== undefined) problems.push(`must not publish ${file} (${bad} is development-only)`);

    for (const [pattern, why] of FORBIDDEN_PATTERNS) {
        if (pattern.test(file)) problems.push(`must not publish ${file} (${why})`);
    }
}

// A tarball that suddenly grows means something unintended got included.
const LIMIT_BYTES = 200 * 1024;
if (entry.size > LIMIT_BYTES) {
    problems.push(
        `tarball is ${entry.size} bytes, over the ${LIMIT_BYTES}-byte budget — check for stray files`,
    );
}

// The manifest is shipped verbatim, so its scripts still name files the tarball
// does not contain. Assert that every such script is a declared exception.
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const scriptNames = Object.keys(manifest.scripts ?? {});
const touchesDevOnly = (name) =>
    FORBIDDEN.some((prefix) => (manifest.scripts[name] ?? '').includes(prefix));

for (const name of scriptNames) {
    if (touchesDevOnly(name) && !DEV_ONLY_SCRIPTS.has(name)) {
        problems.push(
            `script "${name}" runs a development-only path but is not listed in ` +
                'DEV_ONLY_SCRIPTS — add it there if that is intended',
        );
    }
}
for (const name of DEV_ONLY_SCRIPTS) {
    if (!scriptNames.includes(name)) {
        problems.push(`DEV_ONLY_SCRIPTS lists "${name}", which package.json no longer defines`);
    } else if (!touchesDevOnly(name)) {
        problems.push(
            `script "${name}" is listed in DEV_ONLY_SCRIPTS but no longer references a ` +
                'development-only path — remove it from the list',
        );
    }
}

console.log(`${entry.filename}: ${files.length} files, ${entry.size} bytes (unpacked ${entry.unpackedSize})`);
for (const file of files.sort()) console.log(`  ${file}`);

if (problems.length > 0) {
    console.error('\nPACKAGE VERIFICATION FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}

console.log('\npackage verification passed');

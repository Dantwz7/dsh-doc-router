# Contributing to dsh-doc-router

Thanks for taking the time to contribute. This document is written for people
who want to change the code, not just use it.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## 1. What this project is

A DeepSeek Harness (DSH) plugin. Two tools and one skill:

| Artifact | File | Purpose |
|---|---|---|
| `doc_route` tool | `lib/index.js` | Classify a document and name the pipeline to use |
| `pdf_markdown` tool | `lib/index.js` | Layout-aware PDF → Markdown |
| `doc-routing` skill | `lib/index.js` (`SKILL_BODY`) | Tells the model to route before reading |
| Probe + extractor | `lib/docprobe.py` | All the actual document inspection |

```
lib/index.js        the plugin: tool definitions, interpreter discovery, spawning
lib/docprobe.py     stdlib + PyMuPDF: format sniffing, column geometry, extraction
cordis.patch.yml    bundle layer: inserts the plugin into the DSH composition
tests/              node --test suite + synthetic fixtures
.github/workflows/  CI
```

## 2. Development setup

There is **no build step and no install step**. The plugin is plain ESM
JavaScript; the test suite runs against local stubs for the two
`@deepseek-ai/*` imports, so a fresh clone needs nothing but Node.

```bash
git clone https://github.com/Dantwz7/dsh-doc-router.git
cd dsh-doc-router
npm test              # works immediately, no npm install required
```

Requirements:

* **Node** `^22.19.0 || >=24.0.0` (the `engines` range). Tests use the built-in
  `node --test` runner and `node:assert`.
* **Python 3.9+** and **PyMuPDF** — *optional*. Only the integration tests need
  them; without them those tests report as skipped, not failed.

```bash
# Optional: enable the integration tests
pip install pymupdf4llm
DOC_ROUTER_PYTHON="$(command -v python3)" npm test
```

Do **not** add runtime `dependencies`. The only imports are Node built-ins and
`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`, which the DSH host
supplies and which are declared as `peerDependencies`. Adding a real
devDependency on `@deepseek-ai/dsh-tools` is also discouraged: the public
`latest` dist-tag of that package is an older build than the `next` tag DSH
actually ships, so a plain `npm install` would resolve the wrong version. The
stub loader in `tests/stubs/` exists precisely to avoid that trap.

## 3. Running and writing tests

```bash
npm test                 # everything; integration tests skip if PyMuPDF is missing
npm run test:unit        # only the dependency-free unit tests
npm run fixtures         # regenerate tests/fixtures/ (needs Python + PyMuPDF)
```

Conventions:

* One `tests/*.test.mjs` file per concern, using `node:test` and
  `node:assert/strict`.
* Prefer asserting on **observable behaviour** (the JSON the probe returns, the
  tool result object) over internal helpers.
* Any test that shells out to Python must call
  `t.skip('PyMuPDF not available')` rather than failing when the dependency is
  absent. CI runs the unit job on machines without Python on purpose.
* New fixtures go through `tests/fixtures/generate.py`; never commit a document
  you did not generate yourself. `tests/fixtures/README.md` explains why.

## 4. Changing the routing rules

The rules are deliberately **deterministic** — no model, no network. Keep them
that way. If you change a threshold in `lib/docprobe.py`, update the rationale
in the docstring *and* the table in `README.md`, and add a fixture that
exercises the new boundary.

Three past bugs are worth not reintroducing; they are documented in the code and
in the README's design notes:

1. Counting text blocks per column instead of finding the gutter per band
   misclassified a Nature page whose left column held only two blocks.
2. Looking only for the single gutter in the middle of the page missed
   three-column layouts.
3. Taking a majority vote across pages let a single-column references page
   outvote multi-column body pages.

## 5. Testing against a real DSH install

The unit tests do not prove the plugin loads in DSH. To do that, install it into
a profile and exercise it from a real session.

```bash
# from the repository root, using an absolute path
plugin_manager action=install_bundle target="file:<ABS-PATH-TO-REPO>"
```

A `file:` install is a **copy**, and the running host keeps the already-loaded
module in its ESM cache, so editing the source has no effect. The update loop is:

> bump `version` → `remove_bundle` → `install_bundle` → **restart DSH**

The `remove_bundle` step is **not optional, and bumping the version is not
enough.** pnpm keys a `file:` directory dependency by its *specifier*, which
does not change when you edit the source, so a plain re-install decides there is
nothing to do and leaves the old copy in place — while still reporting success.
The pnpm log shows it plainly:

```text
# install_bundle alone, version already bumped to 0.2.0
Packages: +14 -10
Done in 1.4s using pnpm v11.7.0          # no `dependencies:` section — nothing changed

# remove_bundle, then install_bundle
dependencies:
- dsh-doc-router file:D:/dsh-plugins/dsh-doc-router   # remove
dependencies:
+ dsh-doc-router file:D:/dsh-plugins/dsh-doc-router   # install — now it re-copies
```

So check for the `dependencies: +` line in the operation log. If it is absent,
the copy was not refreshed no matter what the operation reported.

Two more things worth knowing before you conclude an install failed:

- **A reported `timedOut` does not mean the work did not happen.** DSH kills the
  package-manager child if it prints nothing for 600 s; pnpm had in fact finished
  its linking seconds earlier, and the operation was still marked failed. Always
  verify the result on disk (below) before retrying.
- **`remove_bundle` is safe to run**: it prunes the dependency and rewrites the
  manifest, and `install_bundle` restores it. Do not restart DSH in between, or
  the plugin will simply be absent from that session.

To confirm the new copy is the one running, call `doc_route` on any file: its
last output line is `dsh-doc-router v<version>`, read from the loaded copy's own
`package.json`. If that still shows the old version, the host is serving the
cached module — restart it. Do not try to infer the loaded version from
behaviour; that is exactly how a stale copy stayed installed unnoticed.

To confirm the copy on disk without starting DSH at all, compare hashes against
the checkout:

```bash
# the installed copy must be byte-identical to the source
for f in package.json lib/index.js lib/docprobe.py cordis.patch.yml; do
  diff <(sha256sum "$f") <(sha256sum "$INSTALLED/$f")
done
```

### A claim that was wrong, recorded so it is not repeated

An earlier investigation of this project concluded that a `file:` install path
containing non-ASCII characters broke the next cold start: the profile manifest
appeared to contain mojibake (`工作区` → `宸ヤ綔鍖?`), which pnpm then could not
resolve. **That conclusion was an artifact.** The mojibake came from reading a
UTF-8 file with Windows PowerShell 5.1's `Get-Content -Raw`, which decodes as
ANSI/GBK; checking the same files byte-wise showed no corruption at all. The
actual cold-start failure was later bisected to an unrelated third-party plugin.

The claim is not repeated here, and there is no verified ASCII-path requirement.
It also has not been *disproved* by testing — so if you install from a
non-ASCII path, treat an ASCII junction or symlink as a cheap precaution rather
than a rule. Please report what you find either way.

Two DSH "gates" decide whether a bundle is installable at all — keep them
satisfied when you touch `package.json`:

| Gate | Requirement |
|---|---|
| 1 | `package.json` must have `dsh.bundle.patch` pointing at `cordis.patch.yml` |
| 2 | every `@deepseek-ai/dsh*` peer range must accept the running DSH version |

For gate 2, never use `^0.1.x` for a `@deepseek-ai/dsh*` peer: the prerelease
range expands to an upper bound of `<0.2.0-0`, which excludes `0.2.0-rc.2` even
with `includePrerelease`. Use an open-ended range such as
`>=0.2.0-rc.1 <0.3.0-0`.

## 6. Style

* ESM only, 4-space indent, single quotes, semicolons — match the surrounding
  code. `.editorconfig` is authoritative for whitespace.
* Keep `lib/index.js` free of any document-parsing logic: it owns tool
  registration, interpreter discovery, and process spawning. Parsing belongs in
  `lib/docprobe.py`.
* Every `ctx` registration must go through `ctx.effect(...)` so a reload or
  unload leaves nothing behind.
* Public JSON keys crossing the Python↔Node boundary are `snake_case`; tool
  result keys the model sees are `camelCase`. Keep that split.
* Comments explain *why*. A non-obvious threshold without a rationale will be
  sent back.

## 7. Release process

Releases are cut from `main` and published to npm by a maintainer:

1. Update `CHANGELOG.md`: move the `Unreleased` items under the new version
   heading and refresh the compare links.
2. Bump `version` in `package.json` (SemVer; the plugin is pre-1.0 while DSH
   itself is pre-1.0).
3. `npm test`.
4. `npm pack --dry-run` and confirm the tarball contains exactly `lib/`,
   `cordis.patch.yml`, the READMEs, `LICENSE`, `NOTICE`, and `CHANGELOG.md` —
   no tests, no fixtures, no stray files.
5. Commit as `chore(release): vX.Y.Z`, tag `vX.Y.Z`, push the tag.
6. `npm publish`.
7. Create the GitHub release from the changelog entry.

## 8. Reporting bugs

Open an issue with the bug-report template. Please include:

* DSH version and platform (`0.2.0-rc.2`, Windows x64 / macOS / Linux),
* the output of `doc_route` for the file in question,
* whether PyMuPDF is installed in the interpreter the plugin resolved,
* for a misclassified PDF, the `probe` detail string from the tool result.

For a PDF that routes wrongly, a **page range you are willing to share** is far
more useful than a description — but please do not attach copyrighted papers.
A synthetic two-column sample that reproduces the problem is ideal, and
`tests/fixtures/generate.py` is a good starting point.

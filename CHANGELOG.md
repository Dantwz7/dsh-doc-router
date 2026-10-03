# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-10-03

A threshold-unit release. The block filter that decides which text blocks may vote on
a page's column count now measures **content** instead of **codepoints**, so dense
scripts stop being over-filtered. Latin text is bit-for-bit unchanged: **0 of 71**
corpus verdicts moved.

### Changed

- **`MIN_BLOCK_CHARS` is now counted in *latin-equivalent* codepoints, not raw ones.**
  The threshold is a *content* threshold — "about half a line of body text" — but it
  was compared against `len(text)`, and that is not the same amount of text in every
  script: a Chinese word is 1–2 ideographs where an English word is ~5 letters, so
  the filter was several times more aggressive on Chinese PDFs and discarded real
  body text. When what it discarded was a whole column, the page lost every trace of
  that column and fell back to `unknown`. `_block_weight` now counts an ideograph
  (CJK Unified Ideographs including extension A and the compatibility block, kana,
  Hangul syllables) as `CJK_CHAR_WEIGHT = 2`. Pure-ASCII blocks still take the
  `len()` fast path, so the Latin path is unchanged by construction.

### Added

- **`tests/fixtures/dense-script-column.pdf`**, a controlled comparison against
  `short-column.pdf`: identical geometry and identical left column, but the short
  right column is Chinese instead of Latin. Pre-fix that column is discarded and the
  page comes back `unknown`; post-fix the gutter is measured and it is correctly
  `multi-column` (est 2). `_verify/prove-dense-script-fixture.py` shows both
  directions, swapping the filter **and** its `_dropped_blocks_look_like_a_column`
  guard together — pairing an old filter with a new guard reconstructs a version
  that never shipped. `short-column.pdf` remains the control and stays `unknown`,
  because `Fig. 3a` and `12.5%` really are page furniture.

### Notes

- **The English corpus cannot show this fix working, by construction.** The 71-paper
  trial corpus contains **zero** CJK characters, so a Latin-identical change is
  necessarily invisible on it — which is exactly why the fixture exists. The
  real-world effect was measured separately, on a wider 121-PDF tree containing 26
  Chinese documents: on the Chinese review article, page 6's multi-column evidence
  rises from **0.067 to 0.875** of bands (kept blocks 13 → 71) and page 8's from
  **0.000 to 0.875**. Its document verdict was already `multi-column` and stays so —
  what the fix removes is the reliance on a lucky page.
- **One verdict changed in that 121-PDF tree**, and it is reported rather than
  smoothed over: a single-page figure (`04-图表/图1-五条判据.pdf`) moves
  `unknown` → `single-column`, so its recommendation moves `pdf_markdown` →
  `markitdown`. The page was rendered and inspected: it is one horizontal bar chart
  with no column structure, so the new verdict is consistent with the page. It is not
  a reference paper and carries no shredding risk.
- **Still unverified:** how the npm package page renders GitHub-only syntax
  (`> [!NOTE]` alerts and `<details>`), and whether it resolves relative links to
  files the tarball *does* ship. Unchanged from `0.4.0`; npmjs.com returns HTTP 403
  to the fetch tool. Absolute URLs are used because they are safe under *every*
  renderer, not because npm's behaviour is known.

## [0.4.0] — 2026-10-03

A defaults-and-documentation release. The routing verdict itself is untouched;
what changes is the language its advisory notes come out in, and how the READMEs
are kept honest.

### Added

- **`scripts/check-doc-links.mjs` now checks the npm rendering surface**, not
  just local file existence. It validates absolute GitHub `blob`/`raw` links
  (target path and `#anchor`), and it **diffs every relative link in the READMEs
  against `package.json`'s `files` allow-list** — a relative link to a file the
  tarball does not ship is a 404 on the npm package page even though it works on
  GitHub. It also asserts that the two READMEs keep identical H2 / H3 /
  code-fence / table / `<details>` / badge counts, so the Chinese mirror cannot
  drift from the English primary.
- **`the configured noteLanguage reaches the probe`**, an end-to-end assertion
  that a non-default `noteLanguage` actually arrives in the probe's argv. With
  both sides defaulting to English, a JS layer that silently dropped `--lang`
  would otherwise still look correct through the default alone.

### Changed

- **`noteLanguage` now defaults to `'en'`, not `'zh'`.** The advisory notes travel
  with the tool result, and this project's primary documentation — the README npm
  renders — is English, so English is the default. **This is user-visible for
  existing installs:** a `doc_route` result that carried Chinese advisory lines
  now carries English ones. Set `noteLanguage: 'zh'` to get the previous output.
  The verdict, `recommend` and `probe` fields were always language-neutral and are
  unaffected.
- **README polish**, under the project rule that "qualified" is the floor and
  "beautiful" is the ongoing goal. Quick start is split into numbered
  "1. Route it" / "2. Convert it" steps; Install keeps its four channels
  contiguous and ends with the optional PyMuPDF step; Configuration gained a
  field / default / effect table; and the reproducibility table in "Why this
  exists" now carries both the two- and the three-column fixture.
- `CONTRIBUTING.md` §7 documents the README pass as a release step, separating
  the mechanical checks (`npm run verify:docs`) from the editorial checklist.

### Fixed

- **Eight cross-file links in each README pointed outside the npm tarball.**
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `tests/fixtures/README.md`,
  `tests/fixtures/generate.py`, `tests/manual/README.md`, the bug-report issue
  template and the reading-order fixture were all linked relatively. They resolve
  on GitHub and 404 on npm, because `files` ships nine entries. They now use
  absolute GitHub URLs, which hold under every renderer.
- **`scripts/verify-package.mjs` no longer needs a shell to invoke npm.** When
  `npm_execpath` was unset — a plain `node scripts/verify-package.mjs` — it fell
  back to `spawnSync('npm', args, { shell: true })`, which Node warns about
  (DEP0190: arguments passed alongside `shell: true` are concatenated, not
  escaped). npm ships inside the Node installation, so it is now located from
  `process.execPath` and spawned with `shell: false`.

### Notes

- The three-column row was re-measured for this pass: `pdf_markdown` returns the
  exact `L01…L15` `M01…M15` `R01…R15` sequence (**2** column alternations) where
  MarkItDown 0.1.5 returns `L01 M01 R01 L02 …` (**44**). The two-column figures
  (1 vs 29) are unchanged.
- **Still unverified:** how the npm package page renders GitHub-only syntax
  (`> [!NOTE]` alerts and `<details>`), and whether it resolves relative links to
  files the tarball *does* ship. npmjs.com returns HTTP 403 to the fetch tool and
  the npmmirror page is a client-rendered shell. Absolute URLs are used because
  they are safe under *every* renderer, not because npm's behaviour is known — so
  the callouts and `<details>` blocks are deliberately left alone.

## [0.3.0] — 2026-10-02

This release closes the project's largest **evidence** gap. The suite could not detect a
wrong reading order, two tests claimed a property they never asserted, and the corpus
numbers behind the thresholds were recorded rather than re-runnable. All three are fixed,
and every new assertion was verified to fail on a mutated input before it was trusted.

One user-facing addition — `noteLanguage` — and one user-facing fix: the column detector
could report a two-column page as a confident **single column** when one of its columns
was made entirely of short blocks, which routed it to the unsafe pipeline.

### Added

- **`tests/fixtures/two-column-reading-order.pdf`, and the tests that use it.**
  This closes a real coverage hole: the suite could not detect a wrong reading
  order. Both existing two-column tests asserted only that two substrings from
  `two-column.pdf`'s single shared sentence pool were present, so they passed on
  an interleaved result, a swapped pair of columns, or a truncated one. The new
  fixture's columns are individually identifiable (`L01…L15` | `R01…R15`), and
  `probe.integration.test.mjs` + `tools.integration.test.mjs` now assert the exact
  sequence. Verified to fail on all six mutations tested: row-interleaved,
  swapped, dropped, reversed, and marker-split.
- **`tests/fixtures/three-column.pdf`**, covering the branch the watermark fixture
  only guarded by accident: a layout that genuinely has **three** columns. Two
  columns can be served by "find the gutter down the middle"; three cannot, and a
  middle column of body text is exactly what that implementation missed. The route
  table asserts est **3** and the reading order is asserted as `L → M → R`
  (`L01…L15` | `M01…M15` | `R01…R15`). The shared
  `assertColumnReadingOrder()` helper now backs both column-count cases, and was
  verified to discriminate on 12 mutations across two- and three-column inputs.
- **`tests/fixtures/short-column.pdf`**, the regression fixture for the short-block
  fix below. Two real columns, but the right-hand one is entirely short blocks
  (a figure/table list), so the 25-character filter discards it. Verified to
  discriminate: the pre-fix implementation reports `single-column` and routes to
  `markitdown`; the current one reports `unknown` and routes to `pdf_markdown`.
  Both halves of the premise are asserted in `generate.py`, and `self_check()`
  asserts its `SHORT_BLOCK_CHARS` still equals `docprobe.MIN_BLOCK_CHARS`, so the
  fixture cannot silently decay into a second copy of the two-column case.
- `scripts/check-doc-links.mjs` (`npm run verify:docs`), wired into CI as a `docs`
  job. Renaming a README heading silently rots every anchor that points at it —
  including `.github/ISSUE_TEMPLATE/config.yml`, which links `#how-the-routing-works`
  — so that now fails in CI instead of in a user's browser.
- **`noteLanguage` config option (`'zh'` default, or `'en'`)**, selecting the
  language of `doc_route`'s advisory notes. The verdict, `recommend` and `probe`
  fields stay language-neutral. `zh` is the default so existing installs print
  exactly what they did before. Both languages are asserted, including that the
  English note never claims a single column it did not measure. The real
  schemastery enforces the enum (`$.noteLanguage expected "zh" | "en"`), verified
  against `app.asar` in `tests/manual/real-api.mjs` — the stub-based unit suite
  models defaults only, by design.
- **`assertNotShredded()` in `tests/helpers.mjs`**, so the two tests named
  "without shredding" and "both columns intact" actually assert it. They previously
  checked only that two substrings survived, which an interleaved or table-shredded
  result would also satisfy. The new assertion rejects markdown table rows and
  fragmentation (measured: `pdf_markdown` 283 chars/non-blank line and 0 table rows,
  MarkItDown 43 and 24 on the same fixture) and was verified to pass real
  `pdf_markdown` output while failing MarkItDown's.

### Changed

- **Both READMEs restructured** after a survey of eleven real repositories (three
  comparable document tools, two DSH plugins, eight high-star projects). The
  verdict-first layout is unchanged; what is new is a jump-to row, a requirements
  table under Install, per-parameter output examples, a fixture-derived verdict
  table, and the deeper design notes folded into `<details>`.
- The configuration snippet now shows the real `insert:` wrapper from
  `cordis.patch.yml` instead of a fragment that could not be pasted anywhere.
- **`scripts/verify-package.mjs` now enforces the `files`/`scripts` split.** The
  manifest is shipped verbatim, but `files` excludes `tests/` and `scripts/`, so
  `npm test` and friends name entry points the tarball does not contain. That is
  deliberate — no consumer runs them — but it was latent rather than stated.
  `DEV_ONLY_SCRIPTS` now enumerates the exceptions, and the verifier fails both on
  a script that touches a development-only path without being listed and on a
  listed script that no longer does (no stale entries). Verified to fail on an
  injected violation.
- **The Install section now documents the `dsh plugin --profile` path**, including
  the two ways it surprises you. Both were found by running it, not by reading it:
  `--profile <unknown-name>` does not fail — it **initializes a new, empty profile**
  and installs there, so the plugin never reaches the profile DSH boots; and
  `dsh plugin --profile <name> --help` is not a dry run, because it initializes the
  profile before printing pnpm's help. On this machine the active profile is
  `desktop`, so following the command as originally written would have installed
  into an empty `web` profile instead.
- The licence, contributing and acknowledgement sections are now separate, and the
  READMEs are section-for-section aligned (the Chinese one was missing the `node`
  badge).

### Fixed

- **The 25-character block filter could hide a whole column and route the page to
  the unsafe side.** Building the three-column fixture surfaced this: when one
  column of a two-column page consists only of short blocks — a figure, a table, a
  list of short entries — that column contributes no evidence, the other column
  supplies more than the six blocks and eight bands the detector needs, and the page
  is reported `single-column`. It does not stop at `unknown`, so the document went
  to `markitdown`: the unsafe direction the asymmetric bet exists to prevent.
  Reproduced with a synthetic two-column page.

  `_column_profile` now checks whether the discarded short blocks lie outside the
  surviving text span (a gap of at least `max(6pt, 1.2% of page width)`) and, if so,
  reports **`unknown`** instead of `single-column`. This is a **safe-side-only**
  change: it never asserts multi-column from discarded evidence — that would be a
  guess in the other direction, with no evidence either way.

  Validated against the real 71-PDF trial corpus (read-only) with the pre-fix and
  post-fix implementations run over every file:

  | Measure | Result |
  |---|---|
  | Document verdicts changed | **0 of 71** |
  | Multi-column → not-multi-column (missed detections) | **0** |
  | Page-level profiles changed | **0** |
  | Verdict distribution, before and after | identical: 47 multi / 22 single / 2 unknown |

  An earlier draft of the fix triggered on 2 real pages, both the publisher's
  margin timestamp (`'01 October 2026 09:08:07'` at x=596 on a 612pt page) — that
  is the noise the filter exists to drop, not a column. Excluding the outer 5% of
  the page removed both false triggers, leaving the corpus untouched. The fix
  therefore costs nothing on the corpus that tuned the thresholds, and the defect
  remains real but has **no observed instance in this corpus**.
- **Documentation: the probe's advisory notes were Chinese-only.** They are now
  available in English via `noteLanguage: 'en'`; the English README prints the real
  output instead of eliding it, and localization is no longer a roadmap item.
- **Documentation: the validation section was stale.** It claimed "ten real PDFs".
  The actual corpus trial was 71 PDFs plus one DOCX, with the per-class results and
  the two `0.2.1` regressions now recorded.
- **Documentation: the motivating comparison is not reproducible.** The synthetic
  fixtures verify *classification*, not reading order — on `two-column.pdf`,
  `pdf_markdown` and MarkItDown return the identical 48-sentence sequence, because
  both columns are drawn from one shared sentence pool. Both READMEs now say so
  rather than implying the fixture proves the conversion claim.
- **A stray `tests/fixtures/__pycache__/` inside the repository.** `generate.py` set
  `sys.dont_write_bytecode = True` in its own body, which cannot prevent *its own*
  `.pyc`: Python compiles the module before running it, so only the importing
  process can suppress that. Importing it from `_verify/` therefore left a
  `__pycache__` next to the fixtures. Both places that spawn Python
  (`tests/helpers.mjs`, `scripts/generate-fixtures.mjs`) now set
  `PYTHONDONTWRITEBYTECODE=1`, and the `_verify/` scripts share a single
  `_bootstrap` entry point instead of repeating the flag. The existing stale
  directory was deleted. Note this was never a *shipping* bug — `.gitignore` and
  `verify:package` both already refused it — only working-tree noise.

### Notes

- **The marker fixtures reproduce MarkItDown's interleaving**, so the project's
  central claim is now clone-and-check reproducible. Measured with markitdown
  0.1.5 / pdfminer.six 20260107:

  | Fixture | `pdf_markdown` | MarkItDown |
  |---|---|---|
  | `two-column-reading-order.pdf` | `L01…L15 R01…R15` | `L01 R01 L02 R02 …` — **29 alternations** |
  | `three-column.pdf` | `L01…L15 M01…M15 R01…R15` | `L01 M01 R01 L02 …` — **44 alternations** |

  The suite cannot assert this — MarkItDown is not a test dependency — so the
  measurement is recorded in `tests/fixtures/README.md`.
- **An earlier conclusion is overturned, with its cause.** The same markers drawn
  as one contiguous run with no paragraph gaps read back *correctly* through
  MarkItDown, which briefly suggested the failure was not reproducible with
  synthetic layouts. That was an artefact of the layout: PyMuPDF merges
  contiguous lines into one text block per column, and pdfminer kept those two
  blocks in order. Real paragraph structure — which the column detector needs
  anyway — is what makes the fixture discriminate.
- Fixture design constraint: `_column_profile` reports nothing until a page has
  six text blocks, so the blank line between markers is load-bearing. Drawn
  contiguously, the fixture routes as `unknown`, not `multi-column`.
- Fixture design constraint: `_column_profile` also **drops any text block shorter
  than 25 characters**. A three-column fixture first built with 24-character
  `L`/`R` markers therefore lost two of its three columns and routed as
  `single-column`. Both this and the six-block rule are now enforced by assertions
  inside `generate.py`, so a geometry change fails loudly instead of quietly
  producing a fixture that tests nothing.
- **A three-column layout is not hypothetical.** The single `est 3` file in the
  71-PDF corpus is a Science research article whose body text is three equal
  164pt columns (`[37,201] [215,379] [393,557]`, stable across ~30 bands), with the
  abstract spanning the first two. It was confirmed by eye against a rendered page,
  so the corpus figure "column-count over-estimates: 18 → fixed" still holds: this
  one is a correct estimate, not a residual over-estimate.
- The corpus verdict counts in the READMEs (47 / 22 / 2) were **re-measured** from
  the corpus rather than carried over, by running the probe over all 71 files.
- **The evidence behind the corpus numbers is now navigable and re-runnable.**
  `_verify/` held 100-odd scratch scripts with no index; it now has a `README.md`
  that groups them by investigation with a one-line purpose each, and documents the
  `python -B` / `_bootstrap` bytecode rule. `validate_routing.py` — written when the
  probe lived at `tools/docroute.py`, and broken by the move to `lib/` — was
  repaired and now reproduces the corpus baseline in one command: 71 PDFs →
  **47 / 22 / 2**. `--json` writes a per-file manifest (path, size, pages, verdict,
  estimate, chars/page), so the totals can be **diffed** rather than believed.
  `check_science.py` was repaired the same way, and now selects the article rather
  than its supporting information.

## [0.2.1] — 2026-10-01

Everything here came out of a trial run over a real corpus of 71 published PDFs
and one DOCX (a review's reference library: ACS / Wiley / Science / Nature /
Sci. Adv. / arXiv, 2–83 pages, Chinese directory and file names). The trial
report and the follow-up investigation are reproduced in the fixes below.

### Fixed

- **A column count that cannot be measured is no longer reported as
  single-column.** `columns: unknown` shared a branch with `single-column`, so a
  file whose layout the probe could not measure was routed to `markitdown` with
  a note asserting "single-column with a text layer". For a genuinely
  multi-column paper that is exactly the failure this plugin exists to prevent,
  and it looked like success. `unknown` now routes to `pdf_markdown` — the cheap
  direction under the plugin's own asymmetric bet — and the note says the column
  count could not be determined.
- **A full-height margin stamp is no longer counted as a column.** Publishers
  print a rotated "Downloaded from …" string down the page edge: about 7 pt wide
  but spanning the whole page height, so it lands in *every* horizontal band.
  The estimator correctly excluded edge artefacts from its gap list and then
  returned the **unfiltered** segment count, so a two-column paper reported
  three columns. On the trial corpus this hit **18 of 74** files (every 2-column
  ACS / Wiley / Sci. Adv. / Nano Lett. paper, plus Science reporting 4 for its
  3-column layout). Routing was unaffected — only the qualitative verdict
  matters — but `column_estimate` and the per-page `Probe detail` were wrong.
- **A malformed `pages` value no longer leaks an internal exception class name.**
  The message is written for the user, but reached them as
  `Error: ValueError: invalid page selection 'abc' …`, which reads like a stack
  trace escaping.

### Added

- Two regression fixtures, both verified to fail against the pre-0.2.1 code:
  - `two-column-watermark.pdf` — two real columns plus a rotated full-height
    margin stamp; asserts `column_estimate: 2`, not 3.
  - `unknown-columns.pdf` — a text-bearing PDF whose pages carry no usable band
    evidence; asserts `columns: unknown` **and** `recommend: [pdf_markdown]`.
- Five tests covering the fixes above, including one asserting the `unknown`
  note never contains 单栏, and one asserting the page-selection error never
  contains `ValueError`.

### Notes

- Verified against the trial corpus: the estimator fix changes **exactly** the
  18 files a human had flagged by eye as over-estimated, and leaves the other 56
  (including every single-column SI) untouched.
- The trial report suggested eliminating `unknown` by sampling more pages. That
  was tested and **does not work**: the cause is not the sampling, it is that
  `_column_profile` needs several text blocks to measure bands, and the two
  affected files have either one large block per page or many sub-25-character
  fragments. Re-sampling cannot help, and reducing `unknown` at all would push
  files from the safe side toward the dangerous one — so `unknown` is kept, and
  made safe.

## [0.2.0] — 2026-10-01

First public release: the same routing engine, packaged as a distributable
open-source project.

### Added

- `DOC_ROUTER_PYTHON` environment variable to pin the Python interpreter,
  evaluated after `config.pythonPath` and before the packaged-runtime
  auto-discovery. Useful in CI and containers where no DSH runtime exists.
- Self-contained test suite under `tests/`, runnable with `node --test` on a
  bare clone with **no install step and no network access**. Integration tests
  that need Python + PyMuPDF skip themselves when those are missing.
- Synthetic, repository-owned fixtures (`tests/fixtures/`) plus the generator
  that produces them (`tests/fixtures/generate.py`). No third-party document is
  redistributed.
- `LICENSE`, `NOTICE` (including the PyMuPDF AGPL-3.0 boundary),
  `CONTRIBUTING.md`, `CHANGELOG.md`, `.gitignore`, `.gitattributes`,
  `.editorconfig`.
- GitHub Actions CI: a dependency-free unit job on Linux + Windows, and an
  integration job with PyMuPDF installed.
- English `README.md` as the primary document; the previous Chinese README is
  preserved as `README.zh.md` and updated.
- `doc_route` now reports the version of the copy that is actually loaded
  (`dsh-doc-router v0.2.0`) as the last line of its output. A `file:` install is
  a copy and the host keeps the loaded module in its ESM cache, so "which
  version am I running?" was previously unanswerable from the outside — a stale
  copy went unnoticed until a fix appeared to do nothing. The version is read
  from the adjacent `package.json`, never hardcoded, and degrades to `unknown`
  if the manifest is missing. It is deliberately **not** appended to
  `pdf_markdown` output, which is the converted document itself.

### Changed

- Explicit interpreter selection (`config.pythonPath`, `DOC_ROUTER_PYTHON`) is
  now honoured **unconditionally** instead of being existence-checked. A bare
  command name such as `python3` therefore works, and a mistyped path fails
  loudly naming the interpreter you asked for rather than silently running a
  different one. Auto-discovered candidates are still existence-checked.
- `package.json`: added `repository` / `homepage` / `bugs` / `scripts` /
  `publishConfig`, and an explicit `files` allow-list for the npm tarball.
- Installation guidance now leads with the npm registry path
  (`plugin_manager action=install_bundle target="dsh-doc-router@0.2.0"`), which
  removes the `file:` install path — and with it the copy-not-link update
  problem and the restart requirement — for ordinary users.

### Fixed

- **`pdf_markdown` no longer returns silent garbage for a non-PDF.** PyMuPDF
  1.28 opens docx / xlsx / pptx / png / txt / zip containers as one-page
  "documents" instead of failing, so handing it a Word file used to succeed and
  produce nonsense. The probe now confirms the `%PDF-` magic bytes first and
  refuses with the detected format plus the pipeline to use instead
  (`docx → markitdown`). A silently wrong answer is worse than an error.
- `pdf_markdown` no longer silently converts the **whole document** when a page
  selection matches nothing. `pages: "99"` on a 1-page PDF used to return every
  page while reporting `pages_used: "all"`, so a mistake looked like success;
  it is now an error naming the document's page count.
- A malformed `pages` value (`"abc"`, `"1-"`) now reports which chunk was
  invalid and what forms are accepted, instead of surfacing a bare `ValueError`
  from `int()`. A reversed range (`"3-1"`) is still normalised rather than
  rejected.
- Passing a **directory** now reports `is a directory, not a file`. It used to
  reach the filesystem layer and come back as a bare `PermissionError`
  (Windows) or `IsADirectoryError`, which said nothing about the real problem.
  Checked on both sides: `resolveInput` when the `fs` seam is absent, and
  `docprobe.py` before it opens anything.

## [0.1.1] — 2026-10-01

### Fixed

- Interpreter discovery no longer degrades to a bare `python` on Windows.
  `DSH_HOME` / `DSH_PRIMARY_RUNTIME` are injected per *shell call* by
  `dsh-shell-env`, so the DSH host process has none of them; the first version
  therefore fell back to `python` on `PATH`, which on Windows is frequently the
  Microsoft Store stub (exit code 9009, no output). The plugin now derives the
  harness home from its own module path
  (`$DSH_HOME/profiles/<p>/node_modules/<pkg>/lib`), scans the runtime
  directory for the packaged interpreter, and finally falls back to `~/.dsh`.
- Regression test `resolve-python` added; it deliberately does not spawn, so it
  runs under the DSH file sandbox.

## [0.1.0] — 2026-09-30

### Added

- Initial plugin: the `doc_route` and `pdf_markdown` tools, plus the
  `doc-routing` skill registered into the runtime skill layer so it applies to
  every workspace.
- Deterministic routing rules: format by magic bytes (never by extension), ZIP
  containers opened to tell docx/xlsx/pptx/epub/odt apart, text layer by
  characters-per-page, column count by per-band geometry with an
  "any body page is multi-column ⇒ multi-column" rule.
- `lib/docprobe.py`, a stdlib + PyMuPDF probe that degrades instead of crashing
  when PyMuPDF is absent, and always answers in JSON.

[Unreleased]: https://github.com/Dantwz7/dsh-doc-router/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Dantwz7/dsh-doc-router/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Dantwz7/dsh-doc-router/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Dantwz7/dsh-doc-router/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Dantwz7/dsh-doc-router/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Dantwz7/dsh-doc-router/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Dantwz7/dsh-doc-router/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Dantwz7/dsh-doc-router/releases/tag/v0.1.0

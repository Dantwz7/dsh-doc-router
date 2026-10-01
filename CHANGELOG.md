# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/<your-github-user>/dsh-doc-router/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/<your-github-user>/dsh-doc-router/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/<your-github-user>/dsh-doc-router/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/<your-github-user>/dsh-doc-router/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/<your-github-user>/dsh-doc-router/releases/tag/v0.1.0

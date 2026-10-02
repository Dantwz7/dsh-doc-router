# dsh-doc-router

[![npm](https://img.shields.io/npm/v/dsh-doc-router.svg)](https://www.npmjs.com/package/dsh-doc-router)
[![CI](https://github.com/Dantwz7/dsh-doc-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Dantwz7/dsh-doc-router/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)

[English](README.md) | [中文](README.zh.md)

> **Route before you read.** A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> plugin that inspects a document's *real* format and a PDF's *page layout*, then hands it
> to the extraction pipeline it deserves — converting multi-column papers with layout
> awareness instead of shredding them.

[Why](#why-this-exists) · [What you get](#what-you-get) · [Install](#install) · [Quick start](#quick-start) · [How the routing works](#how-the-routing-works) · [Configuration](#configuration) · [Evidence](#evidence) · [Troubleshooting](#troubleshooting) · [Development](#development) · [Roadmap](#roadmap) · [License](#license)

---

## Why this exists

Default converters get multi-column papers wrong, and the failure is not subtle.
On one Nature Letter (`nmat4749.pdf`, two columns, 7 pages), measured with
PyMuPDF 1.28.2 / MarkItDown 0.2.0:

| Pipeline | Output | Multi-column handling |
|---|---|---|
| `pymupdf4llm` (layout-aware) | 6 533 chars for page 1 | ✅ columns merged in reading order; headings → `#`, superscripts → `<sup>`, `_in situ_` italics kept |
| `pypdf` | 30 632 chars, whole document | ⚠️ text is readable but **structure is gone** |
| MarkItDown | 45 266 chars, whole document | ❌ body text fragmented into hundreds of `\| … \|` table rows |

The same failure is **reproducible from a clone**. On this repository's
[`two-column-reading-order.pdf`](tests/fixtures/two-column-reading-order.pdf) — a
synthetic two-column page whose columns are individually marked — MarkItDown 0.1.5
reads straight down **both** columns at once:

| | `pdf_markdown` | MarkItDown 0.1.5 |
|---|---|---|
| Reading order | `L01…L15`, then `R01…R15` | `L01 R01 L02 R02 …` — **29 column alternations** |

That is the whole argument in one line: one pipeline keeps the columns, the other
interleaves them. `npm test` asserts the first column of that table.

Asking a model to "just pick a converter" therefore produces quietly mangled source
material, and the damage **looks like success**. The fix is not a better single
converter — it is **routing**: look at the file first, then choose the pipeline.

## What you get

| Artifact | Purpose |
|---|---|
| **`doc_route` tool** | Classifies a file and names the pipeline to use: format, page count, whether a text layer exists, single- vs multi-column, plus the per-page evidence behind the verdict |
| **`pdf_markdown` tool** | Layout-aware PDF → Markdown via PyMuPDF; supports a page range and writing to disk |
| **`doc-routing` skill** | Registered into the **runtime** skill layer, so it applies to every workspace without a per-workspace `skills/` directory. Tells the model to route before reading |

Every verdict is **deterministic** — no model call, no network, no token cost.

## Install

### Requirements

| | |
|---|---|
| **DSH** | `>=0.2.0-rc.1 <0.3.0-0` |
| **Node** | `^22.19.0 || >=24.0.0` |
| **Python** | 3.9+ — needed only for PDF layout detection and `pdf_markdown` |
| **PyMuPDF** | `pip install pymupdf4llm` — **optional**; see [license](#license) |

The interpreter is looked up in this order, first hit wins:

1. `config.pythonPath`
2. the `DOC_ROUTER_PYTHON` environment variable
3. the runtime DSH ships
4. a runtime under `~/.dsh/dsh-runtimes`
5. `python` on `PATH`

An explicit choice is taken **verbatim**, so a bare command name like `python3` is
allowed — and a wrong path is reported as *the path you named*, not as a mystery.

### From npm (recommended)

```bash
plugin_manager action=install_bundle target="dsh-doc-router@0.3.0"
```

**Pin the exact version.** DSH's package manager applies a minimum-release-age
policy, and installing by bare name can silently resolve to an older build. Restart
DSH afterwards.

### From the DSH CLI

```bash
dsh plugin --profile <YOUR-PROFILE> add dsh-doc-router@0.3.0
```

`<YOUR-PROFILE>` must be the profile DSH **actually boots**. `plugin_manager` above
targets the active profile for you, so prefer it if you are unsure. Two things this
subcommand does *not* do:

- **A wrong `--profile` name is not an error — it creates one.** The profile is
  initialized as a new, empty profile and the package is installed *there*, so the
  plugin never reaches the profile you are running. The active profile is the
  directory under `$DSH_HOME/profiles` whose `package.json` lists your plugins.
- **`--help` is not a dry run.** `dsh plugin --profile <name> --help` initializes
  that profile before printing pnpm's help.

### Enable layout detection

```bash
<the python the plugin resolved> -m pip install pymupdf4llm
```

Without PyMuPDF the plugin **still loads** and `doc_route` still classifies by
format; only layout detection and `pdf_markdown` are disabled, and both say so
rather than failing obscurely.

### From a checkout instead

```bash
plugin_manager action=install_bundle target="file:<ABSOLUTE-PATH-TO-REPO>"
```

A `file:` install is a **copy**, so editing the source does not take effect: bump
the version, remove the bundle, reinstall and restart DSH. See
[CONTRIBUTING.md](CONTRIBUTING.md#5-testing-against-a-real-dsh-install).

## Quick start

Route first, then convert. The examples below use this repository's own synthetic
fixtures, so every line is reproducible from a clone.

```text
doc_route({ path: "tests/fixtures/two-column.pdf" })

→ Routed tests/fixtures/two-column.pdf — format: pdf, pages: 1, text layer: yes, columns: multi-column (est 2)
  Recommended pipeline: pdf_markdown
  Multi-column body text (est. 2 columns) — markitdown shreds it into table fragments and pypdf drops the structure
  If formulas, super/subscripts or digits must be exact, render that page to an image and check it
  Probe detail: {"1":"0.91/2col"}

  dsh-doc-router v0.3.0
```

> The two advisory lines are English above because this example sets
> `noteLanguage: 'en'`. They default to Chinese (`zh`), which is what existing
> installs already print — see [Configuration](#configuration). The verdict line,
> `recommend`, and `probe` fields are language-neutral either way.

```text
pdf_markdown({ path: "tests/fixtures/two-column.pdf" })

→ Converted tests/fixtures/two-column.pdf (all 1 pages) — 3391 characters of Markdown. …

pdf_markdown({ path: "tests/fixtures/two-column.pdf", pages: "1", output: "paper.md" })

→ Converted tests/fixtures/two-column.pdf (pages 1) — wrote 3391 characters to paper.md.
```

Both tools accept **workspace-relative** paths. When inline output would exceed
`maxChars`, `pdf_markdown` truncates and **says so** instead of flooding the
context — pass `output` to get the whole document on disk.

### Real verdicts, from this repository's fixtures

Every row below was produced by running `doc_route` on the checked-in fixture:

| Fixture | Verdict | Pipeline |
|---|---|---|
| `two-column.pdf` | pdf · 1 page · text layer · **multi-column (est 2)** | `pdf_markdown` |
| `three-column.pdf` | pdf · 1 page · text layer · **multi-column (est 3)** | `pdf_markdown` |
| `two-column-watermark.pdf` | pdf · 1 page · text layer · **multi-column (est 2 — not 3)** | `pdf_markdown` |
| `unknown-columns.pdf` | pdf · 3 pages · text layer · **unknown** | `pdf_markdown` (safe side) |
| `single-column.pdf` | pdf · 1 page · text layer · single-column | `markitdown` → `pypdf` |
| `scanned.pdf` | pdf · 1 page · **no text layer** | `render_to_png` → `read_image` |
| `sample.docx` | docx | `markitdown` |
| `sample.png` | png | `read_image` |
| `sample.txt` | text | `read` |

`pdf_markdown` refuses non-PDFs and names the pipeline to use instead:

```text
pdf_markdown({ path: "tests/fixtures/sample.docx" })
→ pdf_markdown only converts PDFs — detected docx. Recommended pipeline: markitdown
  (run doc_route for the full verdict)
```

> [!NOTE]
> **Advisory language.** The verdict line, `recommend`, and `probe` fields are
> language-neutral. The free-text advisory lines that follow the verdict are
> available in English and Chinese via
> [`noteLanguage`](#configuration) — `zh` by default, so existing installs print
> exactly what they always did.

## How the routing works

All decisions are **deterministic**: zero model calls, zero network, zero tokens.

| Decision | Basis |
|---|---|
| Format | The file header's **magic bytes**, never the extension. ZIP containers are opened to tell docx / xlsx / pptx / epub / odt apart |
| Text layer | Fewer than **120 characters per page** ⇒ treated as a scan |
| Single vs multi-column | Text intervals are merged per horizontal band and the segments separated by *internal* whitespace are counted. **Any body page that is multi-column makes the document multi-column.** Edge artefacts — a publisher's rotated margin stamp, headers, footers — are excluded: they are narrow but run the full page height, so they land in *every* band |

That last rule is a deliberate asymmetric bet: `pymupdf4llm` works fine on
single-column pages too, whereas a missed multi-column page is handed to a
converter that destroys the body text. One mistake is cheap; the other is not.

The same bet decides what happens when the column count **cannot be measured** —
a page whose body is one large block, or many sub-25-character fragments, yields no
usable band evidence. That is reported honestly as `unknown` and routed to
`pdf_markdown`, and is **never** described as single-column: guessing "single
column" is the expensive direction, so a file we cannot measure takes the cheap one.

### The routes

| Verdict | Pipeline |
|---|---|
| multi-column + text layer | `pdf_markdown` |
| single-column + text layer | `markitdown`, falling back to `pypdf` |
| column count unmeasurable (`unknown`) + text layer | `pdf_markdown` — the safe side |
| no text layer | render to PNG → `read_image` |
| docx / xlsx / pptx / epub / odt / csv / html / json / xml | `markitdown` |
| images | `read_image` |
| text / rtf | `read` — no conversion at all |

<details>
<summary><b>Why multi-modal reading is not on the normal path</b></summary>

Format and column count are **geometry problems**. Code is fast, exact and free; a
single 150 dpi page image is roughly 0.5 MB and a thousand tokens, and must be
rendered page by page. Images are therefore reserved for the three things code
cannot do:

1. **No text layer** — a scan.
2. **Exactly verifying formulas, superscripts, Greek letters and units** — text
   extraction gets these wrong in ways that matter (an image shows `Sr₃Al₂O₆`
   correctly; text extraction can only give `Sr3Al2O6`).
3. **Understanding figures, layout, or which caption belongs to which figure.**

</details>

<details>
<summary><b>Three routing bugs worth not reintroducing</b></summary>

1. "Count the text blocks on each side" → on a Nature first page the left column
   held only 2 blocks, so it was misread as single-column. Fixed by finding gutters
   per line instead.
2. "Only look for the gutter down the middle of the page" → a 3-column Science
   layout has body text in the middle, so it was missed. Fixed by counting columns.
3. "Take the majority across pages" → a single-column reference page and a figure
   page tied, tipping the verdict to single-column. Fixed to *any body page
   multi-column ⇒ multi-column*, ignoring pages under 300 characters.

Two further defects were found by a real-corpus trial and fixed in `0.2.1`; both are
regression-tested and written up in [CHANGELOG.md](CHANGELOG.md):

4. A rotated full-height margin stamp was counted as an extra column, so a
   two-column paper reported **three** columns — 18 of 74 corpus files.
5. `columns: unknown` shared a branch with `single-column` and was routed to
   `markitdown` while the note asserted "single-column". This was the one place
   where the plugin contradicted its own asymmetric bet.

</details>

## Configuration

Every field is optional. This is the `config` block of the `doc-router` entry
inserted by [`cordis.patch.yml`](cordis.patch.yml):

```yaml
- insert:
    - id: doc-router
      name: dsh-doc-router
      config:
        pythonPath: C:\path\to\python.exe   # optional; highest-priority interpreter
        timeoutMs: 120000                    # optional; probe timeout, ms
        maxChars: 120000                     # optional; inline Markdown cap
        noteLanguage: zh                     # optional; 'zh' (default) or 'en'
```

`noteLanguage` changes only the human-readable advisory lines. The verdict,
`recommend`, and `probe` fields are language-neutral, and routing is identical in
either language.

## Evidence

The routing rules were exercised over a **real corpus of 71 published PDFs plus one
DOCX** (ACS / Wiley / Science / Nature / Sci. Adv. / arXiv, 2–83 pages, Chinese
directory and file names):

| Check | Result |
|---|---|
| Files routed | 72 |
| Multi-column detected | **47 — every one confirmed multi-column by eye; 0 missed** |
| Single-column detected | 22 — none was actually multi-column |
| Column-count over-estimates | 18 → **fixed in `0.2.1`** |
| `unknown` layouts | 2 → **routed to the safe side in `0.2.1`** |
| "Succeeded" but produced garbage | **0** |
| Verdicts changed by the short-block filter fix | **0 of 71** (whole corpus re-run, pre- vs post-fix) |

One of the 47 is a genuine **three-column** Science article (three equal 164pt
columns, abstract spanning the first two), so the `est 3` branch is exercised by
real input and not only by the synthetic fixture.

On one page of a Science paper, the same input through both paths:

| | `pdf_markdown` | MarkItDown |
|---|---|---|
| Characters | 5 959 | 11 987 |
| `\| --- \|` table separators | **0** | 24 |
| Word spaces lost mid-word | **0** | 36 (e.g. `constants.Theresultantcoherentgrowthof`) |

Cost and reliability on the same corpus: `doc_route` took about **0.4 s**;
`pdf_markdown` about **7.7 s** for a typical paper and **29.7 s** for an 83-page one.
Across 72 routes and 44 conversions on **non-ASCII paths**, there were **0 path
failures**.

> [!NOTE]
> The interleaving above is reproducible from a clone on a synthetic fixture. The
> table in this section uses **real published papers** because that is the harsher
> test — and those cannot be redistributed, so their exact numbers are recorded
> rather than reproducible. See [tests/fixtures/README.md](tests/fixtures/README.md).
>
> The corpus totals are, however, **re-runnable in one command** against a corpus
> you supply: `python -B _verify/validate_routing.py --json out.json` prints the
> per-file verdict table and the totals. The recorded run is kept as a per-file
> manifest (path, size, pages, verdict, estimate, chars/page for all 71 files), so
> the numbers can be *diffed* rather than merely believed.

## Troubleshooting

**`docprobe failed … Microsoft Store … exit code 9009`** — the `python` on `PATH` is
the Windows Store placeholder. Point `pythonPath` (or `DOC_ROUTER_PYTHON`) at a real
interpreter.

**`PyMuPDF is not installed`** — the interpreter the plugin resolved is not the one
you installed PyMuPDF into. Set `pythonPath` explicitly to see which one it chose,
or install into the packaged runtime under `$DSH_HOME/dsh-runtimes/`. Note that a
**DSH upgrade can overwrite that runtime's `site-packages`**, so reinstall PyMuPDF
afterwards.

**`page selection '99' matched no pages; the document has 1 page(s)`** — the page
range is validated against the real page count. Use `"3"`, `"1-3"` or `"1,4,7"`.

**A clearly two-column paper routes as single-column** — please open an issue with
the `probe` detail string from the tool result; it carries the per-page
"multi-column share / column count" evidence. A **synthetic** sample that
reproduces the problem is ideal, and [`tests/fixtures/generate.py`](tests/fixtures/generate.py)
is a good starting point.

## Development

**No build step and no install step.** A bare clone runs the tests immediately:

```bash
git clone https://github.com/Dantwz7/dsh-doc-router.git
cd dsh-doc-router
npm test                 # unit tests run anywhere; integration tests skip without PyMuPDF
npm run test:unit        # no external dependencies at all
npm run fixtures         # regenerate tests/fixtures/ (needs Python + PyMuPDF)
npm run verify:package   # assert what `npm publish` would upload
```

```text
lib/index.js        the plugin: tool definitions, interpreter discovery, spawning
lib/docprobe.py     stdlib + PyMuPDF: format sniffing, column geometry, extraction
cordis.patch.yml    bundle layer: inserts the plugin into the DSH composition
tests/              node --test suite + synthetic fixtures
scripts/            fixture generation, package-content verification
.github/workflows/  CI
```

One further check needs a real DSH installation:
[`tests/manual/real-api.mjs`](tests/manual/README.md) drives the plugin with the
**real** `defineTool` and schemastery out of the DSH `app.asar` — the load-time
surface that a cold start fails on.

Routing rules are meant to stay deterministic. If you change a threshold in
`lib/docprobe.py`, update the rationale in its docstring **and** the table above, and
add a fixture that exercises the new boundary. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the non-negotiables and the release process.

## Roadmap

- [x] Publish to npm so installation no longer needs a `file:` path. — **done:
      [`dsh-doc-router@0.3.0`](https://www.npmjs.com/package/dsh-doc-router) is live
      on the public registry.**
- [x] **Localize the probe's advisory notes.** — **done:** `noteLanguage: 'en'`
      selects English notes (`zh` remains the default, so existing installs are
      unaffected). Both languages are asserted by the test suite.
- [x] **Make the fixtures prove reading order.** — **done:**
      `two-column-reading-order.pdf` carries per-column markers (`L01…L15` |
      `R01…R15`) and the suite asserts the exact sequence, so an interleaved,
      swapped, reordered or dropped column now fails the build.
      `three-column.pdf` (`L01…L15` | `M01…M15` | `R01…R15`) extends this to a
      middle column, which a "find the gutter down the middle" implementation
      misses — and which real input does contain: one paper in the trial corpus is
      a genuine three-column Science article.
- [x] **Stop the 25-character block filter from hiding a whole column.** — **done:**
      the filter is column-agnostic, so when one column of a two-column page
      consisted only of short blocks — a figure, a table, a list of short entries —
      it contributed no evidence, the other column looked like a confident
      single-column page, and the document was routed to `markitdown`: the unsafe
      direction. `_column_profile` now reports `unknown` (→ `pdf_markdown`) when the
      discarded blocks lie outside the surviving text span. Safe-side only: it never
      asserts multi-column from discarded evidence. Re-run over the whole 71-paper
      trial corpus, **0 verdicts changed**, so nothing the thresholds were tuned for
      regressed; `short-column.pdf` pins the behaviour.
- [ ] Pluggable PDF backend, so a permissively licensed engine can replace PyMuPDF
      where AGPL is not an option.
- [ ] TypeScript declarations for the exported surface.
- [ ] Optional OCR route for scanned pages, which currently stop at "render to PNG
      and look at it".

## Contributing

Issues and pull requests are welcome. Bug reports are far more actionable with the
full `doc_route` result for the file — the [issue template](.github/ISSUE_TEMPLATE/bug_report.yml)
asks for exactly that. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first.

## License

MIT — see [LICENSE](LICENSE).

### ⚠️ PyMuPDF is AGPL-3.0 or commercial

`pdf_markdown` and PDF layout detection go through PyMuPDF, which Artifex licenses
under the **GNU AGPL-3.0 or a commercial license**. The distinction matters:

- This plugin's own code is MIT. It does **not** bundle or link PyMuPDF; it starts an
  interpreter as a subprocess and exchanges JSON over stdio.
- If you **distribute PyMuPDF alongside this plugin** (a container image, an
  installer, a packaged desktop app), *your* distribution now contains an AGPL-3.0
  program, and you must satisfy AGPL-3.0 for it or buy a commercial license from
  Artifex.
- If you run this as part of a **network-accessible service**, AGPL §13 may require
  you to offer the corresponding source to users of that service.

Peer dependencies (`@deepseek-ai/dsh-tools` BSD-3-Clause; `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery` MIT) are supplied by DSH and never bundled. Full details
are in [NOTICE](NOTICE). That file describes upstream licensing; it is **not legal
advice**.

## Acknowledgements

- [PyMuPDF](https://github.com/pymupdf/PyMuPDF) / `pymupdf4llm` — layout-aware PDF
  extraction, AGPL-3.0 (see above).
- [MarkItDown](https://github.com/microsoft/markitdown) — the default converter for
  everything that is not a multi-column PDF.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the host this
  plugin is written against.

Trademarks belong to their respective owners; this project is not affiliated with or
endorsed by any of them.

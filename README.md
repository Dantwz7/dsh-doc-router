# dsh-doc-router

**Route before you read.** A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin that inspects a document's *real* format and a PDF's *page layout*, then
tells you which extraction pipeline it deserves — and converts multi-column PDFs
with layout awareness instead of shredding them.

[![npm](https://img.shields.io/npm/v/dsh-doc-router.svg)](https://www.npmjs.com/package/dsh-doc-router)
[![CI](https://github.com/Dantwz7/dsh-doc-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Dantwz7/dsh-doc-router/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)

[中文说明 →](README.zh.md)

---

## The problem it solves

Default converters get multi-column papers wrong, and the failure is not subtle.
On one Nature Letter (`nmat4749.pdf`, two columns, 7 pages), measured on the
author's machine with PyMuPDF 1.28.2 / MarkItDown 0.2.0:

| Pipeline | Output | Multi-column handling |
|---|---|---|
| `pymupdf4llm` (layout-aware) | 6 533 chars for page 1 | ✅ columns merged in reading order; headings → `#`, superscripts → `<sup>`, `_in situ_` italics kept |
| `pypdf` | 30 632 chars, whole document | ⚠️ text is readable but **structure is gone** |
| MarkItDown | 45 266 chars, whole document | ❌ body text fragmented into hundreds of `\| … \|` table rows |

Asking a model to "just use a converter" therefore produces quietly mangled
source material. The fix is not a better single converter — it is **routing**:
look at the file first, then pick the pipeline.

## What it does

Three artifacts:

| Artifact | Purpose |
|---|---|
| **`doc_route` tool** | Classifies a file and returns the pipeline to use: format, page count, whether a text layer exists, single- vs multi-column, plus the per-page evidence behind the verdict |
| **`pdf_markdown` tool** | Layout-aware PDF → Markdown via PyMuPDF; supports a page range and writing to disk |
| **`doc-routing` skill** | Registered into the **runtime** skill layer, so it applies to every workspace without a per-workspace `skills/` directory. Tells the model to route before reading |

## Install

```bash
plugin_manager action=install_bundle target="dsh-doc-router@0.2.1"
```

Pin the exact version. DSH's package manager applies a minimum-release-age
policy, and installing by bare name can silently resolve to an older build.

Then make sure the interpreter the plugin finds has PyMuPDF:

```bash
<the python the plugin resolved> -m pip install pymupdf4llm
```

Without PyMuPDF the plugin still loads and `doc_route` still classifies by
format; only layout detection and `pdf_markdown` are disabled, and both say so
rather than failing obscurely.

### Installing from a checkout instead

```bash
plugin_manager action=install_bundle target="file:<ABSOLUTE-PATH-TO-REPO>"
```

A `file:` install is a **copy**, so editing the source does not take effect: you
must bump the version, remove the bundle, reinstall and restart DSH. See
[CONTRIBUTING.md](CONTRIBUTING.md#5-testing-against-a-real-dsh-install).

## Usage

```text
doc_route({ path: "paper.pdf" })
→ Routed paper.pdf — format: pdf, pages: 7, text layer: yes, columns: multi-column (est 2)
  Recommended pipeline: pdf_markdown
  multi-column body (est 2 columns) → markitdown shreds body text into table rows, pypdf loses structure

pdf_markdown({ path: "paper.pdf", pages: "1-3" })
→ Converted paper.pdf (pages 1,2,3) — 18422 characters of Markdown. …

pdf_markdown({ path: "paper.pdf", output: "paper.md" })
→ Converted paper.pdf (all 7 pages) — wrote 41203 characters to paper.md.
```

Both tools accept a workspace-relative path, and `pdf_markdown` truncates long
inline output at `maxChars` instead of flooding the context — pass `output` to
keep the whole document.

## How the routing works

Every rule is **deterministic** — no model call, no network, no token cost.

| Decision | Basis |
|---|---|
| Format | File **magic bytes**, never the extension. ZIP containers are opened and their contents inspected to separate docx / xlsx / pptx / epub / odt |
| Text layer | characters per page < 120 ⇒ treated as a scan |
| Single vs multi column | per horizontal band, merge text intervals and count the segments separated by interior whitespace; **any** body page being multi-column ⇒ multi-column. Edge artefacts — a publisher's full-height margin stamp, a header or footer — are excluded: they are narrow but span the whole page, so they land in every band |

The last rule is a deliberately asymmetric bet: `pymupdf4llm` handles
single-column pages fine, whereas missing a multi-column page hands the body
text to a converter that destroys it. One misclassification is cheap, the other
is not.

The same bet decides what happens when the column count **cannot be measured** —
a page whose text arrives as one large block, or as many short fragments, yields
no usable band evidence. That verdict is reported honestly as `unknown` and
routed to `pdf_markdown`, never asserted to be single-column: guessing "one
column" is the expensive direction, so an unmeasurable file takes the cheap one.

The resulting routes:

| Verdict | Pipeline |
|---|---|
| multi-column + text layer | `pdf_markdown` |
| single-column + text layer | `markitdown` (fallback: `pypdf`) |
| column count undecidable (`unknown`) + text layer | `pdf_markdown` — the safe side |
| no text layer | render to PNG → `read_image` |
| docx / xlsx / pptx / epub / odt / csv / html / json / xml | `markitdown` |
| image | `read_image` |
| text / rtf | `read` — no conversion at all |

### Why multi-modal is not part of the normal path

Format and column count are geometric questions. Code answers them quickly,
accurately and for free, while a 150 dpi page image costs roughly 0.5 MB and
over a thousand tokens and must be rendered page by page. So images are reserved
for the three cases code cannot handle:

1. **no text layer** (a scan),
2. **exact verification of formulas, superscripts, Greek letters or units** —
   text extraction gets these wrong in ways that matter (an image shows
   `Sr₃Al₂O₆` correctly where text extraction yields `Sr3Al2O6`),
3. **understanding a figure, a chart, or which caption belongs to which panel**.

### Validation

Ten real PDFs — Nature and Science letters, Nature Materials and Acta Physica
Sinica papers, three journal SI appendices, and a single-column journal blurb —
were classified correctly, including a three-column Science layout.

Three defects found and fixed during development, all of which are easy to
reintroduce:

1. Counting text blocks per column misclassified a Nature page whose left column
   held only two blocks. Fixed by finding the gutter per horizontal band.
2. Looking only for the single gutter in the middle of the page missed
   three-column layouts. Fixed by counting columns.
3. Majority-voting across pages let a single-column references page outvote
   multi-column body pages. Fixed by the "any body page ⇒ multi-column" rule,
   with pages under 300 characters (figure-only pages) excluded.

## Requirements

| | |
|---|---|
| **Node** | `^22.19.0 || >=24.0.0` |
| **DSH** | `>=0.2.0-rc.1 <0.3.0-0` (peer ranges on `@deepseek-ai/dsh*`) |
| **Python** | 3.9+, only for PDF layout detection and `pdf_markdown` |
| **PyMuPDF** | `pip install pymupdf4llm` — **optional**, see [License](#license) |

The plugin locates an interpreter in this order: `config.pythonPath` →
`DOC_ROUTER_PYTHON` → the packaged DSH runtime → `~/.dsh/dsh-runtimes` →
`python` on `PATH`. An explicitly configured interpreter is used as-is, so a
bare command name works and a typo fails loudly naming the path you asked for.

## Configuration

```yaml
# cordis.patch.yml
- id: doc-router
  name: dsh-doc-router
  config:
    pythonPath: C:\path\to\python.exe   # optional; wins over all discovery
    timeoutMs: 120000                    # optional; probe timeout
    maxChars: 120000                     # optional; inline Markdown cap
```

## Troubleshooting

**`docprobe failed … Microsoft Store … exit code 9009`** — `python` on your
`PATH` is the Windows Store stub. Point `pythonPath` (or `DOC_ROUTER_PYTHON`) at
a real interpreter.

**`PyMuPDF is not installed`** — the interpreter the plugin resolved is not the
one you installed into. Check which one it picked by setting `pythonPath`
explicitly, or install into the packaged runtime under
`$DSH_HOME/dsh-runtimes/`. Note that a DSH upgrade can replace that runtime's
site-packages; reinstall PyMuPDF afterwards.

**A PDF routes as single-column when it is not** — please open an issue with the
`probe` detail string from the tool result; it carries the per-page
ratio/column evidence. A synthetic reproduction is ideal and
`tests/fixtures/generate.py` is a good starting point.

## Development

No build step and no install step. `npm test` runs on a bare clone.

```bash
git clone https://github.com/Dantwz7/dsh-doc-router.git
cd dsh-doc-router
npm test                 # unit tests run everywhere; integration tests skip without PyMuPDF
npm run test:unit        # dependency-free
npm run fixtures         # regenerate tests/fixtures/ (needs Python + PyMuPDF)
```

The fixtures are synthetic and generated by this repository — no published paper
is redistributed. See [tests/fixtures/README.md](tests/fixtures/README.md).

One extra check needs a real DSH install: `tests/manual/real-api.mjs` drives the
plugin against the **real** `defineTool` and schemastery from `app.asar`, which
is the load-time surface a cold start would fail on. See
[tests/manual/README.md](tests/manual/README.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the routing-rule invariants, the DSH
bundle gates, and the release process.

## License

MIT — see [LICENSE](LICENSE).

### ⚠️ PyMuPDF is AGPL-3.0-or-commercial

`pdf_markdown` and PDF layout probing run through PyMuPDF, which Artifex
licenses as **GNU AGPL-3.0 or a commercial license**. The distinction matters:

- This plugin's own code stays MIT. It does not bundle or link PyMuPDF; it
  starts an interpreter as a child process and exchanges JSON on stdio.
- If you **redistribute PyMuPDF alongside this plugin** — a container image, an
  installer, a bundled desktop app — then *your* distribution includes an
  AGPL-3.0 program and you must satisfy AGPL-3.0 for it, or buy a commercial
  license from Artifex.
- If you run this as part of a **network-accessible service**, AGPL §13 may
  require you to offer the corresponding source to users of that service.

Peer dependencies (`@deepseek-ai/dsh-tools` BSD-3-Clause; `@deepseek-ai/cordis`
and `@deepseek-ai/schemastery` MIT) are supplied by DSH and never bundled. Full
details in [NOTICE](NOTICE). That file describes upstream licensing; it is not
legal advice.

## Roadmap

- [x] Publish to npm so installation no longer needs a `file:` path. — **done:
      [`dsh-doc-router@0.2.1`](https://www.npmjs.com/package/dsh-doc-router) is
      live on the public registry.**
- [ ] Pluggable PDF backend, so a permissively licensed engine can replace
      PyMuPDF where AGPL is not an option.
- [ ] TypeScript declarations for the exported surface.
- [ ] Optional OCR route for scanned pages, which currently stop at
      "render to PNG and look at it".

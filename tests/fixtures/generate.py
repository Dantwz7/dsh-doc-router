#!/usr/bin/env python3
"""Generate the synthetic fixtures used by the test suite.

Everything this script writes is **original synthetic content owned by this
repository** — no published paper, no third-party document, no personal data.
That is deliberate: the test suite must be reproducible and redistributable,
and real papers cannot be committed.

Usage
-----
    python tests/fixtures/generate.py            # write fixtures + self-check
    python tests/fixtures/generate.py --no-check # write only

The script imports the plugin's own probe (`lib/docprobe.py`) and asserts that
each generated PDF classifies the way the tests expect. If a future change to
the column-geometry heuristics breaks that, regenerating fixtures fails loudly
instead of silently producing fixtures that no longer test what they claim.

Requirements: PyMuPDF (required for the PDFs). python-docx / openpyxl /
python-pptx are optional — without them the corresponding Office fixtures are
skipped and a warning is printed; the committed copies stay valid.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

# This script imports `docprobe` for its self-check, and importing a module
# writes a __pycache__ beside it — which then gets picked up by the npm `files`
# allow-list and shipped in the tarball. Running the probe as a script never
# does this; only the import here would.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))

PAGE_W, PAGE_H = 595.0, 842.0  # A4 in points
MARGIN = 56.0
TOP, BOTTOM = 64.0, 782.0
GUTTER = 30.0
FONT, SIZE, LEADING = "helv", 9.5, 12.0

# Synthetic stand-in for the publisher stamp that runs down a PDF's page edge.
MARGIN_STAMP = (
    "15214095, 2024, 15, Downloaded from https://example.invalid/library "
    "by a subscribing institution on 01 October 2026. "
) * 6

SENTENCES = (    "Document routing decides which extraction pipeline a file deserves.",
    "A converter that ignores page geometry will interleave columns of text.",
    "The probe reads the file header instead of trusting the extension.",
    "Layout is measured per horizontal band, not from the page as a whole.",
    "A scanned page carries no text layer and must be rendered as an image.",
    "Structure is lost when a layout-aware reader is replaced by a naive one.",
    "Magic bytes are authoritative because extensions are frequently wrong.",
    "Every decision here is deterministic, offline, and free of model calls.",
    "The gutter between columns is found by merging text intervals per band.",
    "Superscripts, italics and headings survive a layout-aware conversion.",
    "A single reference page must not outvote multi-column body pages.",
    "The correct pipeline for a two-column paper is the layout-aware one.",
)


def paragraphs(rng: random.Random, count: int) -> list[str]:
    """Build `count` paragraphs of plausible filler prose."""
    return [
        " ".join(rng.choice(SENTENCES) for _ in range(rng.randint(3, 5)))
        for _ in range(count)
    ]


def wrap(text: str, width_chars: int) -> list[str]:
    """Greedy word wrap. Helvetica's average glyph is ~0.5em wide, which is
    accurate enough to keep lines inside their column without a font metric
    round trip."""
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and len(candidate) > width_chars:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def _draw_column(page, x: float, width: float, lines: list[str], gap_lines: int) -> None:
    """Draw wrapped lines down a column, leaving `gap_lines` blank lines between
    paragraphs so the extractor sees them as distinct blocks."""
    y = TOP
    width_chars = max(20, int(width / (0.5 * SIZE)))
    for text in lines:
        for line in wrap(text, width_chars):
            if y > BOTTOM:
                return
            page.insert_text((x, y), line, fontname=FONT, fontsize=SIZE)
            y += LEADING
        y += gap_lines * LEADING


def build_pdf(path: Path, columns: int, seed: int, gap_lines: int) -> None:
    """Render a one- or two-column text page. Column count is real geometry:
    two text boxes side by side, not two columns faked with whitespace."""
    import pymupdf

    rng = random.Random(seed)
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)

    if columns == 1:
        _draw_column(page, MARGIN, PAGE_W - 2 * MARGIN, paragraphs(rng, 10), gap_lines)
    else:
        col_w = (PAGE_W - 2 * MARGIN - GUTTER) / 2
        _draw_column(page, MARGIN, col_w, paragraphs(rng, 6), gap_lines)
        _draw_column(page, MARGIN + col_w + GUTTER, col_w, paragraphs(rng, 6), gap_lines)

    doc.save(str(path))
    doc.close()


def build_watermarked_pdf(path: Path, seed: int, gap_lines: int) -> None:
    """Two real columns plus a full-height, ~7pt-wide margin stamp.

    Publishers (Wiley, ACS) print a rotated "Downloaded from ..." string down
    the page edge. It is narrow but spans the whole page height, so it lands in
    *every* horizontal band. Counting it as a column made the estimator report
    three columns for a two-column paper — on a real 74-paper corpus that hit 18
    files. Regression here silently inflates `column_estimate` for most
    published PDFs.
    """
    import pymupdf

    rng = random.Random(seed)
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)

    col_w = (PAGE_W - 2 * MARGIN - GUTTER) / 2
    _draw_column(page, MARGIN, col_w, paragraphs(rng, 6), gap_lines)
    _draw_column(page, MARGIN + col_w + GUTTER, col_w, paragraphs(rng, 6), gap_lines)

    # Rotated, so a single text block runs the height of the page at the edge.
    page.insert_text(
        (PAGE_W - 14, PAGE_H - 24),
        MARGIN_STAMP,
        fontname=FONT,
        fontsize=5.5,
        rotate=90,
    )
    doc.save(str(path))
    doc.close()


def build_unknown_pdf(path: Path, pages: int = 3) -> None:
    """A text-bearing PDF whose pages carry no usable column evidence.

    Each page's text arrives as one large block, and `_column_profile` needs
    several blocks to measure bands, so it returns None for every page and the
    probe must answer `columns: unknown` rather than guess. That state is
    load-bearing: it routes to the safe side (`pdf_markdown`), because guessing
    "single column" here would send a possibly multi-column paper to a converter
    that shreds its body text.
    """
    import pymupdf

    body = " ".join(SENTENCES) * 6
    doc = pymupdf.open()
    for _ in range(pages):
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        page.insert_textbox(
            pymupdf.Rect(MARGIN + 16, TOP, PAGE_W - MARGIN - 16, BOTTOM),
            body,
            fontname=FONT,
            fontsize=SIZE,
        )
    doc.save(str(path))
    doc.close()


def build_scanned(path: Path, source: Path) -> None:
    """Wrap a rendered page in an image-only PDF: zero text layer, so the
    router must recommend the image pipeline.

    JPEG rather than PNG, because a fixture is committed to the repository and
    a lossless full-page raster costs over a megabyte. Real scans are JPEG or
    CCITT anyway, so this is also the more faithful shape.
    """
    import pymupdf

    src = pymupdf.open(str(source))
    pix = src[0].get_pixmap(dpi=100, colorspace=pymupdf.csGRAY)
    src.close()

    out = pymupdf.open()
    page = out.new_page(width=pix.width, height=pix.height)
    page.insert_image(page.rect, stream=pix.tobytes("jpg", jpg_quality=55))
    out.save(str(path), deflate=True, garbage=3)
    out.close()


def build_png(path: Path) -> None:
    """A small chart-ish raster, for the `read_image` branch."""
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page(width=320, height=200)
    page.insert_text((24, 40), "Measured accuracy", fontname="helv", fontsize=13)
    for i, value in enumerate((0.81, 0.87, 0.79)):
        page.draw_rect(
            pymupdf.Rect(40 + i * 70, 160 - value * 110, 90 + i * 70, 160),
            color=None,
            fill=(0.20, 0.45, 0.75),
        )
        page.insert_text(
            (48 + i * 70, 178), f"m{i + 1}", fontname="helv", fontsize=10
        )
    page.get_pixmap(dpi=96).save(str(path))
    doc.close()


def _write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    """Write LF line endings on every platform.

    `Path.write_text` translates `\\n` to the platform separator, so on Windows
    the fixtures would land as CRLF while `.gitattributes` normalises the
    repository to LF — leaving every Windows contributor with a permanently
    dirty working tree.
    """
    with path.open("w", encoding=encoding, newline="\n") as fh:
        fh.write(text)


def build_text_fixtures() -> None:
    """Plain-text-ish fixtures. No library needed, so these are always written."""
    _write_text(
        HERE / "sample.txt",
        "Plain text needs no conversion.\nSecond line for good measure.\n",
    )
    _write_text(
        HERE / "sample.csv",
        "model,params,score\nalpha,1.3B,0.81\nbeta,7B,0.87\n",
    )
    _write_text(
        HERE / "sample.json",
        json.dumps({"model": "alpha", "score": 0.81, "tags": ["routing"]}, indent=2) + "\n",
    )
    _write_text(
        HERE / "sample.html",
        "<!doctype html>\n<html><body>\n<h1>Routing report</h1>\n"
        "<p>Body paragraph.</p>\n<ul><li>one</li><li>two</li></ul>\n"
        "</body></html>\n",
    )
    # A minimal, *valid* RTF document: {\rtf1 ... } with an escape and a group.
    _write_text(
        HERE / "sample.rtf",
        r"{\rtf1\ansi\deff0{\fonttbl{\f0 Helvetica;}}\f0\fs20 "
        r"Routing report\par Second paragraph with an escape: \'e9.\par}",
        encoding="ascii",
    )


def build_magic_only_fixtures() -> None:
    """Header-only probes for the magic-byte branch.

    These are deliberately NOT complete documents. `doc_route` classifies by
    file header, so a header-only file is the honest minimal input for that
    rule — and it keeps a 100-byte fixture from being mistaken for real
    content. See tests/fixtures/README.md.
    """
    (HERE / "magic-ole2.doc").write_bytes(
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 504
    )
    import zipfile

    with zipfile.ZipFile(HERE / "magic-plain.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("readme.txt", "A plain zip container: not an Office file.\n")


def build_office_fixtures() -> list[str]:
    """Office fixtures via their native libraries. Optional: skip if missing."""
    written: list[str] = []

    try:
        from docx import Document
        from docx.shared import Pt  # noqa: F401  (kept for future styling)

        doc = Document()
        doc.add_heading("Routing report", level=1)
        doc.add_paragraph("Generated by tests/fixtures/generate.py.")
        doc.add_heading("Method", level=2)
        for item in ("header sniffing", "column geometry", "text-layer density"):
            doc.add_paragraph(item, style="List Bullet")
        table = doc.add_table(rows=3, cols=2)
        table.style = "Table Grid"
        for r, row in enumerate([["group", "score"], ["alpha", "0.81"], ["beta", "0.87"]]):
            for c, value in enumerate(row):
                table.cell(r, c).text = value
        doc.save(str(HERE / "sample.docx"))
        written.append("sample.docx")
    except ImportError:
        print("warn: python-docx missing -> sample.docx not regenerated", file=sys.stderr)

    try:
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "scores"
        ws.append(["model", "params", "score"])
        ws.append(["alpha", "1.3B", 0.81])
        ws.append(["beta", "7B", 0.87])
        wb.save(str(HERE / "sample.xlsx"))
        written.append("sample.xlsx")
    except ImportError:
        print("warn: openpyxl missing -> sample.xlsx not regenerated", file=sys.stderr)

    try:
        from pptx import Presentation

        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = "Routing report"
        slide.placeholders[1].text = "Format sniffing\nColumn geometry\nText-layer density"
        prs.save(str(HERE / "sample.pptx"))
        written.append("sample.pptx")
    except ImportError:
        print("warn: python-pptx missing -> sample.pptx not regenerated", file=sys.stderr)

    return written


EXPECTED = {
    "single-column.pdf": {"columns": "single-column", "text_layer": True},
    "two-column.pdf": {"columns": "multi-column", "text_layer": True, "column_estimate": 2},
    "two-column-watermark.pdf": {
        "columns": "multi-column",
        "text_layer": True,
        "column_estimate": 2,
    },
    "unknown-columns.pdf": {
        "columns": "unknown",
        "text_layer": True,
        "recommend": ["pdf_markdown"],
    },
    "scanned.pdf": {"text_layer": False},
    "sample.docx": {"format": "docx"},
    "sample.xlsx": {"format": "xlsx"},
    "sample.pptx": {"format": "pptx"},
    "sample.png": {"format": "png"},
    "sample.rtf": {"format": "rtf"},
    "magic-ole2.doc": {"format": "ole2"},
    "magic-plain.zip": {"format": "zip"},
}


def self_check() -> int:
    """Assert each fixture routes the way the tests assume."""
    import docprobe  # noqa: E402  (path inserted above)

    failures: list[str] = []
    for name, expected in EXPECTED.items():
        path = HERE / name
        if not path.exists():
            failures.append(f"{name}: missing")
            continue
        result = docprobe.route(path)
        for key, want in expected.items():
            got = result.get(key)
            if got != want:
                failures.append(f"{name}: {key} expected {want!r}, got {got!r}")
        detail = {
            k: result.get(k)
            for k in ("format", "columns", "column_estimate", "text_layer", "chars_per_page")
            if k in result
        }
        print(f"  {name:20s} {detail}")

    if failures:
        print("\nSELF-CHECK FAILED:", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        return 1
    print("\nself-check passed: every fixture routes as expected")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-check",
        action="store_true",
        help="write fixtures without asserting their routing classification",
    )
    parser.add_argument(
        "--gap-lines",
        type=int,
        default=1,
        help="blank lines between paragraphs in the generated PDFs (default 1)",
    )
    args = parser.parse_args(argv)

    try:
        import pymupdf  # noqa: F401
    except ImportError:
        print(
            "error: PyMuPDF is required to generate the PDF fixtures.\n"
            "       pip install pymupdf4llm",
            file=sys.stderr,
        )
        return 2

    HERE.mkdir(parents=True, exist_ok=True)
    build_pdf(HERE / "single-column.pdf", columns=1, seed=7, gap_lines=args.gap_lines)
    build_pdf(HERE / "two-column.pdf", columns=2, seed=11, gap_lines=args.gap_lines)
    build_watermarked_pdf(HERE / "two-column-watermark.pdf", seed=23, gap_lines=args.gap_lines)
    build_unknown_pdf(HERE / "unknown-columns.pdf")
    build_scanned(HERE / "scanned.pdf", HERE / "single-column.pdf")
    build_png(HERE / "sample.png")
    build_text_fixtures()
    build_magic_only_fixtures()
    office = build_office_fixtures()

    print(f"wrote fixtures to {HERE}")
    if office:
        print("office fixtures:", ", ".join(office))
    if args.no_check:
        return 0
    print("\nrouting self-check:")
    return self_check()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

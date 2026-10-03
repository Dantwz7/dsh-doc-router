#!/usr/bin/env python
"""docprobe.py — 文档路由探测与版面感知提取，供 dsh-doc-router 插件调用。

两个模式，都以 JSON 写到 stdout（UTF-8）：

    docprobe.py route    <path>
    docprobe.py markdown <path> [--pages 1-3|1,3,5]

`route` 是确定性判据：按魔数判格式、按版面几何判栏数、按字符数判有无文字层。
`markdown` 走 PyMuPDF 的版面感知转换（正确合并多栏），这是 markitdown 做不到的。

设计要点：
- PyMuPDF / pymupdf4llm 缺失时**不崩**，降级为「格式已知、版面未知」，并给出安装提示。
- 任何异常都转成 {"error": ...} 的 JSON，让插件侧拿到可读原因而不是 traceback。
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

# ---------------------------------------------------------------- 格式嗅探

_ZIP_SIGNATURES = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")

_TEXT_EXT = {
    ".csv": "csv",
    ".tsv": "csv",
    ".html": "html",
    ".htm": "html",
    ".json": "json",
    ".jsonl": "json",
    ".xml": "xml",
    ".ipynb": "ipynb",
}

_IMAGE_FMTS = {"png", "jpeg", "gif", "webp"}
_OFFICE_FMTS = {"docx", "xlsx", "pptx", "epub", "odf"}
_TEXTY_FMTS = {"html", "csv", "json", "xml", "ipynb"}

NATIVE_ALT = {
    "docx": "python-docx",
    "xlsx": "openpyxl",
    "pptx": "python-pptx",
    "pdf": "pypdf",
}


def _sniff_zip(path: Path) -> str:
    """ZIP 容器要进内部看目录结构才能区分 docx/xlsx/pptx/epub/odt。"""
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
    except Exception:
        return "zip"
    joined = "\n".join(names)
    if "word/document.xml" in joined:
        return "docx"
    if "xl/workbook.xml" in joined:
        return "xlsx"
    if "ppt/presentation.xml" in joined:
        return "pptx"
    if "META-INF/container.xml" in joined and "mimetype" in joined:
        return "epub"
    if "META-INF/manifest.xml" in joined and "content.xml" in joined:
        return "odf"
    return "zip"


def sniff_format(path: Path) -> str:
    """按魔数（而非扩展名）判定格式 —— 扩展名会撒谎。"""
    with path.open("rb") as fh:
        head = fh.read(12)
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(_ZIP_SIGNATURES):
        return _sniff_zip(path)
    if head.startswith(b"{\\rtf"):
        return "rtf"
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "ole2"  # 旧版二进制 .doc/.xls/.ppt
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith((b"ID3", b"\xff\xfb", b"\xff\xf3")):
        return "audio"
    try:
        with path.open("rb") as fh:
            fh.read(4096).decode("utf-8")
    except (UnicodeDecodeError, OSError):
        return "unknown"
    return _TEXT_EXT.get(path.suffix.lower(), "text")


# ---------------------------------------------------------------- PDF 结构探测

TEXT_LAYER_MIN_CHARS_PER_PAGE = 120
COLUMN_GUTTER_THRESHOLD = 0.35
MIN_PAGE_CHARS_FOR_COLUMNS = 300
MAX_SAMPLED_PAGES = 5
# 短于这个长度的文本块不参与栏数分析：页码、页眉、图注残片之类的噪声。
# 但它**不分栏**，所以调用方必须处理「某一栏被整体滤掉」的情况，见
# `_dropped_blocks_look_like_a_column`。
MIN_BLOCK_CHARS = 25


def _dropped_blocks_look_like_a_column(all_blocks, kept_blocks, width: float) -> bool:
    """被字符数过滤丢掉的块，是否落在保留文本区的**左右两侧之外**（像另一栏）。

    过滤本意是滤掉页码之类的噪声，但它**不分栏**。当双栏页的其中一栏全是短块
    （一张图、一张表、一列短条目），那一栏会整体消失，剩下那一栏看起来就是一个
    「确信的单栏页」——页面不会停在 `unknown`，而是被判 `single-column` 并交给
    markitdown，正是「代价不对称」原则最怕的方向。

    这里只做**安全侧**处置：证据不完整时返回 True，调用方据此返回 None
    （→ `unknown` → `pdf_markdown`）。绝不因为「丢掉的块像是另一栏」就去**断言**
    多栏——那是另一个方向的猜测，同样没有证据。

    页边 5% 必须先排除掉。出版社在那里压竖排水印和下载时间戳，
    例如 `'01 October 2026 09:08:07'` 在 612pt 页面上落在 x=596，
    正好在保留文本区右侧之外——但那**不是一栏**，恰恰是过滤器本来就该丢的噪声。
    不排除它，每一份带页边时间戳的单栏论文都会在每一页被判成「证据不足」，
    从而被降级为 `unknown` 并交给更重的 `pdf_markdown`。
    （实测：未排除时 71 篇真实语料中有 2 页被误触发；排除后为 0。）
    """
    if not kept_blocks:
        return False
    margin = width * 0.05
    dropped = [
        b
        for b in all_blocks
        if len(b[4].strip()) < MIN_BLOCK_CHARS
        and b[0] >= margin
        and b[2] <= width - margin
    ]
    if not dropped:
        return False
    kept_x0 = min(b[0] for b in kept_blocks)
    kept_x1 = max(b[2] for b in kept_blocks)
    min_gap = max(6.0, width * 0.012)
    return any(
        b[2] <= kept_x0 - min_gap or b[0] >= kept_x1 + min_gap for b in dropped
    )


def _band_columns(intervals: list[tuple[float, float]], width: float) -> int:
    """某条横带里有多少栏 —— 合并文本区间后，数被「内部空白」隔开的段数。"""
    if len(intervals) < 2:
        return 1
    ordered = sorted(intervals)
    merged = [list(ordered[0])]
    for a, b in ordered[1:]:
        if a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    if len(merged) < 2:
        return 1
    min_gap = max(6.0, width * 0.012)
    # 只数「被合格内部分隔切开的组数」。
    #
    # 边缘的窄块必须排除：出版商会在页边压一条竖排的 "Downloaded from ..."
    # 水印，宽约 6pt 却纵贯整页，于是它落进**每一个**横带。早先这里写成
    # `return len(merged) if interior else 1`——过滤器算出了正确的 interior，
    # 返回值却把被排除的边缘块又数了回去，2 栏版式因此被系统性高估成 3 栏
    # （实测 74 篇真实论文中 18 篇中招）。
    columns = 1
    for i in range(len(merged) - 1):
        if (
            merged[i + 1][0] - merged[i][1] >= min_gap
            and merged[i][1] > width * 0.15
            and merged[i + 1][0] < width * 0.88
        ):
            columns += 1
    return columns


def _column_profile(page) -> tuple[float, float] | None:
    """返回 (出现多栏的横带占比, 这些横带的栏数中位数)；None = 样本不足。

    用「数栏数」而不是「找中间那一条沟」，才能同时覆盖 2 栏与 3 栏版面。
    """
    width, height = page.rect.width, page.rect.height
    # 保留全部候选块（只按页边过滤），再单独算出「够长」的那批：
    # 两批都留着，才能判断被丢掉的块是不是一整栏。
    all_blocks = [
        b
        for b in page.get_text("blocks")
        if b[6] == 0 and b[1] < height * 0.90 and b[3] > height * 0.10
    ]
    blocks = [b for b in all_blocks if len(b[4].strip()) >= MIN_BLOCK_CHARS]
    if len(blocks) < 6:
        return None

    band_h = max(12.0, height * 0.02)
    y, bands, multi = height * 0.10, 0, []
    while y < height * 0.90:
        band = [b for b in blocks if b[1] < y + band_h and b[3] > y]
        if band:
            bands += 1
            n = _band_columns([(b[0], b[2]) for b in band], width)
            if n >= 2:
                multi.append(n)
        y += band_h

    if bands < 8:
        return None
    if not multi:
        # 一条栏缝都没找到。但如果被滤掉的短块落在保留文本区之外，
        # 「单栏」这个结论就没有依据——只能说证据不足（安全侧）。
        if _dropped_blocks_look_like_a_column(all_blocks, blocks, width):
            return None
        return 0.0, 1.0
    multi.sort()
    return len(multi) / bands, float(multi[len(multi) // 2])


def _sample_indices(page_count: int) -> list[int]:
    """均匀抽样最多 5 页 —— 只抽首/中/末会漏掉正文页。"""
    if page_count <= MAX_SAMPLED_PAGES:
        return list(range(page_count))
    n = page_count
    return sorted({0, n // 4, n // 2, (3 * n) // 4, n - 1})


def probe_pdf(path: Path) -> dict:
    """PDF 结构探测。PyMuPDF 缺失时降级，不抛异常。"""
    try:
        import pymupdf
    except ImportError:
        return {"probe_unavailable": "PyMuPDF not installed"}

    doc = pymupdf.open(path)
    try:
        n = doc.page_count
        chars = 0
        for page in doc:
            chars += len(page.get_text().strip())
        per_page = chars / n if n else 0.0

        profile: dict[str, str | None] = {}
        multi_pages: list[tuple[float, int]] = []
        for i in _sample_indices(n):
            if not (0 <= i < n):
                continue
            page = doc[i]
            prof = _column_profile(page)
            if prof is None:
                profile[str(i + 1)] = None
                continue
            ratio, ncols = prof
            ncols_i = int(round(ncols))
            profile[str(i + 1)] = f"{ratio:.2f}/{ncols_i}col"
            if (
                ratio >= COLUMN_GUTTER_THRESHOLD
                and len(page.get_text().strip()) >= MIN_PAGE_CHARS_FOR_COLUMNS
            ):
                multi_pages.append((ratio, ncols_i))

        # 「任一正文页多栏即多栏」——pymupdf4llm 对单栏同样适用，
        # 而漏判会把多栏交给 markitdown 毁掉正文，代价不对称。
        if multi_pages:
            columns = "multi-column"
            counts = sorted(c for _, c in multi_pages)
            column_estimate = counts[len(counts) // 2]
        elif any(v is not None for v in profile.values()):
            columns = "single-column"
            column_estimate = 1
        else:
            columns = "unknown"
            column_estimate = None

        return {
            "pages": n,
            "text_chars": chars,
            "chars_per_page": round(per_page),
            "text_layer": per_page >= TEXT_LAYER_MIN_CHARS_PER_PAGE,
            "columns": columns,
            "column_estimate": column_estimate,
            "page_profile": profile,
        }
    finally:
        doc.close()


# ---------------------------------------------------------------- 判据

PYMUPDF_HINT = (
    "Install PyMuPDF for layout-aware PDF support: "
    '`pip install pymupdf4llm` (into the interpreter named by pythonPath).'
)


# ---------------------------------------------------------------- 提示语
#
# 判据是确定性的、与语言无关；**提示语是给人读的**，所以两种语言都提供。
# 默认英文：提示语随工具结果一起显示给使用者，而本项目的首要文档（npm 上的
# README.md）是英文的。`--lang zh`（插件配置 `noteLanguage: 'zh'`）切中文。
#
# 为什么这不是可有可无：早先提示语只有中文，英文 README 只能写成
# 「2 行提示语已省略」——文档被迫对一个自己发出去的输出打码。
#
# 改这里的措辞时注意：`unknown_columns` 的文案**不能**出现「单栏」，
# 那是一个探测不到的状态；tests/probe.integration.test.mjs 会盯着这一点
# （中文那一路现在必须显式 `--lang zh` 才走得到）。
NOTE_LANG_DEFAULT = "en"
NOTE_LANGS = ("zh", "en")

_NOTES: dict[str, dict[str, str]] = {
    "probe_unavailable": {
        "zh": "版面探测不可用，无法区分单栏/多栏。{hint}",
        "en": "Layout probe unavailable — single- vs multi-column cannot be told "
        "apart. {hint}",
    },
    "no_text_layer": {
        "zh": "无文字层（{chars} 字符/页）→ 文本提取无意义，必须走图像/OCR",
        "en": "No text layer ({chars} chars/page) — text extraction is meaningless "
        "here; this must go through image/OCR",
    },
    "multi_column": {
        "zh": "多栏正文（估 {estimate} 栏）→ markitdown 会把正文切成表格碎片，"
        "pypdf 会丢结构",
        "en": "Multi-column body text (est. {estimate} columns) — markitdown shreds it "
        "into table fragments and pypdf drops the structure",
    },
    "single_column": {
        "zh": "单栏有文字层 → 两者皆可；markitdown 免审批、pypdf 更省 token",
        "en": "Single column with a text layer — either works; markitdown needs no "
        "approval, pypdf is cheaper on tokens",
    },
    "unknown_columns": {
        # 措辞里刻意**不出现**「单栏」：这是一个探测不到的状态。
        "zh": "未能判定栏数（文字带分布测不出来）→ 按安全侧走 pdf_markdown；"
        "多栏正文交给 markitdown 会被切成表格碎片",
        "en": "Column count could not be determined (no usable text-band "
        "distribution) — taking the safe side with pdf_markdown; handing multi-column "
        "body text to markitdown shreds it into table fragments",
    },
    "verify_math": {
        "zh": "需精确核对公式/上下标/数字时，再对该页渲染成图校验",
        "en": "If formulas, super/subscripts or digits must be exact, render that page "
        "to an image and check it",
    },
    "native_alt": {
        "zh": "原生库 {alt} 可作结构化替代，但需写样板代码",
        "en": "The native library {alt} is a structured alternative, but needs "
        "boilerplate",
    },
    "texty": {
        "zh": "纯文本类容器，直接 read 也可以；markitdown 仅做结构整理",
        "en": "A text-like container — plain read also works; markitdown only tidies "
        "the structure",
    },
    "image": {
        "zh": "图片直接看图（多模态），不要先 OCR 成文本",
        "en": "Look at the image directly (multimodal) rather than OCR-ing it to text "
        "first",
    },
    "plain_text": {
        "zh": "已是纯文本，不需要任何转换",
        "en": "Already plain text — no conversion needed",
    },
    "ole2": {
        "zh": "旧版二进制 Office（.doc/.xls/.ppt）—— 建议先另存为新格式",
        "en": "Legacy binary Office (.doc/.xls/.ppt) — re-save to a modern format first",
    },
    "audio": {
        "zh": "本机未装 ffmpeg，音频转录当前不可用",
        "en": "ffmpeg is not installed here, so audio transcription is unavailable",
    },
    "unknown_format": {
        "zh": "未知格式 → 先试探，失败则人工判断",
        "en": "Unknown format — try it, and fall back to human judgement if it fails",
    },
}


def _note(key: str, lang: str, **fields) -> str:
    """渲染一条提示语；语言不认识时退回默认语言而不是崩掉。"""
    table = _NOTES[key]
    template = table.get(lang) or table[NOTE_LANG_DEFAULT]
    return template.format(**fields) if fields else template


def route(path: Path, lang: str = NOTE_LANG_DEFAULT) -> dict:
    fmt = sniff_format(path)
    out: dict = {"format": fmt, "size_bytes": path.stat().st_size}
    notes: list[str] = []

    if fmt == "pdf":
        extra = probe_pdf(path)
        out.update(extra)
        if "probe_unavailable" in extra:
            out["recommend"] = ["markitdown", "pypdf", "pdf_markdown (needs PyMuPDF)"]
            notes.append(_note("probe_unavailable", lang, hint=PYMUPDF_HINT))
        elif not extra.get("text_layer"):
            out["recommend"] = ["render_to_png + read_image"]
            notes.append(_note("no_text_layer", lang, chars=extra.get("chars_per_page")))
        elif extra.get("columns") == "multi-column":
            out["recommend"] = ["pdf_markdown"]
            notes.append(
                _note("multi_column", lang, estimate=extra.get("column_estimate"))
            )
            notes.append(_note("verify_math", lang))
        elif extra.get("columns") == "single-column":
            out["recommend"] = ["markitdown", "pypdf"]
            notes.append(_note("single_column", lang))
        else:
            # columns == "unknown"：抽样页都测不出文字带分布（正文被切成大量
            # 短块，或少数超大块），因此单栏与多栏**无从区分**。
            #
            # 这里必须走安全侧。判错方向的代价不对称：把单栏交给 pdf_markdown
            # 只是慢一点，把多栏交给 markitdown 会毁掉正文。早先 unknown 与
            # single-column 共用同一个 else 分支，于是 unknown 被送去 markitdown，
            # 提示语还硬编码断言「单栏有文字层」——一个测不准的状态被说成了
            # 一个确定的结论。
            out["recommend"] = ["pdf_markdown"]
            notes.append(_note("unknown_columns", lang))
            notes.append(_note("verify_math", lang))

    elif fmt in _OFFICE_FMTS:
        out["recommend"] = ["markitdown"]
        alt = NATIVE_ALT.get(fmt)
        if alt:
            notes.append(_note("native_alt", lang, alt=alt))
    elif fmt in _TEXTY_FMTS:
        out["recommend"] = ["markitdown"]
        notes.append(_note("texty", lang))
    elif fmt in _IMAGE_FMTS:
        out["recommend"] = ["read_image"]
        notes.append(_note("image", lang))
    elif fmt in ("text", "rtf"):
        out["recommend"] = ["read"]
        notes.append(_note("plain_text", lang))
    elif fmt == "ole2":
        out["recommend"] = ["markitdown"]
        notes.append(_note("ole2", lang))
    elif fmt == "audio":
        out["recommend"] = ["markitdown (needs ffmpeg)"]
        notes.append(_note("audio", lang))
    else:
        out["recommend"] = ["markitdown", "read"]
        notes.append(_note("unknown_format", lang))

    if notes:
        out["notes"] = notes
    return out


# ---------------------------------------------------------------- 版面感知提取


class PageSelectionError(ValueError):
    """页码语法错误。

    单独成类，只为让入口**只回显信息本身**：这条消息是写给使用者的
    （「哪个 chunk 非法、支持哪些写法」），前缀一个内部异常类名
    （`Error: ValueError: ...`）读起来像栈信息漏了出来。
    """


def _page_error(chunk: str, spec: str, detail: str) -> PageSelectionError:
    return PageSelectionError(
        f"invalid page selection {chunk!r} in {spec!r}: {detail}; "
        'expected forms like "3", "1-3" or "1,4,7"'
    )


def parse_pages(spec: str, page_count: int) -> list[int]:
    """把 "1-3,5" 解析成 0 基页码列表。

    越界页码被丢弃（调用方负责判断是否一个都没剩）；语法错误抛 ValueError，
    由 main 转成可读的 JSON 错误——静默忽略一个打错的页码比报错更糟。
    """
    picked: set[int] = set()
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo_s, _, hi_s = chunk.partition("-")
            if not lo_s.strip() or not hi_s.strip():
                raise _page_error(chunk, spec, "open-ended ranges are not supported")
            try:
                lo, hi = int(lo_s), int(hi_s)
            except ValueError as exc:
                raise _page_error(chunk, spec, "a range bound is not a number") from exc
            if lo > hi:
                lo, hi = hi, lo
            picked.update(range(lo, hi + 1))
        else:
            try:
                picked.add(int(chunk))
            except ValueError as exc:
                raise _page_error(chunk, spec, "not a page number") from exc
    return sorted(p - 1 for p in picked if 1 <= p <= page_count)


def markdown(path: Path, pages_spec: str | None) -> dict:
    """版面感知转换。**只接受真正的 PDF**。

    这一条不是洁癖：PyMuPDF 1.28 会把 docx / xlsx / pptx / png / txt / zip
    统统「成功打开」并报 pages=1，于是把一份 Word 文件交给本函数会静默返回
    垃圾或空内容——静默的错答案比报错危险得多。所以先用魔数确认，再给出
    该走哪条管线的建议。
    """
    fmt = sniff_format(path)
    if fmt != "pdf":
        hint = route(path).get("recommend") or ["markitdown"]
        return {
            "error": (
                f"pdf_markdown only converts PDFs — detected {fmt}. "
                f"Recommended pipeline: {' → '.join(hint)} "
                "(run doc_route for the full verdict)"
            )
        }

    try:
        import pymupdf
    except ImportError:
        return {"error": f"PyMuPDF is not installed. {PYMUPDF_HINT}"}
    try:
        import pymupdf4llm
    except ImportError:
        return {"error": f"pymupdf4llm is not installed. {PYMUPDF_HINT}"}

    doc = pymupdf.open(path)
    try:
        page_count = doc.page_count
    finally:
        doc.close()

    selected = parse_pages(pages_spec, page_count) if pages_spec else None
    if selected is not None and not selected:
        # An empty selection is a user error, not a request for everything:
        # silently returning the whole document here would look like success.
        return {
            "error": (
                f"page selection {pages_spec!r} matched no pages; "
                f"the document has {page_count} page(s)"
            )
        }

    text = pymupdf4llm.to_markdown(str(path), pages=selected)
    return {
        "pages_total": page_count,
        "pages_used": [p + 1 for p in selected] if selected is not None else "all",
        "chars": len(text),
        "markdown": text,
    }


# ---------------------------------------------------------------- 入口


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            json.dumps(
                {
                    "error": "usage: docprobe.py <route|markdown> <path> "
                    "[--pages spec] [--lang zh|en]"
                }
            )
        )
        return 2

    mode, raw_path = argv[0], argv[1]
    path = Path(raw_path)
    if not path.exists():
        print(json.dumps({"error": f"not found: {raw_path}"}, ensure_ascii=False))
        return 1
    # Checked here, not left to the opener: a directory surfaces from the
    # filesystem layer as a bare PermissionError (Windows) or IsADirectoryError,
    # which tells the caller nothing about what went wrong.
    if path.is_dir():
        print(json.dumps({"error": f"is a directory, not a file: {raw_path}"}, ensure_ascii=False))
        return 1

    pages_spec = None
    if "--pages" in argv:
        idx = argv.index("--pages")
        if idx + 1 < len(argv):
            pages_spec = argv[idx + 1]

    lang = NOTE_LANG_DEFAULT
    if "--lang" in argv:
        idx = argv.index("--lang")
        if idx + 1 < len(argv) and argv[idx + 1] in NOTE_LANGS:
            lang = argv[idx + 1]

    try:
        if mode == "route":
            result = route(path, lang)
        elif mode == "markdown":
            result = markdown(path, pages_spec)
        else:
            print(json.dumps({"error": f"unknown mode: {mode}"}, ensure_ascii=False))
            return 2
    except PageSelectionError as exc:
        # 消息本身已经是给使用者的完整说明，不再加异常类名前缀。
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1
    except Exception as exc:  # 让插件侧拿到可读原因而不是 traceback
        print(
            json.dumps(
                {"error": f"{type(exc).__name__}: {exc}"},
                ensure_ascii=False,
            )
        )
        return 1

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

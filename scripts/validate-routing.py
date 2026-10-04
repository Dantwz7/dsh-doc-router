"""Run the router over every PDF in a corpus and print a per-file verdict table.

This is the script that produced the corpus table in the READMEs ("Files routed 72",
"47 multi-column / 22 single-column / 2 unknown"). It is the **same code path the
`doc_route` tool uses**: it imports `lib/docprobe.py` directly, so a verdict printed
here and a verdict returned by the tool cannot disagree.

Read-only on the corpus: it opens files for reading and writes nothing except the
optional `--json` output.

Usage:
    python -B scripts/validate-routing.py <corpus-root> [--json OUT.json]

`<corpus-root>` is searched recursively for `*.pdf`. The README's recorded totals
come from a 71-PDF reference library; point this at whatever tree you hold and
**diff your per-file table against the recorded manifest** instead of trusting a
summary line. Those papers cannot be redistributed, which is exactly why the
manifest exists and why this script takes a path rather than shipping one.
"""

import json
import pathlib
import sys

# Suppress bytecode *before* importing docprobe. A module cannot suppress its own
# .pyc (Python compiles it before running its body), and a stray `lib/__pycache__/`
# is something `npm run verify:package` correctly refuses to publish. `python -B`
# already covers this; this line also covers a copy-pasted run command.
sys.dont_write_bytecode = True

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "lib"))

import docprobe  # noqa: E402

USAGE = "usage: python -B scripts/validate-routing.py <corpus-root> [--json OUT.json]"

argv = sys.argv[1:]
json_out = None
if "--json" in argv:
    idx = argv.index("--json")
    if idx + 1 >= len(argv):
        print("error: --json needs an output path", file=sys.stderr)
        raise SystemExit(2)
    json_out = pathlib.Path(argv[idx + 1])
    del argv[idx : idx + 2]

if not argv:
    print("error: no corpus root given", file=sys.stderr)
    print(f"       {USAGE}", file=sys.stderr)
    raise SystemExit(2)

root = pathlib.Path(argv[0])
if not root.is_dir():
    print(f"error: corpus root not found: {root}", file=sys.stderr)
    raise SystemExit(2)

pdfs = sorted(root.rglob("*.pdf"))
print(f"corpus: {root}")
print(f"PDF count: {len(pdfs)}\n")

print(f"{'columns':15s} {'est':>4s} {'pages':>5s} {'chars/pg':>8s}  file")
print("-" * 100)

tally: dict[str, int] = {}
rows = []
for p in pdfs:
    try:
        r = docprobe.route(p)
    except Exception as exc:
        print(f"{'ERROR':15s} {'':>4s} {'':>5s} {'':>8s}  {p.name[:60]}  {exc}")
        rows.append({"file": str(p.relative_to(root)), "error": str(exc)})
        continue
    verdict = r.get("columns", "-")
    tally[verdict] = tally.get(verdict, 0) + 1
    rows.append(
        {
            "file": str(p.relative_to(root)),
            "size_bytes": r.get("size_bytes"),
            "pages": r.get("pages"),
            "columns": verdict,
            "column_estimate": r.get("column_estimate"),
            "chars_per_page": r.get("chars_per_page"),
        }
    )
    print(
        f"{verdict:15s} "
        f"{str(r.get('column_estimate', '-')):>4s} "
        f"{str(r.get('pages', '-')):>5s} "
        f"{str(r.get('chars_per_page', '-')):>8s}  "
        f"{p.name[:60]}"
    )

print("\nverdicts:", dict(sorted(tally.items())))

if json_out is not None:
    json_out.write_text(
        json.dumps(
            {
                "corpus_root": str(root),
                "pdf_count": len(pdfs),
                "verdicts": dict(sorted(tally.items())),
                "files": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {json_out}")

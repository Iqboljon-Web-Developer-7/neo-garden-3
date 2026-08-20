#!/usr/bin/env python3
"""
Self-host the two font families index.html currently pulls from the Google Fonts
CDN (Oswald and Manrope, both variable), replacing that live dependency with
local, glyph-subsetted woff2 files under uploads/fonts/.

Adapted from ../5/tools/subset-fonts.py. Same _get() curl-fallback fetch, same
"pick the @font-face block whose unicode-range covers U+0000-00FF" latin-block
selection, same fontTools.subset.Options, same subset-FIRST-then-instance order.

Two deliberate differences from 5/'s script:

1. UPPERCASE-AWARE CHARSET. style.css applies `text-transform: uppercase` to
   five selectors whose HTML source text is mixed-case (.ng-headline,
   .ng-cta-label, .ng-brand-sub, .ng-stat-label, .ng-countdown-label). A charset
   built only from literal source characters would omit uppercase C, P and V —
   the headline "Boshlang'ich to'lovsiz, penya foizlarsiz..." renders through
   uppercase C/P/V that appear nowhere in the source as capitals — and the
   rendered headline would show tofu boxes. page_charset() therefore unions in
   set(text.upper()) (and set(text.lower()) for cheap symmetry), and asserts
   C/P/V made it in.

2. WEIGHT DIET. The CDN link requests Oswald 500;600;700 and Manrope
   400;500;600;700;800; style.css only ever uses Oswald 600/700 and Manrope
   600/700/800. The unused weights are dropped by instancing the wght axis to
   the used range.

Also runs a bytes experiment: build the narrow-range variable files AND
single-weight static instances, compare total bytes, and keep whichever set is
smaller. Both totals are printed so the choice is auditable.

    python3 tools/subset-fonts.py
"""
import html
import os
import re
import shutil
import subprocess
import urllib.request

from fontTools import subset
from fontTools.varLib import instancer
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, ".work", "fonts")
# This folder uses uploads/ as its asset dir (not assets/ like the siblings).
OUT_DIR = os.path.join(ROOT, "uploads", "fonts")
EXP_DIR = os.path.join(CACHE_DIR, "experiment")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Each entry: cache filename, CSS2 request URL, output woff2 filename, the wght
# range to instance the variable source down to, and the discrete weights to try
# as separate static files in the bytes experiment.
SOURCES = [
    {
        "name": "oswald",
        "css_url": "https://fonts.googleapis.com/css2?family=Oswald:wght@600..700&display=swap",
        "cache": "oswald-variable.raw",
        "out": "oswald-subset.woff2",
        "wght_range": (600, 700),   # 500 is requested by the CDN link but unused
        "static_weights": (600, 700),
    },
    {
        "name": "manrope",
        "css_url": "https://fonts.googleapis.com/css2?family=Manrope:wght@600..800&display=swap",
        "cache": "manrope-variable.raw",
        "out": "manrope-subset.woff2",
        "wght_range": (600, 800),   # 400 and 500 are requested but unused
        "static_weights": (600, 700, 800),
    },
]


def _get(url):
    """Fetch a URL. Falls back to curl because this machine's Python has no CA
    bundle configured (urllib raises CERTIFICATE_VERIFY_FAILED) while curl works."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        return urllib.request.urlopen(req, timeout=20).read()
    except Exception:
        return subprocess.run(
            ["curl", "-sSL", "--max-time", "30", "-A", UA, url],
            check=True, capture_output=True).stdout


def latin_font_url(css_text):
    """Pick the @font-face block whose unicode-range covers U+0000-00FF (the
    'latin' subset block) and return its woff2 url. Blocks are matched on their
    unicode-range declaration, not on file position, since Google reorders
    latin/latin-ext/cyrillic/... blocks depending on the family."""
    blocks = re.findall(r"@font-face\s*\{[^}]*\}", css_text, flags=re.S)
    for block in blocks:
        m = re.search(r"unicode-range:\s*([^;]+);", block)
        if not m:
            continue
        if "U+0000-00FF" in m.group(1):
            u = re.search(r"url\((https://[^)]+\.woff2)\)", block)
            if u:
                return u.group(1)
    raise SystemExit("no 'latin' (U+0000-00FF) @font-face block found in CSS:\n" + css_text)


def fetch_source(entry):
    cache_path = os.path.join(CACHE_DIR, entry["cache"])
    if os.path.exists(cache_path):
        return cache_path
    css = _get(entry["css_url"]).decode()
    url = latin_font_url(css)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(cache_path, "wb") as f:
        f.write(_get(url))
    return cache_path


def page_charset():
    """Every character that ends up as *rendered* text in index.html.

    Not just the literal source characters: style.css uppercases five mixed-case
    selectors, so the rendered page needs capitals that never appear as capitals
    in the source (C, P, V among them)."""
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
        doc = f.read()
    doc = re.sub(r"<script\b.*?</script>", " ", doc, flags=re.S | re.I)
    doc = re.sub(r"<style\b.*?</style>", " ", doc, flags=re.S | re.I)
    doc = re.sub(r"<!--.*?-->", " ", doc, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", " ", doc))

    chars = set(text)
    # text-transform: uppercase on .ng-headline / .ng-cta-label / .ng-brand-sub /
    # .ng-stat-label / .ng-countdown-label means the rendered glyphs are the
    # uppercase forms of mixed-case source text. Without this the headline loses
    # C, P and V and renders with tofu boxes.
    chars |= set(text.upper())
    chars |= set(text.lower())       # cheap symmetry / headroom
    chars -= set("\n\r\t")
    chars.add(" ")
    chars |= set("0123456789:")      # every digit the countdown (script.js) can show
    chars |= set("'’‘ʻʼ")            # apostrophe variants: Boshlang'ich, to'lovsiz, bo'lib
    return "".join(sorted(chars))


def check_uppercase_fix(chars):
    """The whole point of the deviation from 5/'s script. If this trips, the
    uppercase union above did not take effect — do not ship the fonts."""
    missing = [c for c in ("C", "P", "V") if c not in chars]
    assert not missing, (
        "uppercase fix FAILED — missing %r from charset; the uppercased headline "
        "would render with tofu boxes" % (missing,)
    )
    print("✓ uppercase fix confirmed: 'C', 'P', 'V' all present in charset "
          "(text-transform: uppercase glyphs covered)")


def subset_font(src_path, chars):
    """Subset to `chars`. Subsetting happens FIRST, instancing afterwards."""
    font = TTFont(src_path)
    opts = subset.Options()
    opts.layout_features = ["kern", "liga", "calt", "locl", "ccmp"]
    opts.name_IDs = ["*"]
    opts.name_legacy = False
    opts.notdef_outline = False
    opts.recalc_bounds = True
    opts.drop_tables += ["DSIG"]
    opts.desubroutinize = False

    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(text=chars)
    subsetter.subset(font)
    return font


def save_woff2(font, path):
    font.flavor = "woff2"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    font.save(path)
    return os.path.getsize(path)


def build_variable(src_path, chars, wght_range, out_path):
    font = subset_font(src_path, chars)
    if "fvar" in font:
        font = instancer.instantiateVariableFont(
            font, {"wght": wght_range}, updateFontNames=False)
    else:
        print(f"  ! {os.path.basename(src_path)} has no fvar table — static source, "
              f"nothing to instance")
    return save_woff2(font, out_path)


def build_static(src_path, chars, weight, out_path):
    font = subset_font(src_path, chars)
    if "fvar" in font:
        font = instancer.instantiateVariableFont(
            font, {"wght": weight}, updateFontNames=False)
    return save_woff2(font, out_path)


def metric(table, *names):
    for n in names:
        if hasattr(table, n):
            return getattr(table, n)
    return None


def read_metrics(path):
    font = TTFont(path)
    head = font["head"]
    os2 = font["OS/2"] if "OS/2" in font else None
    hhea = font["hhea"] if "hhea" in font else None

    units_per_em = head.unitsPerEm

    typo_ascender = metric(os2, "sTypoAscender") if os2 else None
    typo_descender = metric(os2, "sTypoDescender") if os2 else None
    typo_line_gap = metric(os2, "sTypoLineGap") if os2 else None

    if not typo_ascender:
        typo_ascender = metric(hhea, "ascent", "ascender") if hhea else None
    if not typo_descender:
        typo_descender = metric(hhea, "descent", "descender") if hhea else None
    if not typo_line_gap:
        typo_line_gap = metric(hhea, "lineGap") if hhea else None

    cap_height = metric(os2, "sCapHeight") if os2 else None
    x_height = metric(os2, "sxHeight") if os2 else None

    return {
        "unitsPerEm": units_per_em,
        "ascent": typo_ascender,
        "descent": typo_descender,
        "lineGap": typo_line_gap,
        "capHeight": cap_height,
        "xHeight": x_height,
    }


def rel(p):
    return os.path.relpath(p, ROOT)


def main():
    chars = page_charset()
    print(f"→ charset ({len(chars)} chars): {chars!r}")
    check_uppercase_fix(chars)
    print()

    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(EXP_DIR, exist_ok=True)

    # --- build both candidate sets -------------------------------------------
    variable_files = {}   # name -> [(path, size)]
    static_files = {}     # name -> [(path, size)]

    for entry in SOURCES:
        src = fetch_source(entry)
        name = entry["name"]

        var_path = os.path.join(OUT_DIR, entry["out"])
        var_size = build_variable(src, chars, entry["wght_range"], var_path)
        variable_files[name] = [(var_path, var_size)]
        lo, hi = entry["wght_range"]
        print(f"→ {name} variable wght {lo}..{hi}: {rel(var_path)}  {var_size:,} B")

        static_files[name] = []
        for w in entry["static_weights"]:
            st_path = os.path.join(EXP_DIR, f"{name}-{w}.woff2")
            st_size = build_static(src, chars, w, st_path)
            static_files[name].append((st_path, st_size))
            print(f"→ {name} static wght {w}: {rel(st_path)}  {st_size:,} B")

    var_total = sum(s for v in variable_files.values() for _, s in v)
    static_total = sum(s for v in static_files.values() for _, s in v)

    print()
    print("=== bytes experiment: narrow-range variable vs separate statics ===")
    for entry in SOURCES:
        name = entry["name"]
        v = sum(s for _, s in variable_files[name])
        st = sum(s for _, s in static_files[name])
        print(f"  {name:8s} variable {v:>8,} B   |   statics "
              f"({len(static_files[name])} files) {st:>8,} B")
    print(f"  {'TOTAL':8s} variable {var_total:>8,} B   |   statics "
          f"{static_total:>8,} B")

    keep_variable = var_total <= static_total
    winner = "variable" if keep_variable else "static"
    delta = abs(var_total - static_total)
    print(f"  → keeping {winner.upper()} "
          f"({delta:,} B smaller, {delta / max(var_total, static_total) * 100:.1f}%)")
    print()

    # --- promote the winner into uploads/fonts/ -------------------------------
    kept = {}
    if keep_variable:
        kept = variable_files
        # nothing to move; the losing statics stay in .work/ as an audit trail
    else:
        for entry in SOURCES:
            name = entry["name"]
            var_path = variable_files[name][0][0]
            if os.path.exists(var_path):
                os.remove(var_path)
            kept[name] = []
            for st_path, _ in static_files[name]:
                dest = os.path.join(OUT_DIR, os.path.basename(st_path))
                shutil.copyfile(st_path, dest)
                kept[name].append((dest, os.path.getsize(dest)))

    print("=== kept files ===")
    for entry in SOURCES:
        for path, size in kept[entry["name"]]:
            print(f"  {rel(path)}  {size:,} B")

    print()
    print("=== metrics (verbatim, for metric-matched CSS fallback fonts) ===")
    for entry in SOURCES:
        name = entry["name"]
        for path, size in kept[name]:
            m = read_metrics(path)
            print(f"[{name}]  {rel(path)}  ({size:,} B)")
            print(f"    unitsPerEm : {m['unitsPerEm']}")
            print(f"    ascent     : {m['ascent']}")
            print(f"    descent    : {m['descent']}")
            print(f"    lineGap    : {m['lineGap']}")
            print(f"    capHeight  : {m['capHeight'] if m['capHeight'] is not None else 'null'}")
            print(f"    xHeight    : {m['xHeight'] if m['xHeight'] is not None else 'null'}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Squash pipeline for the Neo Garden landing page (variant 3).

Two images live in uploads/ and both render inside the 380px-tall .ng-hero:

  building.avif  .ng-hero-img     inset:0; object-fit:cover; object-position:50% 26%
  person.avif    .ng-hero-person  height:78%; width:auto  (RGBA cutout, no cover)

MEASURED, NOT ASSUMED
---------------------
The display boxes below came out of a real Chromium render (viewport 430,
deviceScaleFactor 2, .getBoundingClientRect() on each element), not arithmetic.
That mattered: `.ng-hero` has `border: 1px` and `box-sizing: border-box`, so its
*padding* box -- the containing block for both absolutely-positioned children --
is 396x378, not the 398x380 the CSS literals suggest. Every hand-computed
number in this file's earlier drafts was ~2 CSS px too big on each axis:

  element          hand-computed CSS     measured CSS            device px @2x
  .ng-hero-img     398    x 380          396      x 378          792 x 756
  .ng-hero-person  296.40 x 185.60       294.828125 x 184.546875 589.66 x 369.09

Reproduce with:
  NODE_PATH=<repo>/1/node_modules node tools/measure-hero.mjs

STRATEGY BAKE-OFF FOR building.avif
-----------------------------------
`object-fit: cover` means the browser throws away everything outside the visible
window, so we can either pre-crop to that window server-side or ship the whole
frame and let the browser crop for free. Both are *pixel-identical on screen*.
Cropping is not automatically smaller: a tight crop can concentrate
high-frequency detail (facade, windows) while the discarded margin was flat sky
and pavement that AVIF compresses almost for free. A sibling variant learned
this the hard way -- its "optimised" tight hero crop doubled the file. So we
encode BOTH strategies across a quality bracket, print the table, and install
the winner on evidence.

  A (crop)    cover_crop_box(50%, 26%) -> crop -> resize 792x756 -> AVIF
  B (no-crop) resize full frame to 792 wide (792x1056) -> AVIF, browser crops

Both run through crop-then-resize-with-LANCZOS, so the resize only ever
downsamples.

Run from the project root:  python3 tools/squash-images.py
"""
import os
import shutil

from PIL import Image
import pillow_avif  # noqa: F401  (registers the AVIF plugin with PIL)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOADS = os.path.join(ROOT, "uploads")
WORK = os.path.join(ROOT, ".work")
ORIGINALS = os.path.join(WORK, "originals")
BUILDING_CANDIDATES = os.path.join(WORK, "building-candidates")
PERSON_CANDIDATES = os.path.join(WORK, "person-candidates")

# ---- measured display boxes, in DEVICE pixels (CSS px x DPR 2) --------------
# .ng-hero-img: 396 x 378 CSS -> exact, integral.
HERO_W, HERO_H = 792, 756
HERO_POS_X, HERO_POS_Y = 0.50, 0.26  # object-position: 50% 26%

# .ng-hero-person: 184.546875 x 294.828125 CSS -> 369.09 x 589.66 device px.
# Round UP so the browser never upsamples, and pick the (w, h) pair whose ratio
# best matches the source's 626:1000 -- `width: auto` derives the laid-out width
# from the file's intrinsic aspect, so a sloppy ratio nudges the layout.
#   370/591 = 0.626058 vs 626/1000 = 0.626  -> layout shifts by 0.02 CSS px.
PERSON_W, PERSON_H = 370, 591

SPEED = 2  # libaom speed; 2 is slow-but-proven in the sibling pipeline

# The building source is ALREADY squeezed hard -- 900x1200 in 30,118 B is
# ~0.22 bits/pixel. The first bracket here was 55/58/62/65 (tuned on a sibling
# variant whose sources were fat JPEGs) and every single candidate came out
# BIGGER than the original, strategy A by +59% and strategy B by +100%. Against
# an already-lossy source, high quality just spends bytes preserving the
# previous encoder's artifacts. Hence the bracket runs down into the 20s.
BUILDING_QUALITIES = [28, 32, 34, 36, 38, 40, 45, 50, 55, 62]
PERSON_QUALITIES = [46, 49, 52, 55, 58, 61, 64, 67]

# ---- the picks, filled in from the tables this script prints ----------------
# Set either to None to keep the existing upload untouched -- a real outcome
# when a source is already better-compressed than anything we can re-encode.
#
# building: strategy A (pre-crop) at q36. A beat B at EVERY quality by 17-20%,
# because object-position 50% 26% throws away 28% of the frame's rows -- B has
# to encode 1056 rows to A's 756. (Note this is the opposite of the sibling
# variant's result, where the crop retained the busy facade and discarded flat
# sky; which way it falls is a property of the picture, so it gets measured,
# never assumed.) q36 is the quality floor: checked at 3-4x against the
# original on facade, railings, sky and foliage, q36 is indistinguishable,
# while q34 and below visibly soften tree texture and the small pedestrian
# figures in the landscaping. -11.2% is a modest win because the source is
# already ~0.22 bpp -- re-encoding lossy input pays a generation-loss tax.
BUILDING_CHOICE = ("A", 36)

# person: q52. The face is the page's trust element, so it was judged at 4x on
# the eyes/hairline; q52 is indistinguishable from the LANCZOS reference and
# sits a clear step above q46-q49 where hair texture starts to smear. The
# alpha channel is crisp at every quality tried -- AVIF codes it as its own
# near-lossless plane -- so quality only ever traded against the RGB face.
PERSON_CHOICE = 52


def cover_crop_box(src_w, src_h, target_w, target_h, pos_x=0.5, pos_y=0.5):
    """Replicate CSS `object-fit: cover; object-position: X% Y%` as a PIL crop box.

    Returns (x0, y0, x1, y1) in the SOURCE image's native pixel coordinates:
    the largest region of the source, at the target aspect ratio, positioned
    per pos_x/pos_y (0..1 fractions, CSS % / 100), that -- once resized to
    target_w x target_h -- is pixel-identical to what `cover` would paint.
    """
    scale = max(target_w / src_w, target_h / src_h)
    crop_w = target_w / scale
    crop_h = target_h / scale
    x0 = (src_w - crop_w) * pos_x
    y0 = (src_h - crop_h) * pos_y
    return (round(x0), round(y0), round(x0 + crop_w), round(y0 + crop_h))


def pristine(name):
    """Return a path to the untouched original, stashing it on first run.

    Without this the pipeline is not idempotent: run 2 would read the squashed
    output of run 1 as its "source" and re-encode generation loss into it.
    """
    os.makedirs(ORIGINALS, exist_ok=True)
    keep = os.path.join(ORIGINALS, name)
    live = os.path.join(UPLOADS, name)
    if not os.path.exists(keep):
        shutil.copy2(live, keep)
        print(f"   stashed pristine original -> {keep}")
    return keep


def psnr(a, b):
    """Peak signal-to-noise ratio, in dB, between two same-size PIL images.

    A sanity rail on the eyeball check, not a substitute for it: it says how
    far a candidate drifted from the uncompressed LANCZOS surface, so a quality
    step that collapses gets caught even if the thumbnail looks fine.
    """
    import math

    from PIL import ImageChops, ImageStat

    if a.size != b.size:
        raise ValueError(f"psnr size mismatch: {a.size} vs {b.size}")
    a, b = a.convert("RGBA"), b.convert("RGBA")
    diff = ImageChops.difference(a, b)
    stat = ImageStat.Stat(diff)
    n = a.size[0] * a.size[1] * len(stat.sum2)
    mse = sum(stat.sum2) / n
    if mse == 0:
        return float("inf")
    return 10 * math.log10(255 * 255 / mse)


# --------------------------------------------------------------------------- #
# building.avif                                                               #
# --------------------------------------------------------------------------- #
def build_building_candidates():
    src_path = pristine("building.avif")
    im = Image.open(src_path)
    real_w, real_h = im.size
    print(f"\n=== building.avif ===")
    print(f"   actual source dims: {real_w}x{real_h} (mode={im.mode})")
    print(f"   measured display box: {HERO_W}x{HERO_H} device px "
          f"(396x378 CSS @ DPR 2)")
    im = im.convert("RGB")

    box = cover_crop_box(real_w, real_h, HERO_W, HERO_H, HERO_POS_X, HERO_POS_Y)
    cw, ch = box[2] - box[0], box[3] - box[1]
    print(f"   cover-crop box: {box} -> {cw}x{ch}")

    # Strategy A: pre-crop to the visible window, then downsize.
    surface_a = im.crop(box).resize((HERO_W, HERO_H), Image.LANCZOS)

    # Strategy B: ship the whole frame at display width; the browser crops.
    full_h = round(real_h * HERO_W / real_w)
    surface_b = im.resize((HERO_W, full_h), Image.LANCZOS)
    print(f"   strategy A surface: {surface_a.size[0]}x{surface_a.size[1]}")
    print(f"   strategy B surface: {surface_b.size[0]}x{surface_b.size[1]}")

    # Where the browser will slice strategy B, so we score only what is seen.
    box_b = cover_crop_box(HERO_W, full_h, HERO_W, HERO_H, HERO_POS_X, HERO_POS_Y)
    print(f"   browser will crop B to {box_b} (same picture A ships pre-cropped)")

    # Score each strategy against its OWN uncompressed LANCZOS surface, both
    # restricted to the visible window. That isolates the one thing the quality
    # bracket controls -- encoder loss -- instead of leaking in the ~0.3 px
    # sampling-phase difference between the two geometries, which is invisible
    # on screen but costs several dB. Scoring B over all 1056 rows would also
    # flatter it, since the rows the user never sees are easy sky and pavement.
    windows = {"A": (surface_a, None), "B": (surface_b, box_b)}

    os.makedirs(BUILDING_CANDIDATES, exist_ok=True)
    rows = []
    for strategy, surface in (("A", surface_a), ("B", surface_b)):
        ref_surface, window = windows[strategy]
        ref = ref_surface if window is None else ref_surface.crop(window)
        for q in BUILDING_QUALITIES:
            name = f"building-{strategy}-q{q}.avif"
            path = os.path.join(BUILDING_CANDIDATES, name)
            surface.save(path, quality=q, speed=SPEED)
            size = os.path.getsize(path)
            with Image.open(path) as dec:
                dec.load()
                visible = dec if window is None else dec.crop(window)
                score = psnr(ref, visible.convert("RGB"))
            rows.append((strategy, q, surface.size, size, score, path))
    return rows


# --------------------------------------------------------------------------- #
# person.avif                                                                 #
# --------------------------------------------------------------------------- #
def build_person_candidates():
    src_path = pristine("person.avif")
    im = Image.open(src_path)
    real_w, real_h = im.size
    print(f"\n=== person.avif ===")
    print(f"   actual source dims: {real_w}x{real_h} (mode={im.mode})")
    print(f"   measured display box: 184.546875 x 294.828125 CSS "
          f"-> 369.09 x 589.66 device px")
    print(f"   encode target (rounded up, aspect-matched): {PERSON_W}x{PERSON_H}")

    # RGBA cutout: keep the alpha channel, never flatten to RGB.
    im = im.convert("RGBA")
    assert PERSON_W <= real_w and PERSON_H <= real_h, "would upsample"
    surface = im.resize((PERSON_W, PERSON_H), Image.LANCZOS)

    os.makedirs(PERSON_CANDIDATES, exist_ok=True)
    rows = []
    for q in PERSON_QUALITIES:
        name = f"person-q{q}.avif"
        path = os.path.join(PERSON_CANDIDATES, name)
        surface.save(path, quality=q, speed=SPEED)
        size = os.path.getsize(path)
        with Image.open(path) as dec:
            dec.load()
            score = psnr(surface, dec)
            mode = dec.mode
        rows.append((q, surface.size, size, score, mode, path))
    return rows


def main():
    # Baselines come from the pristine stash, never from uploads/ -- after the
    # first install uploads/ holds our output, and comparing against that would
    # quietly re-baseline every subsequent run.
    orig_building = os.path.getsize(pristine("building.avif"))
    orig_person = os.path.getsize(pristine("person.avif"))

    b_rows = build_building_candidates()
    p_rows = build_person_candidates()

    print("\n\n=== building.avif candidates ===")
    print("   A = pre-cropped to the visible cover window (792x756)")
    print("   B = full frame at display width (792x1056), browser crops for free")
    print("   Both paint identical pixels; PSNR is encoder loss inside the")
    print("   visible window, measured against each strategy's own LANCZOS surface.")
    print()
    head_delta = f"vs {orig_building:,} B"
    print(f"   {'strategy':<26} {'q':>3} {'encoded dims':>14} {'bytes':>9} "
          f"{head_delta:>14} {'PSNR dB':>9}")
    print("   " + "-" * 80)
    for strat, q, dims, size, score, _ in b_rows:
        label = "A crop 792x756" if strat == "A" else "B no-crop 792x1056"
        delta = (size - orig_building) / orig_building * 100
        print(f"   {label:<26} {q:>3} {f'{dims[0]}x{dims[1]}':>14} {size:>9,d} "
              f"{delta:>+13.1f}% {score:>9.2f}")
    print(f"   {'-- original, untouched':<26} {'-':>3} {'900x1200':>14} "
          f"{orig_building:>9,d} {'0.0':>13}% {'(ref)':>9}")

    best = min(b_rows, key=lambda r: r[3])
    print(f"\n   smallest candidate: strategy {best[0]} @ q{best[1]} "
          f"= {best[3]:,} B ({best[4]:.2f} dB)")
    for strat in ("A", "B"):
        same = [r for r in b_rows if r[0] == strat]
        print(f"   strategy {strat} range: {min(r[3] for r in same):,} B .. "
              f"{max(r[3] for r in same):,} B")
    for q in BUILDING_QUALITIES:
        a = next(r[3] for r in b_rows if r[0] == "A" and r[1] == q)
        b = next(r[3] for r in b_rows if r[0] == "B" and r[1] == q)
        print(f"   q{q:<3} A={a:>7,d} B={b:>7,d}  -> A is "
              f"{(b - a) / b * 100:5.1f}% smaller")

    print("\n\n=== person.avif candidates ===")
    head_delta = f"vs {orig_person:,} B"
    print(f"   {'q':>3} {'encoded dims':>14} {'mode':>6} {'bytes':>9} "
          f"{head_delta:>14} {'PSNR dB':>9}")
    print("   " + "-" * 62)
    for q, dims, size, score, mode, _ in p_rows:
        delta = (size - orig_person) / orig_person * 100
        print(f"   {q:>3} {f'{dims[0]}x{dims[1]}':>14} {mode:>6} {size:>9,d} "
              f"{delta:>+13.1f}% {score:>9.2f}")

    # ---- install the picks -------------------------------------------------
    print("\n\n=== installing ===")
    if BUILDING_CHOICE is None:
        shutil.copyfile(os.path.join(ORIGINALS, "building.avif"),
                        os.path.join(UPLOADS, "building.avif"))
        print("   building.avif <- ORIGINAL kept (no candidate beat it)")
    else:
        b_pick = next(r for r in b_rows if (r[0], r[1]) == BUILDING_CHOICE)
        shutil.copyfile(b_pick[5], os.path.join(UPLOADS, "building.avif"))
        print(f"   building.avif <- {os.path.basename(b_pick[5])} "
              f"(strategy {b_pick[0]}, q{b_pick[1]})")

    if PERSON_CHOICE is None:
        shutil.copyfile(os.path.join(ORIGINALS, "person.avif"),
                        os.path.join(UPLOADS, "person.avif"))
        print("   person.avif   <- ORIGINAL kept (no candidate beat it)")
    else:
        p_pick = next(r for r in p_rows if r[0] == PERSON_CHOICE)
        shutil.copyfile(p_pick[5], os.path.join(UPLOADS, "person.avif"))
        print(f"   person.avif   <- {os.path.basename(p_pick[5])} (q{p_pick[0]})")

    # ---- verification pass: re-open the installed files ---------------------
    print("\n=== final verification (re-opened from disk with PIL) ===")
    for name, before in (("building.avif", orig_building),
                         ("person.avif", orig_person)):
        path = os.path.join(UPLOADS, name)
        size = os.path.getsize(path)
        with Image.open(path) as im:
            im.load()
            dims, mode = im.size, im.mode
            has_alpha = "A" in mode
        saved = (before - size) / before * 100
        print(f"   {name:<16} {dims[0]:>4}x{dims[1]:<5} {mode:<5} "
              f"alpha={str(has_alpha):<5} {size:>8,d} B   "
              f"(was {before:,} B, -{saved:.1f}%)")


if __name__ == "__main__":
    main()

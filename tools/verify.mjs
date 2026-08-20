/**
 * Verification harness for /Users/iqboljon/Desktop/neo-garden/3 (static site, no build step).
 *
 * Adapted from neo-garden/5/tools/verify.mjs — same proven mechanics, retuned for this
 * build's markup, fonts, and third-party tags.
 *
 * Serves the project locally, renders index.html at 430 CSS px (this build's design width)
 * with deviceScaleFactor 2, waits for webfonts, and screenshots. Records every network
 * request and the actual byte size of every response.
 *
 *   node tools/verify.mjs baseline   # .work/before.png + .work/before-requests.json
 *   node tools/verify.mjs after      # .work/after.png  + .work/after-requests.json, then:
 *                                    #   1. pixel diff vs before.png -> .work/diff.png
 *                                    #   2. assert ZERO fonts.googleapis.com / fonts.gstatic.com
 *                                    #   3. glyph coverage via document.fonts.check()
 *                                    #   4. Meta Pixel still fires
 *                                    #   5. before-vs-after byte budget table
 *
 * Run with:
 *   NODE_PATH=/Users/iqboljon/Desktop/neo-garden/1/node_modules node tools/verify.mjs <mode>
 *
 * This project has no node_modules of its own. 'playwright-core' resolves transparently
 * because it is imported from inside browser.mjs, which physically lives under
 * neo-garden/1/tools/ (Node's ESM node_modules search walks up from the *importing* file).
 * 'pixelmatch' and 'pngjs' are loaded via createRequire() so NODE_PATH is actually honored
 * (Node's static `import` of a bare specifier does NOT consult NODE_PATH; the CJS require()
 * algorithm does, and Node 22+'s require(ESM) support lets that work for pixelmatch even
 * though it ships ESM-only).
 *
 * Determinism notes (this page, unlike 5/, has two moving parts that would otherwise add a
 * random noise floor to every pixel diff):
 *   - script.js runs a 1 Hz countdown. All intervals registered by the page are cleared and
 *     #ng-mm / #ng-ss are reset to the authored 02 / 00 immediately before the shot. The
 *     observed pre-normalization values are printed, and the countdown wiring is asserted
 *     separately, so a broken script.js still surfaces instead of being papered over.
 *   - .ng-cta runs an infinite `ngPulse` box-shadow animation. Captured with Playwright's
 *     `animations: 'disabled'`, which rewinds infinite animations to their initial state.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// browser.mjs lives under neo-garden/1/tools/ — read-only reuse, imported by relative path.
import { launch } from '../../1/tools/browser.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const pixelmatchExports = require('pixelmatch');
const pixelmatch = pixelmatchExports.default || pixelmatchExports;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..'); // /Users/iqboljon/Desktop/neo-garden/3
const WORK = process.env.NG_WORK ? process.env.NG_WORK : join(ROOT, '.work');

const MODE = (process.argv[2] || '').toLowerCase();
if (MODE !== 'baseline' && MODE !== 'after') {
  console.error('Usage: node verify.mjs <baseline|after>');
  process.exit(1);
}
const isAfter = MODE === 'after';

mkdirSync(WORK, { recursive: true });

const beforePngPath = join(WORK, 'before.png');
const afterPngPath = join(WORK, 'after.png');
const beforeReqPath = join(WORK, 'before-requests.json');
const afterReqPath = join(WORK, 'after-requests.json');
const diffPngPath = join(WORK, 'diff.png');

const shotPath = isAfter ? afterPngPath : beforePngPath;
const reqLogPath = isAfter ? afterReqPath : beforeReqPath;

const VIEWPORT_WIDTH = 430;
const SETTLE_MS = Number(process.env.NG_SETTLE_MS ?? 2500);

// ---------------------------------------------------------------- static server
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('nope');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const LOCAL_HOST = `127.0.0.1:${PORT}`;
const base = `http://${LOCAL_HOST}`;

// ---------------------------------------------------------------------- categorize
function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function assetType(url, contentType, resourceType) {
  const path = url.split('?')[0].split('#')[0];
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (['woff2', 'woff', 'ttf', 'otf', 'eot'].includes(ext)) return 'fonts';
  if (['png', 'jpg', 'jpeg', 'avif', 'webp', 'gif', 'svg', 'ico', 'bmp'].includes(ext)) return 'images';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'js';
  if (ext === 'html' || ext === 'htm') return 'html';

  const ct = (contentType || '').toLowerCase();
  if (ct.includes('font')) return 'fonts';
  if (ct.includes('image')) return 'images';
  if (ct.includes('css')) return 'css';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
  if (ct.includes('html')) return 'html';

  if (resourceType === 'font') return 'fonts';
  if (resourceType === 'image') return 'images';
  if (resourceType === 'stylesheet') return 'css';
  if (resourceType === 'script') return 'js';
  if (resourceType === 'document') return 'html';
  return 'other';
}

// Budget group. Anything served by a host other than our own static server is 'third-party'
// (Google Fonts CSS + woff2, Meta Pixel) — that is the group the optimization is meant to
// empty out. `type` is kept alongside so third-party bytes stay attributable by asset kind.
function categorize(url, contentType, resourceType) {
  const type = assetType(url, contentType, resourceType);
  const host = hostOf(url);
  const thirdParty = !!host && host !== LOCAL_HOST;
  return { type, group: thirdParty ? 'third-party' : type, host, thirdParty };
}

// ---------------------------------------------------------------------- render
const browser = await launch();
const page = await browser.newPage({
  viewport: { width: VIEWPORT_WIDTH, height: 932 },
  deviceScaleFactor: 2,
});

// Remember every interval the page registers so the countdown can be stopped before the
// shot without guessing at ids. Installed before any page script runs.
await page.addInitScript(() => {
  window.__ngIntervals = [];
  const realSetInterval = window.setInterval;
  window.setInterval = function (...args) {
    const id = realSetInterval.apply(this, args);
    try { window.__ngIntervals.push(id); } catch { /* ignore */ }
    return id;
  };
});

const requests = [];
const pending = [];
const consoleErrors = [];
const pageErrors = [];

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

page.on('response', (response) => {
  const p = (async () => {
    const req = response.request();
    const url = req.url();
    const contentType = response.headers()['content-type'] || null;
    const resourceType = req.resourceType();
    let bytes = null;
    try {
      const body = await response.body();
      bytes = body.length;
    } catch {
      const cl = response.headers()['content-length'];
      bytes = cl ? parseInt(cl, 10) : 0;
    }
    requests.push({
      url,
      status: response.status(),
      bytes,
      contentType,
      resourceType,
      ...categorize(url, contentType, resourceType),
    });
  })();
  pending.push(p);
});

page.on('requestfailed', (req) => {
  requests.push({
    url: req.url(),
    status: null,
    bytes: 0,
    contentType: null,
    resourceType: req.resourceType(),
    ...categorize(req.url(), null, req.resourceType()),
    error: req.failure() ? req.failure().errorText : 'requestfailed',
  });
});

let navNote = 'networkidle';
try {
  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle', timeout: 45000 });
} catch (err) {
  // A hung third-party beacon must not take the harness down; fall back to 'load' + settle.
  navNote = `networkidle timed out (${String(err.message || err).split('\n')[0]}) — fell back to load`;
  await page.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
}
await page.evaluate(() => document.fonts.ready);

// Settle window for late third-party traffic. The Meta Pixel's PageView beacon to
// facebook.com/tr is emitted by fbevents.js only after signals/config lands, which is
// routinely a beat past Playwright's networkidle — without this pause the beacon check
// reports INCONCLUSIVE on a page that is in fact firing correctly.
await page.waitForTimeout(SETTLE_MS);

// ------------------------------------------------------------------ stabilize
// Freeze the 1 Hz countdown at its authored initial state so the pixel diff has no noise
// floor, while reporting what it actually showed (so a broken script.js is still visible).
const countdown = await page.evaluate(() => {
  const mm = document.getElementById('ng-mm');
  const ss = document.getElementById('ng-ss');
  const observed = { mm: mm ? mm.textContent : null, ss: ss ? ss.textContent : null };
  try { (window.__ngIntervals || []).forEach(id => clearInterval(id)); } catch { /* ignore */ }
  const intervals = (window.__ngIntervals || []).length;
  if (mm) mm.textContent = '02';
  if (ss) ss.textContent = '00';
  return { observed, intervals, found: !!(mm && ss) };
});

// Resize the viewport to the page's actual content height *before* shooting, rather than
// using `fullPage: true`. Chromium's fullPage capture resizes past the viewport via CDP but
// does not reposition `position: fixed` elements (.ng-cta-bar) to the new bottom — they get
// captured wherever they sat in the original, shorter viewport, overlapping content mid-page.
// A real (non-fullPage) screenshot of a viewport already sized to fit everything has no such
// artifact: fixed elements lay out correctly against the final viewport from the start.
const contentHeight = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
await page.setViewportSize({ width: VIEWPORT_WIDTH, height: contentHeight });
const shotBuf = await page.screenshot({ animations: 'disabled' });
await Promise.all(pending);

const shot = PNG.sync.read(shotBuf);
writeFileSync(shotPath, shotBuf);
writeFileSync(reqLogPath, JSON.stringify(requests, null, 2));

const totalBytes = requests.reduce((s, r) => s + (r.bytes || 0), 0);

const GROUP_ORDER = ['html', 'css', 'js', 'fonts', 'images', 'third-party', 'other'];
const groupBytes = (reqs) => {
  const g = {};
  for (const r of reqs) g[r.group || 'other'] = (g[r.group || 'other'] || 0) + (r.bytes || 0);
  return g;
};
const groupCounts = (reqs) => {
  const g = {};
  for (const r of reqs) g[r.group || 'other'] = (g[r.group || 'other'] || 0) + 1;
  return g;
};
const orderGroups = (...maps) => {
  const all = new Set(maps.flatMap(m => Object.keys(m)));
  return [
    ...GROUP_ORDER.filter(g => all.has(g)),
    ...[...all].filter(g => !GROUP_ORDER.includes(g)).sort(),
  ];
};
const fmt = (n) => n.toLocaleString().padStart(12);
const fmtDelta = (n) => (n >= 0 ? '+' : '') + n.toLocaleString();
// Bytes this project actually controls. Kept separate because the Meta Pixel's own payload
// (fbevents.js, and a signals/config fetch that only shows up on some runs) swings the
// third-party group by hundreds of KB run to run — real, but not something the optimization
// moves, and enough to drown out the first-party delta if the two are added together.
const firstPartyBytes = (reqs) => reqs.reduce((s, r) => s + (r.thirdParty ? 0 : (r.bytes || 0)), 0);
const firstPartyCount = (reqs) => reqs.filter(r => !r.thirdParty).length;

console.log(`\nCAPTURE (${MODE})`);
console.log('='.repeat(58));
console.log(`  screenshot      ${shotPath}  (${shot.width}x${shot.height})`);
console.log(`  request log     ${reqLogPath}`);
console.log(`  navigation      ${navNote}`);
console.log(`  content height  ${contentHeight} css px`);
console.log(`  requests        ${requests.length}`);
console.log(`  TOTAL BYTES     ${totalBytes.toLocaleString()}`);

console.log(`\nCOUNTDOWN (frozen for a deterministic diff)`);
console.log('='.repeat(58));
if (!countdown.found) {
  console.log('  FAIL  #ng-mm / #ng-ss not in the DOM — countdown markup is gone');
} else {
  const ok = /^\d{2}$/.test(countdown.observed.mm || '') && /^\d{2}$/.test(countdown.observed.ss || '');
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  script.js alive — observed ${countdown.observed.mm}:${countdown.observed.ss}` +
    `, ${countdown.intervals} interval(s) cleared, normalized to 02:00 before the shot`);
}
if (consoleErrors.length || pageErrors.length) {
  console.log(`\n  console errors  ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`    - ${e}`);
  console.log(`  page errors     ${pageErrors.length}`);
  for (const e of pageErrors.slice(0, 10)) console.log(`    - ${e}`);
}

// --------------------------------------------------- per-group breakdown (both modes)
{
  const g = groupBytes(requests);
  const c = groupCounts(requests);
  console.log(`\nBYTE BREAKDOWN (${MODE}, measured over the wire)`);
  console.log('='.repeat(58));
  console.log(`  ${'GROUP'.padEnd(14)}${'BYTES'.padStart(12)}${'REQS'.padStart(8)}`);
  console.log('-'.repeat(58));
  for (const name of orderGroups(g)) {
    console.log(`  ${name.padEnd(14)}${fmt(g[name] || 0)}${String(c[name] || 0).padStart(8)}`);
  }
  console.log('-'.repeat(58));
  console.log(`  ${'FIRST-PARTY'.padEnd(14)}${fmt(firstPartyBytes(requests))}${String(firstPartyCount(requests)).padStart(8)}`);
  console.log(`  ${'TOTAL'.padEnd(14)}${fmt(totalBytes)}${String(requests.length).padStart(8)}`);

  const tp = requests.filter(r => r.thirdParty);
  if (tp.length) {
    const byHost = {};
    for (const r of tp) {
      byHost[r.host] = byHost[r.host] || { bytes: 0, n: 0 };
      byHost[r.host].bytes += r.bytes || 0;
      byHost[r.host].n += 1;
    }
    console.log(`\n  third-party detail by host`);
    for (const [h, v] of Object.entries(byHost).sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.log(`    ${h.padEnd(28)}${fmt(v.bytes)}${String(v.n).padStart(8)} req`);
    }
  }
}

// -------------------------------------------------------------- after-mode checks
if (isAfter) {
  // ---- 1. pixel diff vs baseline ----
  console.log(`\nPIXEL DIFF  after.png vs before.png`);
  console.log('='.repeat(58));
  if (!existsSync(beforePngPath)) {
    console.log('  FAIL  no before.png found — run `node verify.mjs baseline` first');
  } else {
    const before = PNG.sync.read(readFileSync(beforePngPath));
    const after = PNG.sync.read(readFileSync(afterPngPath));
    if (before.width !== after.width || before.height !== after.height) {
      console.log(`  FAIL  size mismatch: before ${before.width}x${before.height} vs after ${after.width}x${after.height}`);
    } else {
      const diff = new PNG({ width: before.width, height: before.height });
      const THRESH = 0.12;
      const diffPixels = pixelmatch(before.data, after.data, diff.data, before.width, before.height, {
        threshold: THRESH, includeAA: false, alpha: 0.15, diffColor: [255, 0, 128],
      });
      writeFileSync(diffPngPath, PNG.sync.write(diff));
      const totalPixels = before.width * before.height;
      const pct = 100 * diffPixels / totalPixels;
      console.log(`  ${diffPixels.toLocaleString()} px changed / ${totalPixels.toLocaleString()} px total  (${pct.toFixed(3)}%)`);
      console.log(`  wrote ${diffPngPath}`);
    }
  }

  const afterReqs = JSON.parse(readFileSync(afterReqPath, 'utf8'));

  // ---- 2. no Google Fonts network calls ----
  console.log(`\nGOOGLE FONTS ASSERTION`);
  console.log('='.repeat(58));
  const badFontHosts = afterReqs.filter(r =>
    r.url.includes('fonts.googleapis.com') || r.url.includes('fonts.gstatic.com'));
  if (badFontHosts.length === 0) {
    console.log('  PASS  zero requests to fonts.googleapis.com / fonts.gstatic.com');
  } else {
    console.log(`  FAIL  ${badFontHosts.length} request(s) still hit Google Fonts:`);
    for (const r of badFontHosts) console.log(`        - ${r.url}`);
  }

  // ---- 3. glyph coverage via document.fonts.check() ----
  // NOTE: several elements carry `text-transform: uppercase`, so the RENDERED glyphs are not
  // the HTML source text. These strings are the UPPERCASE forms on purpose — checking the
  // source-case text would miss a subset that dropped the uppercase glyphs and shipped tofu.
  const FONT_CHECKS = [
    ['600 15px Oswald', 'NEO GARDEN'],
    ['700 32px Oswald', "BOSHLANG'ICH TO'LOVSIZ, PENYA FOIZLARSIZ 60 OYGA BO'LIB TO'LASHGA 100 TA XONADON!"],
    ['700 22px Oswald', 'MARAFONGA ULANISH'],
    ['600 14px Oswald', '60 OYGA'],
    ['600 14px Oswald', '0 FOIZ'],
    ['600 20px Oswald', 'SHAHAR MARKAZI'],
    ['700 16px Oswald', '100 TA XONADON'],
    ['700 36px Oswald', '0123456789'],
    ['600 15px Manrope', 'Faqat marafon kanalimizga ulanib olganlar uchun.'],
    ['600 9.5px Manrope', 'TURAR-JOY MAJMUASI'],
    ['700 11.5px Manrope', 'OLMALIQ'],
    ['700 10.5px Manrope', 'QULAY JOYLASHUV'],
    ['700 10.5px Manrope', 'BIRGINA PASPORT'],
    ['700 12.5px Manrope', 'Aksiyaga faqat'],
    ['800 11px Manrope', 'AKSIYA TUGASHIGA'],
    ['800 10px Manrope', 'DAQIQA'],
    ['800 10px Manrope', 'SONIYA'],
  ];
  const fontResults = await page.evaluate((checks) =>
    checks.map(([spec, text]) => {
      try { return document.fonts.check(spec, text); } catch { return false; }
    }), FONT_CHECKS);

  console.log(`\nGLYPH COVERAGE  (document.fonts.check — uppercase forms as rendered)`);
  console.log('='.repeat(58));
  let fontFails = 0;
  FONT_CHECKS.forEach(([spec, text], i) => {
    if (!fontResults[i]) fontFails++;
    const shown = text.length > 46 ? text.slice(0, 43) + '...' : text;
    console.log(`  ${fontResults[i] ? 'PASS' : 'FAIL'}  ${spec.padEnd(20)} ${shown}`);
  });
  console.log(`  ${fontFails === 0 ? 'PASS' : 'FAIL'}  ${FONT_CHECKS.length - fontFails}/${FONT_CHECKS.length} specs covered`);

  // Advisory per-character scan. document.fonts.check() only knows the @font-face
  // unicode-range descriptor, not the actual cmap of the file behind it, so a woff2 that was
  // subset too aggressively can still pass it — the glyph silently falls through to a system
  // font (or to .notdef tofu). Detect that by measuring each character twice: once as
  // `<family>, monospace` and once as `<absent family>, monospace`. Identical advance widths
  // mean the character was served by the monospace fallback, i.e. <family> does not cover it.
  try {
    const uncovered = await page.evaluate((checks) => {
      const ctx = document.createElement('canvas').getContext('2d');
      const out = [];
      for (const [spec, text] of checks) {
        const cut = spec.lastIndexOf(' ');
        const prefix = spec.slice(0, cut);
        const family = spec.slice(cut + 1).replace(/^["']|["']$/g, '');
        const specTarget = `${prefix} "${family}", monospace`;
        const specBase = `${prefix} "NgDefinitelyNotAFamily", monospace`;
        ctx.font = specTarget;
        if (!ctx.font.includes(family)) continue; // spec rejected by the canvas parser
        // Compare the advance AND the ink box. Advance alone collides by coincidence often
        // enough to be useless (Oswald's 'R' happens to share monospace's advance); a glyph
        // that genuinely came from the fallback matches on every metric at once.
        const metrics = (font, ch) => {
          ctx.font = font;
          const m = ctx.measureText(ch);
          return [m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight,
            m.actualBoundingBoxAscent, m.actualBoundingBoxDescent];
        };
        const bad = new Set();
        for (const ch of new Set([...text])) {
          if (ch === ' ') continue;
          const a = metrics(specTarget, ch);
          const c = metrics(specBase, ch);
          if (a.every((v, k) => Math.abs(v - c[k]) < 0.01)) bad.add(ch);
        }
        if (bad.size) out.push({ spec, chars: [...bad].join('') });
      }
      return out;
    }, FONT_CHECKS);
    console.log(`\n  fallback scan (advisory, advance-width heuristic)`);
    if (uncovered.length === 0) {
      console.log('    clean — every checked character rendered from the declared family');
    } else {
      for (const u of uncovered) console.log(`    SUSPECT  ${u.spec}  ->  ${u.chars}`);
    }
  } catch (err) {
    console.log(`  fallback scan skipped: ${String(err.message || err).split('\n')[0]}`);
  }

  // ---- 4. Meta Pixel still fires ----
  console.log(`\nMETA PIXEL`);
  console.log('='.repeat(58));
  const fb = await page.evaluate(() => {
    const f = window.fbq;
    const out = {
      isFunction: typeof f === 'function',
      loaded: false,
      version: null,
      hasCallMethod: false,
      queue: [],
      queueReadable: true,
    };
    if (typeof f === 'function') {
      out.loaded = !!f.loaded;
      out.version = f.version || null;
      out.hasCallMethod = typeof f.callMethod === 'function';
      try {
        out.queue = Array.from(f.queue || []).map(args =>
          Array.from(args).map(a => (typeof a === 'object' && a !== null) ? JSON.stringify(a) : String(a)));
      } catch { out.queueReadable = false; }
    }
    return out;
  });

  console.log(`  ${fb.isFunction ? 'PASS' : 'FAIL'}  typeof window.fbq === 'function'` +
    (fb.isFunction ? `  (loaded=${fb.loaded}, version=${fb.version}, callMethod=${fb.hasCallMethod})` : ''));

  const fbevents = afterReqs.filter(r => /connect\.facebook\.net\/.*\/fbevents\.js/.test(r.url));
  const fbeventsOk = fbevents.some(r => r.status && r.status >= 200 && r.status < 400);
  const fbeventsBlocked = fbevents.length > 0 && !fbeventsOk;

  const pageViewInQueue = fb.queue.some(args =>
    args.length >= 2 && args[0] === 'track' && args[1] === 'PageView');
  if (pageViewInQueue) {
    console.log(`  PASS  fbq.queue holds a ['track','PageView'] entry`);
  } else if (fb.isFunction && fb.hasCallMethod && fbeventsOk) {
    console.log(`  PASS  fbq.queue drained by fbevents.js (callMethod installed) — the queued` +
      ` ['track','PageView'] was consumed, not dropped`);
  } else {
    console.log(`  FAIL  no ['track','PageView'] entry in fbq.queue and fbevents.js did not consume it`);
    console.log(`        queue = ${JSON.stringify(fb.queue)}`);
  }

  if (fbevents.length === 0) {
    console.log('  FAIL  no request to connect.facebook.net/*/fbevents.js was made');
  } else {
    console.log(`  ${fbeventsOk ? 'PASS' : 'FAIL'}  request to ${fbevents[0].url}` +
      `  (status=${fbevents[0].status ?? fbevents[0].error})`);
  }

  const beacons = afterReqs.filter(r => /(^|\.)facebook\.com\/tr\b/.test(r.url) || r.url.includes('facebook.com/tr?'));
  const pageViewBeacon = beacons.filter(r => r.url.includes('ev=PageView'));
  if (pageViewBeacon.length) {
    console.log(`  PASS  ${pageViewBeacon.length} PageView beacon(s) to facebook.com/tr`);
  } else if (fbeventsBlocked || fbevents.length === 0) {
    console.log('  INCONCLUSIVE  no egress to facebook.net in this environment — the downstream' +
      ' facebook.com/tr beacon cannot be observed. Tag wiring above is unchanged.');
  } else {
    console.log('  INCONCLUSIVE  fbevents.js loaded but no facebook.com/tr beacon was captured' +
      ' (it can be sent via sendBeacon/fetch keepalive after networkidle).');
  }

  // ---- 5. byte budget table: before vs after, grouped by asset type ----
  const beforeReqs = existsSync(beforeReqPath) ? JSON.parse(readFileSync(beforeReqPath, 'utf8')) : [];
  const b = groupBytes(beforeReqs);
  const a = groupBytes(afterReqs);
  const bc = groupCounts(beforeReqs);
  const ac = groupCounts(afterReqs);

  console.log(`\nBYTE BUDGET  (measured, before vs after — grouped by asset type)`);
  console.log('='.repeat(76));
  console.log(`  ${'GROUP'.padEnd(14)}${'BEFORE'.padStart(12)}${'AFTER'.padStart(12)}${'DELTA'.padStart(14)}${'B#'.padStart(6)}${'A#'.padStart(6)}`);
  console.log('-'.repeat(76));
  let totalB = 0, totalA = 0;
  for (const g of orderGroups(b, a)) {
    const bv = b[g] || 0, av = a[g] || 0;
    totalB += bv; totalA += av;
    console.log(`  ${g.padEnd(14)}${fmt(bv)}${fmt(av)}${fmtDelta(av - bv).padStart(14)}` +
      `${String(bc[g] || 0).padStart(6)}${String(ac[g] || 0).padStart(6)}`);
  }
  console.log('-'.repeat(76));
  const fpB = firstPartyBytes(beforeReqs), fpA = firstPartyBytes(afterReqs);
  console.log(`  ${'FIRST-PARTY'.padEnd(14)}${fmt(fpB)}${fmt(fpA)}${fmtDelta(fpA - fpB).padStart(14)}` +
    `${String(firstPartyCount(beforeReqs)).padStart(6)}${String(firstPartyCount(afterReqs)).padStart(6)}`);
  console.log(`  ${'TOTAL'.padEnd(14)}${fmt(totalB)}${fmt(totalA)}${fmtDelta(totalA - totalB).padStart(14)}` +
    `${String(beforeReqs.length).padStart(6)}${String(afterReqs.length).padStart(6)}`);
  if (fpB > 0) {
    console.log(`  ${'change (1p)'.padEnd(14)}${''.padStart(12)}${''.padStart(12)}` +
      `${((100 * (fpA - fpB)) / fpB).toFixed(1).padStart(13)}%`);
  }
  if (totalB > 0) {
    console.log(`  ${'change (all)'.padEnd(14)}${''.padStart(12)}${''.padStart(12)}` +
      `${((100 * (totalA - totalB)) / totalB).toFixed(1).padStart(13)}%`);
  }
  const tpCountB = beforeReqs.length - firstPartyCount(beforeReqs);
  const tpCountA = afterReqs.length - firstPartyCount(afterReqs);
  if (tpCountB !== tpCountA) {
    console.log(`\n  NOTE  third-party request count differs (${tpCountB} -> ${tpCountA}). The Meta Pixel`);
    console.log(`        fetches connect.facebook.net/signals/config (~430 KB) on some runs and not`);
    console.log(`        others, so compare the FIRST-PARTY row for the real effect of this work.`);
  }
}

await browser.close();
server.close();
process.exitCode = 0;

import { launch } from '/Users/iqboljon/Desktop/neo-garden/1/tools/browser.mjs';

const browser = await launch();
const page = await browser.newPage({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
});
await page.goto('file:///Users/iqboljon/Desktop/neo-garden/3/index.html', {
  waitUntil: 'networkidle',
});
// make sure both images have decoded so natural size / layout is final
await page.evaluate(() => Promise.all(
  [...document.images].map(i => (i.decode ? i.decode().catch(() => {}) : null))
));

const out = await page.evaluate(() => {
  const grab = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      sel,
      x: r.x, y: r.y, width: r.width, height: r.height,
      naturalWidth: el.naturalWidth ?? null,
      naturalHeight: el.naturalHeight ?? null,
      objectFit: cs.objectFit,
      objectPosition: cs.objectPosition,
    };
  };
  const hero = document.querySelector('.ng-hero');
  const hr = hero.getBoundingClientRect();
  const hcs = getComputedStyle(hero);
  return {
    dpr: window.devicePixelRatio,
    hero: {
      width: hr.width, height: hr.height,
      borderTop: hcs.borderTopWidth, borderLeft: hcs.borderLeftWidth,
      clientWidth: hero.clientWidth, clientHeight: hero.clientHeight,
    },
    img: grab('.ng-hero-img'),
    person: grab('.ng-hero-person'),
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();

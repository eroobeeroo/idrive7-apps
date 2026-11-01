'use strict';

// eDrive Live's kW over the Waze map (apps/edrive2/overlay.js) against a fake cluster render client and a status.json
// in a temp folder: where the badge goes on each target, that it shows only while the map shows and a reading
// exists, and that updates carry only what changed. Also writes a preview of the badge:
//   node kit/tools/test_edrive_overlay.js [preview.png]

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { startOverlay, mapRect, badgeRect, drawBadge, changed } = require(path.join(ROOT, 'apps', 'edrive2', 'overlay.js'));
const { Canvas } = require(path.join(KIT, 'canvas'));
const themes = require(path.join(KIT, 'themes'));
const theme = themes.theme('m_tricolour');

let ok = 0;
const check = (name, fn) => { fn(); ok++; console.log('ok   ' + name); };

/* ---------- geometry ---------- */
check('cluster map: the whole 1088x480 scene', () => assert.deepStrictEqual(mapRect('map', 0), { x: 0, y: 0, w: 1088, h: 480 }));
check('panel: the centred map area', () => assert.deepStrictEqual(mapRect('panel', 0), { x: 416, y: 120, w: 1088, h: 480 }));
check('HUD standard: 452x200 at 173,140 (as waze-on-cluster scales it)', () => assert.deepStrictEqual(mapRect('hud', 0), { x: 173, y: 140, w: 452, h: 200 }));
check('HUD, both extras at 85 %: moved left to end by x 700 (what the HUD shows), clear of the speed', () => {
    const b = badgeRect(mapRect('hud', 85), 'bottom', 'hud', 2);
    assert(b.x + b.w <= 700 && b.x >= 345, JSON.stringify(b));
    assert.strictEqual(badgeRect(mapRect('hud', 85), 'bottom', 'hud', 0).x, 420);
});
check('HUD widest: 85 % (680x300), 100 % is held to it', () => { assert.deepStrictEqual(mapRect('hud', 85), mapRect('hud', 100)); assert.strictEqual(mapRect('hud', 85).w, 680); });
check('unknown target: none', () => assert.strictEqual(mapRect('nope', 0), null));
check('badge inside the map, bottom and top', () => {
    ['map', 'hud', 'panel'].forEach((tg) => [0, 40, 70, 100].forEach((pct) => ['bottom', 'top'].forEach((w) => {
        const r = mapRect(tg, pct), b = badgeRect(r, w, tg);
        assert(b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h, tg + ' ' + pct + ' ' + w);
        assert(b.w % 4 === 0 && b.h % 2 === 0 && b.w >= 100);
    })));
    assert.deepStrictEqual(badgeRect(mapRect('map', 0), 'bottom', 'map'), { x: 422, y: 402, w: 244, h: 72 });   // 1.3x, at the map's bottom edge (below the car's arrow), as wide as its content
    assert.deepStrictEqual(badgeRect(mapRect('hud', 0), 'bottom', 'hud'), { x: 420, y: 293, w: 136, h: 40 });   // the HUD's size, right of its speed readout
});

/* ---------- drawing and diffs ---------- */
const pw = (kw) => ({ kw, text: kw == null ? '--' : (kw < -0.3 ? '-' : '') + Math.abs(kw).toFixed(Math.abs(kw) < 10 ? 1 : 0), col: kw < -0.3 ? '#2fd27a' : theme.text });
check('the badge draws: opaque-ish backdrop, transparent corners', () => {
    const cv = new Canvas(200, 56);
    drawBadge(cv, theme, pw(23), 100, 50);
    assert.strictEqual(cv.d[3], 0, 'corner transparent');
    assert(cv.d[(28 * 200 + 100) * 4 + 3] > 150, 'middle covered');
});
check('a changed value: only its rectangles', () => {
    const a = new Canvas(200, 56), b = new Canvas(200, 56);
    drawBadge(a, theme, pw(23), 100, 50); drawBadge(b, theme, pw(23), 100, 50);
    assert.strictEqual(changed(a.d, b.d, 200, 56, 100), null);
    drawBadge(b, theme, pw(-12), 100, 50);
    const r = changed(a.d, b.d, 200, 56, 100);
    assert(r && r.length === 2);
    assert(r.reduce((n, x) => n + x.w * x.h, 0) < 200 * 56);
});

/* ---------- following the map ---------- */
class FakeCR extends EventEmitter {
    constructor(app) { super(); this.app = app; this.layers = new Map(); this.next = 1; this.log = []; FakeCR.last = this; }
    connect() { this.connected = true; setImmediate(() => this.emit('ready')); }
    close() { this.connected = false; }
    image(o) { const r = this.next++; this.layers.set(r, Object.assign({}, o)); this.log.push(['image', r, o]); return r; }
    set(r, o) { Object.assign(this.layers.get(r), o); this.log.push(['set', r, o]); }
    drop(r) { this.layers.delete(r); this.log.push(['drop', r]); }
    pixels(r, rects, px) {
        const l = this.layers.get(r);
        const need = rects ? rects.reduce((n, x) => n + x.w * x.h * 4, 0) : l.iw * l.ih * 4;
        assert.strictEqual(px.length, need, 'pixel bytes match');
        this.log.push(['pixels', r, rects]);
    }
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-'));
    const status = path.join(dir, 'status.json');
    const write = (o) => { fs.writeFileSync(status + '.tmp', JSON.stringify(o)); fs.renameSync(status + '.tmp', status); };
    const settings = { v: { mapOverlay: 'bottom', gaugeKw: 100 }, get(k) { return this.v[k]; } };
    const logs = [];
    const log = { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) };
    let kw = 18, fast = 0, t = 1e6;
    let ind = 'off';
    const lv = { powerNow: () => pw(kw), limitsNow: () => ({ out: 120, in: 60 }), keepFast: () => { fast++; }, indicator: () => ind, night: () => night, extras: () => extras };
    let night = false, extras = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms || 30));
    const ov = startOverlay({ settings, log, theme: () => theme }, lv, { statusPath: status, ClusterRender: FakeCR, now: () => t, setInterval: () => 0, clearInterval: () => {} });
    const step = async () => { ov._read(); await wait(); };

    await step();
    check('no status file: nothing, no connection', () => { assert.strictEqual(ov.shown(), false); assert(!FakeCR.last); });

    write({ state: 'waiting', target: 'map', hud_width_pct: 0 });
    await step();
    check('map not showing: still nothing', () => { assert.strictEqual(ov.shown(), false); assert(!FakeCR.last); });

    write({ state: 'showing', target: 'map', hud_width_pct: 0 });
    await step();
    await wait();
    const cr = FakeCR.last;
    check('map showing on the cluster: an overlay layer at its bottom, shown, fast reads asked', () => {
        assert(cr && cr.app === 'edrive');
        const l = [...cr.layers.values()][0];
        assert.strictEqual(l.target, 'map'); assert.strictEqual(l.klass, 'overlay');
        assert.deepStrictEqual([l.x, l.y, l.w, l.h], [422, 402, 244, 72]);
        assert.strictEqual(l.visible, true); assert(ov.shown()); assert(fast > 0);
        assert(cr.log.some((e) => e[0] === 'pixels' && e[2] === null), 'whole image first');
    });

    let n = cr.log.length;
    t += 100; kw = 40; ov._tick();
    check('within 250 ms of the last: no update', () => assert.strictEqual(cr.log.length, n));
    t += 300; ov._tick();
    check('a new value: only the rectangles that changed', () => {
        const e = cr.log.slice(n).find((x) => x[0] === 'pixels');
        assert(e && Array.isArray(e[2]) && e[2].length >= 1);
    });
    n = cr.log.length;
    t += 300; ov._tick();
    check('the same value again: nothing sent', () => assert.strictEqual(cr.log.length, n));

    kw = null; t += 300; ov._tick();
    check('no reading (parked): hidden', () => { assert.strictEqual(ov.shown(), false); assert.strictEqual([...cr.layers.values()][0].visible, false); });
    kw = 5; t += 300; ov._tick();
    check('a reading again: shown', () => assert(ov.shown()));

    write({ state: 'showing', target: 'hud', hud_width_pct: 0 });
    await step();
    check('the map moves to the HUD: the old layer dropped, a new one inside the HUD map', () => {
        assert(cr.log.some((e) => e[0] === 'drop'));
        const l = [...cr.layers.values()][0];
        const r = mapRect('hud', 0);
        assert.strictEqual(l.target, 'hud');
        assert(l.x >= r.x && l.y + l.h <= r.y + r.h && l.w < 200, JSON.stringify(l));
        assert(ov.shown());
    });

    write({ state: 'waiting', target: 'hud', hud_width_pct: 0, reason: 'a HUD pop-up is open' });
    await step();
    check('a HUD pop-up (the map waits): hidden, so it never asks for the slot', () => {
        assert.strictEqual(ov.shown(), false); assert.strictEqual([...cr.layers.values()][0].visible, false);
    });
    write({ state: 'showing', target: 'hud', hud_width_pct: 0 });
    await step();
    settings.v.mapOverlay = 'off'; t += 300; ov._tick();
    check('setting off: hidden', () => assert.strictEqual(ov.shown(), false));
    settings.v.mapOverlay = 'top'; t += 300; ov._tick();
    check('setting top: at the top of the map', () => {
        const l = [...cr.layers.values()][0], r = mapRect('hud', 0);
        assert(l.y < r.y + 20 && ov.shown(), JSON.stringify(l));
    });

    settings.v.mapOverlay = 'bottom';
    write({ state: 'showing', target: 'map', hud_width_pct: 70 });
    await step();
    settings.v.meterDisplay = 'hud'; t += 300; ov._tick();
    check('Always on the HUD, the map on the cluster: the badge on the HUD at its standard map place', () => {
        const l = [...cr.layers.values()][0], r = mapRect('hud', 0);
        assert.strictEqual(l.target, 'hud'); assert(ov.shown());
        assert(l.y + l.h <= r.y + r.h && l.y > r.y + r.h / 2, JSON.stringify(l));
    });
    fs.unlinkSync(status);
    await step();
    t += 300; ov._tick();
    check('Always on the HUD: shown without Waze on cluster too', () => assert(ov.shown()));
    kw = null; t += 300; ov._tick();
    check('Always on the HUD, no reading: hidden', () => assert.strictEqual(ov.shown(), false));
    settings.v.meterDisplay = 'map'; kw = 5; t += 300; ov._tick();
    check('Waze on cluster stopped (status gone): hidden', () => assert.strictEqual(ov.shown(), false));
    /* extras, brightness, night */
    settings.v.meterDisplay = 'map'; settings.v.mapOverlay = 'bottom';
    write({ state: 'showing', target: 'hud', hud_width_pct: 0 });
    await step();
    extras = [{ label: 'BATT', text: '24°' }, { label: 'OIL', text: '88°' }]; t += 300; ov._tick();
    let ml = [...cr.layers.values()].find((l) => l.klass === 'overlay' && l.w > 100);
    check('two extras: the meter wider, still inside the HUD map', () => {
        const r = mapRect('hud', 0);
        assert(ml && ml.w > 140 && ml.x >= r.x && ml.x + ml.w <= r.x + r.w, JSON.stringify(ml));
    });
    settings.v.hudBrightness = 50; t += 300; ov._tick();
    check('HUD brightness 50 %: the meter at half opacity', () => assert.strictEqual(ml.opacity, 0.5));
    settings.v.hudBrightness = 100; night = true; t += 300; ov._tick();
    check('night: dimmer', () => assert(ml.opacity < 1 && ml.opacity > 0.4));
    settings.v.nightDim = 'off'; t += 300; ov._tick();
    check('night dimming off: full', () => assert.strictEqual(ml.opacity, 1));
    check('status for the diagnostics', () => { const st = ov.status(); assert(/connected|connecting/.test(st.renderer) && /hud/.test(st.map)); });
    extras = []; night = false; settings.v.nightDim = 'on';

    /* turn signals: arrows on the HUD, blinking by opacity only */
    const sets = () => cr.log.filter((e) => e[0] === 'set').length;
    ov._arrowTick();
    check('no signal: no arrows', () => assert(!ov.arrows().shown && !ov.arrows().refs.left));
    ind = 'left'; t += 10; ov._arrowTick();
    const refs = ov.arrows().refs, la = cr.layers.get(refs.left), ra = cr.layers.get(refs.right);
    check('left: both arrows made on the HUD, small, at its top; the left lit at once', () => {
        assert(la.target === 'hud' && ra.target === 'hud' && la.y < 200 && la.w <= 32 && la.x < ra.x);
        assert(ov.arrows().shown && la.visible && la.opacity === 1 && ra.opacity === 0);
    });
    const px0 = cr.log.filter((e) => e[0] === 'pixels').length;
    t += 400; ov._arrowTick();
    check('blinks: off after 375 ms', () => assert(la.opacity === 0 && la.visible));
    t += 400; ov._arrowTick();
    check('and on again, with no pixels sent', () => assert(la.opacity === 1 && cr.log.filter((e) => e[0] === 'pixels').length === px0));
    const n0 = sets();
    t += 50; ov._arrowTick();
    check('nothing sent between flashes', () => assert.strictEqual(sets(), n0));
    ind = 'both'; t += 10; ov._arrowTick();
    check('hazards: both lit', () => assert(la.opacity === 1 && ra.opacity === 1));
    ind = 'off'; t += 10; ov._arrowTick();
    check('let go: dark, still placed for a moment', () => assert(la.opacity === 0 && ov.arrows().shown));
    t += 1300; ov._arrowTick();
    check('then hidden (the HUD slot let go)', () => assert(!ov.arrows().shown && !la.visible));
    settings.v.turnSignals = 'off'; ind = 'right'; t += 10; ov._arrowTick();
    check('setting off: no arrows', () => assert(!ov.arrows().shown));
    ov.stop();

    if (process.argv[2]) {
        const big = new Canvas(640, 160);
        big.clear([40, 70, 110, 255]);
        [[23, 0, 0], [-14.5, 220, 0], [4.2, 0, 80], [85, 220, 80]].forEach(([v, x, y]) => {
            const c = new Canvas(200, 56); drawBadge(c, theme, pw(v), 100, 50);
            const h = new Canvas(124, 34); drawBadge(h, theme, pw(v), 100, 50);
            [[c, x + 10, y + 10], [h, x + 10 + 0, y + 0]].slice(0, 1).forEach(([s, ox, oy]) => blend(big, s, ox, oy));
            blend(big, h, 460 + (x ? 0 : 0), y + (x ? 40 : 0) + 10);
        });
        fs.writeFileSync(process.argv[2], big.png());
        console.log('preview: ' + process.argv[2]);
    }
    console.log(ok + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

function blend(dst, src, ox, oy) {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4, j = ((oy + y) * dst.w + ox + x) * 4, a = src.d[i + 3] / 255;
        for (let k = 0; k < 3; k++) dst.d[j + k] = src.d[i + k] * a + dst.d[j + k] * (1 - a);
    }
}

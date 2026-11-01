'use strict';
/**
 * overlay.js - the battery's power now (kW and a small centre-zero bar) drawn over the Waze map in
 * the instrument cluster or the HUD, wherever Waze on cluster (robertn_waze_cluster) shows it.
 *
 * Setting meterDisplay 'hud' puts it on the HUD instead, whenever there is a reading, wherever the map
 * is (inside the HUD map's picture while the map is on the HUD, else at the HUD's standard map place).
 *
 * By default it follows the map: Waze on cluster writes /run/waze-on-cluster/status.json (state, target,
 * hud_width_pct) whenever that changes; while it says the map is showing, a small image layer
 * (class overlay, above the map) goes on the same target through the cluster render service
 * (cluster_render_client.js), at the bottom or top of the map's picture. Otherwise the layer is
 * hidden, and a hidden layer never asks for a slot, so the badge never shows on its own and never
 * keeps the cluster or HUD from the stock screens. It is hidden too while eDrive has no reading
 * (parked, car asleep, no diagnostic link): eDrive's power reads pause then.
 *
 * Updates go at most UPDATE_MS apart and only when what is drawn changes, as the rectangles that
 * changed, so the overlay costs the map's upload budget next to nothing.
 */
const fs = require('fs');
const path = require('path');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const STATUS = '/run/waze-on-cluster/status.json';
const UPDATE_MS = 250;            // the badge redrawn at most this often (4 / s)
const POLL_MS = 1000;             // status.json read this often (and on every change it is watched for)
const GO = '#2fd27a';
const TEX = { w: 1088, h: 480 };  // the map's picture (waze-on-cluster tex_size)
const SCENES = { map: [1088, 480], panel: [1920, 720], hud: [800, 480] };
const HUD_SPEED_RIGHT = 420;     // the HUD's speed readout ends left of this (scene pixels), with a gap
const HUD_MAX_PCT = 85;           // the HUD map's widest (waze-on-cluster hud_width_pct)
// turn signal arrows on the HUD: small, a pair at the top middle, inside the standard map's top edge
const ARROW = { w: 30, h: 24, y: 146, left: 349, right: 421 };   // the cluster's proportions (5:4)
const INDICATOR_GREEN = '#22d046';   // the cluster's indicator green
const BLINK_MS = 375;             // on, then off, this long each (about the car's own rate)
const ARROW_TICK_MS = 60;

/** The map's rectangle on a target, as waze-on-cluster places it (map_feed.cpp quad, map_geometry.cpp map_quad). */
function mapRect(target, hudPct) {
    const sc = SCENES[target];
    if (!sc) return null;
    const [tw, th] = sc;
    let w, h;
    if (target === 'hud' && hudPct > 0) {
        w = Math.floor(tw * Math.min(HUD_MAX_PCT, hudPct) / 100);
        h = Math.floor((w * TEX.h + TEX.w / 2) / TEX.w);
        if (h > th) { h = th; w = Math.floor((h * TEX.w + TEX.h / 2) / TEX.h); }
    } else {
        let aw = tw, ah = th;
        if (tw >= 1088 && th >= 480) { aw = 1088; ah = 480; }
        else if (tw === 800 && th === 480) { aw = 453; ah = 320; }       // the HUD's standard map: 56.7 % x 66.7 %
        if (TEX.w * ah <= aw * TEX.h) { h = ah; w = Math.floor((ah * TEX.w + TEX.h / 2) / TEX.h); }
        else { w = aw; h = Math.floor((aw * TEX.h + TEX.w / 2) / TEX.w); }
    }
    let x = Math.floor((tw - w) / 2), y = Math.floor((th - h) / 2);
    // shown smaller than the picture: scaled to a multiple of 4, centred where the rectangle was
    const sw = w & ~3, sh = h & ~3;
    if (sw < TEX.w || sh < TEX.h) { x += Math.floor((w - sw) / 2); y += Math.floor((h - sh) / 2); w = sw; h = sh; }
    return { x, y, w, h };
}

/** The badge's place and size inside the map's rectangle r: { x, y, w, h } on the target. */
function badgeRect(r, where, target) {
    // the HUD's size to its map's width; on the cluster half as big again (300x84), read at a glance past the wheel
    const s = target === 'hud' ? Math.max(0.62, Math.min(1, r.w / 640)) : 1.5;
    const w = Math.round(200 * s / 4) * 4, h = Math.round(56 * s / 2) * 2;
    // on the cluster a tenth of the map in from its edge (clear of the street names at the bottom and of the
    // car's arrow in the middle); on the HUD near the edge of the map's picture, and at the bottom to the right
    // of HUD_SPEED_RIGHT: the HUD's own speed readout sits left of the middle on that row (seen on a G05)
    const m = target === 'hud' ? Math.round(10 * s) : Math.round(r.h * 0.1);
    const y = where === 'top' ? r.y + m : r.y + r.h - h - m;
    let x = r.x + Math.floor((r.w - w) / 2);
    if (target === 'hud' && where !== 'top') x = Math.min(Math.max(x, HUD_SPEED_RIGHT), r.x + r.w - w);
    return { x, y, w, h };
}

/** Draws the badge: dark rounded backdrop, kW right-aligned, "kW", then the bar (regen left, use right). */
function drawBadge(cv, t, pw, outMax, inMax) {
    const w = cv.w, h = cv.h;
    cv.clear([0, 0, 0, 0]);
    cv.roundRect(0, 0, w, h, h * 0.32, [8, 9, 12, 190]);
    const base = Math.round(h * 0.69), nx = Math.round(w * 0.39);
    cv.text(pw.text, nx, base, Math.round(h * 0.54), pw.col, { font: 'bold', align: 'right', literal: true });
    cv.text('kW', nx + Math.round(w * 0.025), base, Math.round(h * 0.25), t.dim, { font: 'bold', literal: true });
    const bx = Math.round(w * 0.56), bw = w - bx - Math.round(w * 0.06), bh = Math.max(6, Math.round(h * 0.2)), by = Math.round((h - bh) / 2);
    const span = outMax + inMax, x0 = bx + bw * inMax / span;
    const X = (v) => x0 + G.clamp(v, -inMax, outMax) / span * bw;
    cv.roundRect(bx, by, bw, bh, bh / 2, withAlpha(t.track, 0.95));
    const kw = pw.kw;
    if (G.isNum(kw) && Math.abs(kw) > 0.05) {
        if (kw > 0) cv.rampRect(x0, by, X(kw) - x0, bh, bh / 2, t.hotRamp || t.ramp, x0, bx + bw - x0);
        else cv.roundRect(X(kw), by, x0 - X(kw), bh, bh / 2, GO);
    }
    cv.fillRect(Math.round(x0) - 1, by - 3, 2, bh + 6, t.text);
}

/**
 * A turn signal arrow pointing left or right, w x h, on a transparent ground: the shape of the iDrive 7
 * cluster's own (the standard indicator arrow, solid green: a triangle head the arrow's full height and a bit
 * over half its length, a shaft a little over two fifths of its height), scaled down for the HUD.
 */
function drawArrow(cv, dir) {
    const w = cv.w, h = cv.h, m = 1;            // 1 px clear for the anti-aliased edge
    const L = w - 2 * m, H = h - 2 * m, head = L * 0.56, bar = H * 0.42;
    cv.clear([0, 0, 0, 0]);
    const tip = dir === 'left' ? m : w - m, base = dir === 'left' ? m + head : w - m - head, end = dir === 'left' ? w - m : m;
    cv.convex([[tip, h / 2], [base, m], [base, h - m]], INDICATOR_GREEN);
    // the shaft overlaps the head by a pixel, so no seam shows between them
    const x0 = Math.min(base, end) - (dir === 'left' ? 1 : 0), x1 = Math.max(base, end) + (dir === 'left' ? 0 : 1);
    cv.fillRect(x0, h / 2 - bar / 2, x1 - x0, bar, INDICATOR_GREEN);
}

/** The rectangles where a and b (RGBA, w wide) differ: one per band split at `cut`, null when equal. */
function changed(a, b, w, h, cut) {
    const out = [];
    [[0, cut], [cut, w]].forEach(([c0, c1]) => {
        let x0 = c1, x1 = -1, y0 = h, y1 = -1;
        for (let y = 0; y < h; y++) {
            for (let x = c0; x < c1; x++) {
                const i = (y * w + x) * 4;
                if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
                    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
        }
        if (x1 >= 0) out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    });
    return out.length ? out : null;
}

/** The rows of rects out of an RGBA image w wide, packed one rect after another. */
function packRects(d, w, rects) {
    let n = 0;
    rects.forEach((r) => { n += r.w * r.h * 4; });
    const out = Buffer.alloc(n);
    let off = 0;
    rects.forEach((r) => {
        for (let y = 0; y < r.h; y++) {
            const s = ((r.y + y) * w + r.x) * 4;
            out.set(d.subarray(s, s + r.w * 4), off);
            off += r.w * 4;
        }
    });
    return out;
}

/**
 * ctx: the app's (settings, log, theme); lv: { powerNow(t), limitsNow(), keepFast() } from eDrive Live.
 * opts (tests): statusPath, ClusterRender, now, setInterval, clearInterval.
 */
function startOverlay(ctx, lv, opts) {
    opts = opts || {};
    const { settings, log } = ctx;
    const statusPath = opts.statusPath || STATUS;
    const now = opts.now || Date.now;
    const where = () => settings.get('mapOverlay') || 'bottom';
    // 'map': on the display the Waze map is on, while it shows; 'hud': on the HUD whenever there is a reading
    const onHud = () => settings.get('meterDisplay') === 'hud';
    /** Where the badge goes now: { target, pct } (the map's place it sits in), null for nowhere. */
    const place = () => {
        if (onHud()) return { target: 'hud', pct: map.showing && map.target === 'hud' ? map.pct : 0 };
        return map.showing ? { target: map.target, pct: map.pct } : null;
    };
    let CR = opts.ClusterRender;
    let cr = null, ref = 0, geo = '', cv = null, last = null, visible = false, lastT = 0;
    let map = { showing: false, target: null, pct: 0 }, statusText = '';
    let warned = '';
    const warnOnce = (m) => { if (m !== warned) { warned = m; log.warn('map overlay: ' + m); } };

    function readStatus() {
        fs.readFile(statusPath, 'utf8', (err, txt) => {
            if (err) { if (map.showing) log.info('map overlay: Waze on cluster status gone'); map = { showing: false, target: null, pct: 0 }; statusText = ''; return tick(); }
            if (txt === statusText) return undefined;
            statusText = txt;
            let s;
            try { s = JSON.parse(txt); } catch (e) { return undefined; }    // half written: the next read
            const target = String(s.target || '').split('+')[0] || null;
            const next = { showing: s.state === 'showing' && !!SCENES[target], target, pct: Number(s.hud_width_pct) || 0 };
            if (next.showing !== map.showing || next.target !== map.target) log.info('map overlay: Waze map ' + (next.showing ? 'showing on ' + next.target : 'not showing (' + (s.state || '?') + ')'));
            map = next;
            if (place()) lv.keepFast();
            return tick();
        });
    }

    function client() {
        if (cr) return cr;
        if (!CR) {
            try { CR = require('./cluster_render_client').ClusterRender; } catch (e) { warnOnce('no render client: ' + e.message); return null; }
        }
        cr = new CR('edrive');
        // (after a reconnect the client sends each image whole again by itself)
        cr.on('ready', () => tick());
        cr.on('layer', (r, state, reason) => { if (r === ref && state === 'error') warnOnce('layer: ' + (reason || state)); });
        cr.on('refused', (op, r, reason) => warnOnce(op + ' refused: ' + reason));
        cr.on('error', (e) => warnOnce(String(e && e.message || e)));
        cr.connect();
        return cr;
    }

    function hide() {
        if (cr && ref && visible) cr.set(ref, { visible: false });
        visible = false;
    }

    /** The layer for the map's current place; a new one when its size or place changed. */
    function layer() {
        const pl = place();
        const r = pl && mapRect(pl.target, pl.pct);
        if (!r) return 0;
        const b = badgeRect(r, where(), pl.target);
        const key = [pl.target, b.x, b.y, b.w, b.h].join(',');
        if (key === geo && ref) return ref;
        if (!client()) return 0;
        if (ref) cr.drop(ref);
        geo = key;
        visible = false;
        last = null;
        cv = new Canvas(b.w, b.h);
        ref = cr.image({ target: pl.target, klass: 'overlay', z: 10, x: b.x, y: b.y, w: b.w, h: b.h, iw: b.w, ih: b.h, visible: false });
        if (!ref) warnOnce('the renderer refused a ' + b.w + 'x' + b.h + ' layer');
        else log.info('map overlay: ' + b.w + 'x' + b.h + ' at ' + b.x + ',' + b.y + ' on ' + pl.target);
        return ref;
    }

    function tick() {
        if (where() === 'off' || !place()) return hide();
        const t = ctx.theme(), pw = lv.powerNow(t);
        if (!G.isNum(pw.kw)) return hide();               // no reading (parked, asleep, no link): nothing to show
        if (!layer()) return undefined;
        const tm = now();
        if (visible && tm - lastT < UPDATE_MS - 40) return undefined;    // (the draw timer's jitter)
        lastT = tm;
        const outMax = settings.get('gaugeKw') || 100, lim = lv.limitsNow();
        const inMax = Math.max(10, lim && G.isNum(lim.in) && lim.in >= 15 ? lim.in : outMax * 0.5);
        drawBadge(cv, t, pw, outMax, inMax);
        const d = cv.d;
        if (!last) {
            cr.pixels(ref, null, Buffer.from(d.buffer, d.byteOffset, d.length));
            last = Uint8Array.from(d);
        } else {
            const rects = changed(last, d, cv.w, cv.h, Math.round(cv.w * 0.5));
            if (rects) { cr.pixels(ref, rects, packRects(d, cv.w, rects)); last.set(d); }
        }
        if (!visible) { cr.set(ref, { visible: true }); visible = true; }
        return undefined;
    }

    // status.json is replaced (rename) on every change: watching its folder sees that at once
    let watcher = null;
    const watch = () => {
        if (watcher) return;
        try {
            watcher = fs.watch(path.dirname(statusPath), (ev, name) => { if (!name || name === path.basename(statusPath)) readStatus(); });
            watcher.on('error', () => { try { watcher.close(); } catch (e) { /* gone */ } watcher = null; });
        } catch (e) { watcher = null; }    // Waze on cluster not installed (no folder): polled until it is
    };
    const si = opts.setInterval || setInterval, ci = opts.clearInterval || clearInterval;
    const poll = si(() => { watch(); readStatus(); }, POLL_MS);
    const draw = si(() => { if (where() !== 'off' && place()) { lv.keepFast(); tick(); } else hide(); }, UPDATE_MS);
    watch();
    readStatus();
    process.on('exit', () => { hide(); });

    /* ---------- turn signals on the HUD ----------
     * lv.indicator(): 'off' | 'left' | 'right' | 'both' (hazards), from the car's light module. The two arrows
     * are drawn and sent once; blinking only switches their opacity (a few bytes each time, no pixels), and
     * they stay visible (opacity 0 between flashes) so the HUD's slot is kept while they blink. */
    const arrows = { left: 0, right: 0 };
    let arrowsShown = false, blinkFrom = 0, lastDir = 'off', lastPhase = null, offSince = 0;
    const signalsOn = () => settings.get('turnSignals') !== 'off' && typeof lv.indicator === 'function';
    function arrowLayers() {
        if (arrows.left || !client()) return !!arrows.left;
        ['left', 'right'].forEach((d) => {
            const c = new Canvas(ARROW.w, ARROW.h);
            drawArrow(c, d);
            const ref = cr.image({ target: 'hud', klass: 'overlay', z: 12, x: ARROW[d], y: ARROW.y, w: ARROW.w, h: ARROW.h, iw: ARROW.w, ih: ARROW.h, visible: false, opacity: 0 });
            if (ref) cr.pixels(ref, null, Buffer.from(c.d.buffer, c.d.byteOffset, c.d.length));
            arrows[d] = ref;
        });
        log.info('turn signals: arrows on the HUD');
        return !!arrows.left;
    }
    function hideArrows() {
        if (arrowsShown && cr) ['left', 'right'].forEach((d) => { if (arrows[d]) cr.set(arrows[d], { visible: false, opacity: 0 }); });
        arrowsShown = false;
        lastPhase = null;
    }
    function arrowTick() {
        const dir = signalsOn() ? lv.indicator() || 'off' : 'off';
        const tm = now();
        if (dir === 'off') {
            // the arrows go a moment after the stalk is let go (no flicker between flashes on tap-blink)
            if (lastDir !== 'off') offSince = tm;
            lastDir = 'off';
            if (arrowsShown && tm - offSince > 1200) hideArrows();
            else if (arrowsShown && lastPhase !== false) { ['left', 'right'].forEach((d) => cr.set(arrows[d], { opacity: 0 })); lastPhase = false; }
            return;
        }
        if (dir !== lastDir) { blinkFrom = tm; lastDir = dir; lastPhase = null; }
        if (!arrowLayers()) return;
        if (!arrowsShown) { ['left', 'right'].forEach((d) => cr.set(arrows[d], { visible: true, opacity: 0 })); arrowsShown = true; }
        const on = Math.floor((tm - blinkFrom) / BLINK_MS) % 2 === 0;
        if (on === lastPhase) return;
        lastPhase = on;
        ['left', 'right'].forEach((d) => cr.set(arrows[d], { opacity: on && (dir === d || dir === 'both') ? 1 : 0 }));
    }
    const arrowTimer = si(arrowTick, ARROW_TICK_MS);
    process.on('exit', () => { hideArrows(); });

    return {
        /** Whether the badge is on the map now. */
        shown: () => visible,
        /** The Waze map as status.json says: { showing, target, pct }. */
        map: () => Object.assign({}, map),
        stop() { ci(poll); ci(draw); ci(arrowTimer); if (watcher) watcher.close(); hide(); hideArrows(); if (cr) cr.close(); },
        /** The turn signal arrows: { shown, phase } (phase true: lit). */
        arrows: () => ({ shown: arrowsShown, phase: lastPhase, refs: Object.assign({}, arrows) }),
        _arrowTick: arrowTick,
        _tick: tick, _read: readStatus,
    };
}

module.exports = { startOverlay, mapRect, badgeRect, drawBadge, drawArrow, changed };

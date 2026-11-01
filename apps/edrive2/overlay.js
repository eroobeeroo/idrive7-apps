'use strict';
/**
 * overlay.js - the battery's power now (kW and a small centre-zero bar) drawn over the Waze map in
 * the instrument cluster or the HUD, wherever Waze on cluster (robertn_waze_cluster) shows it.
 *
 * It follows the map: Waze on cluster writes /run/waze-on-cluster/status.json (state, target,
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

/** The map's rectangle on a target, as waze-on-cluster places it (map_feed.cpp quad, map_geometry.cpp map_quad). */
function mapRect(target, hudPct) {
    const sc = SCENES[target];
    if (!sc) return null;
    const [tw, th] = sc;
    let w, h;
    if (target === 'hud' && hudPct > 0) {
        w = Math.floor(tw * Math.min(100, hudPct) / 100);
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
function badgeRect(r, where) {
    const s = Math.max(0.62, Math.min(1, r.w / 640));
    const w = Math.round(200 * s / 4) * 4, h = Math.round(56 * s / 2) * 2, m = Math.round(10 * s);
    return { x: r.x + Math.floor((r.w - w) / 2), y: where === 'top' ? r.y + m : r.y + r.h - h - m, w, h };
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
            if (map.showing) lv.keepFast();
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
        const r = mapRect(map.target, map.pct);
        if (!r) return 0;
        const b = badgeRect(r, where());
        const key = [map.target, b.x, b.y, b.w, b.h].join(',');
        if (key === geo && ref) return ref;
        if (!client()) return 0;
        if (ref) cr.drop(ref);
        geo = key;
        visible = false;
        last = null;
        cv = new Canvas(b.w, b.h);
        ref = cr.image({ target: map.target, klass: 'overlay', z: 10, x: b.x, y: b.y, w: b.w, h: b.h, iw: b.w, ih: b.h, visible: false });
        if (!ref) warnOnce('the renderer refused a ' + b.w + 'x' + b.h + ' layer');
        else log.info('map overlay: ' + b.w + 'x' + b.h + ' at ' + b.x + ',' + b.y + ' on ' + map.target);
        return ref;
    }

    function tick() {
        if (where() === 'off' || !map.showing) return hide();
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
    const draw = si(() => { if (map.showing) { lv.keepFast(); tick(); } }, UPDATE_MS);
    watch();
    readStatus();
    process.on('exit', () => { hide(); });

    return {
        /** Whether the badge is on the map now. */
        shown: () => visible,
        /** The Waze map as status.json says: { showing, target, pct }. */
        map: () => Object.assign({}, map),
        stop() { ci(poll); ci(draw); if (watcher) watcher.close(); hide(); if (cr) cr.close(); },
        _tick: tick, _read: readStatus,
    };
}

module.exports = { startOverlay, mapRect, badgeRect, drawBadge, changed };

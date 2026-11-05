'use strict';
/**
 * overlay.js - Cluster Info's panel over the Waze map in the instrument cluster or the HUD, wherever
 * Waze on cluster (robertn_waze_cluster) shows it, or always on the HUD: the battery's power now (kW and a
 * small centre-zero bar, when an app provides it - eDrive Live does) and the values chosen (temperatures),
 * plus the turn signal arrows on the HUD.
 *
 * It follows the map: Waze on cluster writes /run/waze-on-cluster/status.json (state, target,
 * hud_width_pct) whenever that changes; while it says the map is showing, a small image layer
 * (class overlay, above the map) goes on the same target through the cluster render service
 * (cluster_render_client.js), at the bottom or top of the map's picture. Otherwise the layer is
 * hidden, and a hidden layer never asks for a slot, so the panel never shows on its own and never
 * keeps the cluster or HUD from the stock screens. With nothing to show (no power, no value: parked,
 * car asleep) it is hidden too.
 *
 * Updates go at most UPDATE_MS apart and only when what is drawn changes, as the rectangles that
 * changed, so the overlay costs the map's upload budget next to nothing.
 */
const fs = require('fs');
const path = require('path');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const STATUS = process.env.WOC_STATUS || '/run/waze-on-cluster/status.json';   // (the variable: tests)
const UPDATE_MS = 250;            // the badge redrawn at most this often (4 / s)
const POLL_MS = 1000;             // status.json read this often (and on every change it is watched for)
const GO = '#2fd27a';
const TEX = { w: 1088, h: 480 };  // the map's picture (waze-on-cluster tex_size)
const SCENES = { map: [1088, 480], panel: [1920, 720], hud: [800, 480] };
const HUD_VISIBLE_RIGHT = 680;   // the HUD shows up to x ~683 (a park's fill in the map reached it, photo on the road, G05)
const HUD_RIGHT_GAP = 4;        // HUD: the panel's gap from the right edge of what the HUD shows
const HUD_SPEED_CLEAR = 405;     // left edge limit: the speed readout ends at x ~331 and Waze's car icon at ~400 (85 % map, G05)
const HUD_SPEED_RIGHT = 420;     // the HUD's speed readout ends left of this (scene pixels), with a gap
const HUD_MAX_H = 60;             // the HUD panel's height at most (the room right of the speed limits it first)
const HUD_MAX_PCT = 85;           // the HUD map's widest (waze-on-cluster hud_width_pct)
// turn signal arrows on the HUD: small, a pair at the top middle, inside the standard map's top edge
const ARROW = { w: 30, h: 24, y: 146, left: 349, right: 421 };   // the cluster's proportions (5:4)
const INDICATOR_GREEN = '#22d046';   // the cluster's indicator green
const EXTRA_COL = 1.0;            // an extra value's column, of the panel's height (fits "188°")             // an extra value's column, of the meter's base width
const NIGHT_DIM = 0.6;            // the HUD extras at night, of their brightness by day
// the cluster's own arrow, measured over 39 flashes of a video (G05): 640 ms a flash, lit 335 of them. By the head
// unit's clock that is 638 (its clock ran ~0.3 % behind the cluster's flasher there), and the car tells the head unit
// of the stalk about 40 ms after the cluster's first flash, so the HUD starts its flashing that far in
const BLINK_ON_MS = 335, BLINK_OFF_MS = 303, BLINK_LEAD_MS = 40;
const ARROW_TICK_MS = 25;        // (the flash edges within 25 ms of the cluster's)

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

/**
 * The meter's own layout for a height h, left to right with no unused room: padding, the kW number
 * right-aligned in a column just wide enough for "-188" (the widest reading it shows), "kW", the bar,
 * padding. { w, pad, numR, unitX, bx, bw }.
 */
const measure = new Canvas(1, 1);
/** An extra value's column width for a panel h high. */
const colW = (h) => Math.round(h * EXTRA_COL);
function layout(h, bar) {
    if (bar === undefined) bar = true;
    const pad = Math.round(h * 0.2), gap = Math.round(h * 0.1);
    const numW = Math.ceil(measure.textWidth('-188', Math.round(h * 0.54), { font: 'bold', literal: true }));
    const unitW = Math.ceil(measure.textWidth('kW', Math.round(h * 0.25), { font: 'bold', literal: true }));
    const numR = pad + numW, unitX = numR + Math.round(h * 0.05), bx = unitX + unitW + gap, bw = Math.round(h * 1.05);
    // (without the bar: the kW and its unit only)
    return { w: bar ? bx + bw + pad : unitX + unitW + pad, pad, numR, unitX, bx, bw };
}

/** The badge's place and size inside the map's rectangle r: { x, y, w, h } on the target. */
function badgeRect(r, where, target, extras, hasPower) {
    if (hasPower === undefined) hasPower = true;      // true: the kW and its bar, 'number': the kW alone, false: neither
    // the HUD's size to its map's width; on the cluster 1.3 times it (72 high), read at a glance past the wheel;
    // each extra value (a temperature) adds a column EXTRA_COL times the height wide
    let s = target === 'hud' ? Math.max(0.62, Math.min(HUD_MAX_H / 56, r.w / 400)) : 1.3;   // (HUD: up to HUD_MAX_H high)
    const size = (sc) => {
        const hh = Math.round(56 * sc / 2) * 2;
        const L = layout(hh, hasPower !== 'number'), ww = (hasPower ? L.w : L.pad) + (extras || 0) * colW(hh) + (hasPower ? 0 : L.pad);
        return [hh, Math.min(Math.ceil(ww / 4) * 4, r.w & ~3)];
    };
    let [h, w] = size(s);
    // the HUD: right of the speed readout. A panel too wide to end inside the map there first moves left (under
    // the car arrow's stem, as far as HUD_SPEED_CLEAR), and only then is made smaller
    const hudRight = Math.min(r.x + r.w, HUD_VISIBLE_RIGHT);
    if (target === 'hud' && where !== 'top' && HUD_SPEED_CLEAR + w > hudRight) {
        const min = s * 0.7;
        s = Math.max(min, s * (hudRight - HUD_SPEED_CLEAR) / w);
        [h, w] = size(s);
        // (rounding to whole pixels and multiples of 4 can leave it a little too wide)
        while (HUD_SPEED_CLEAR + w > hudRight && s > min) { s = Math.max(min, s - 0.02); [h, w] = size(s); }
    }
    // on the cluster a tenth of the map in from its edge (clear of the street names at the bottom and of the
    // car's arrow in the middle); on the HUD near the edge of the map's picture, and at the bottom to the right
    // of HUD_SPEED_RIGHT: the HUD's own speed readout sits left of the middle on that row (seen on a G05)
    // (cluster: at the bottom edge, below the car's arrow in the middle of the map, which it covered higher up)
    const m = target === 'hud' ? 4 : 32;   // (HUD: its digits on the speed readout's line; cluster: clear of the dimmed edge below)
    const y = where === 'top' ? r.y + m : r.y + r.h - h - m;
    let x = r.x + Math.floor((r.w - w) / 2);
    if (target === 'hud' && where !== 'top') {
        // at the right edge of what the HUD shows (HUD_RIGHT_GAP in), away from the car arrow in the middle;
        // never left of HUD_SPEED_CLEAR (the speed readout)
        x = Math.max(HUD_SPEED_CLEAR, hudRight - HUD_RIGHT_GAP - w);
    }
    return { x, y, w, h };
}

/**
 * Draws the panel: dark rounded backdrop; with pw (the power) the kW right-aligned, "kW", then the bar (regen
 * left, use right); then the extra values, each a small label over its value. Without pw: the values alone.
 */
function drawBadge(cv, t, pw, outMax, inMax, extras, powerAt, under) {
    extras = extras || [];
    // (the thin kW bar along the bottom, setting underline, is drawn last, over the panel's lower edge)
    const bar = !!pw && pw.bar !== false;
    const W = cv.w, h = cv.h, L = layout(h, bar), pwW = pw ? Math.max(L.w, W - extras.length * colW(h)) : 0;
    cv.clear([0, 0, 0, 0]);
    cv.roundRect(0, 0, W, h, h * 0.32, [8, 9, 12, 190]);
    // the items left to right: the kW meter at its slot (powerAt among them), the values in the room left
    const n = extras.length + (pw ? 1 : 0), at = pw ? Math.min(Math.max(0, powerAt || 0), extras.length) : -1;
    const cw = extras.length ? (W - pwW - (pw ? 0 : 0)) / extras.length : 0;
    let x = 0, vi = 0;
    for (let i = 0; i < n; i++) {
        if (i === at) { drawPower(cv, t, pw, outMax, inMax, x, pwW, h, L, bar); x += pwW; continue; }
        const e = extras[vi++];
        const cx = Math.round(x + cw * (pw && i === at + 1 ? 0.42 : pw && i === at - 1 ? 0.58 : 0.5));
        cv.text(e.label, cx, Math.round(h * 0.33), Math.round(h * 0.22), t.dim, { font: 'bold', align: 'center', literal: true });
        cv.text(e.text, cx, Math.round(h * 0.84), Math.round(h * 0.5), e.col || t.text, { font: 'bold', align: 'center', literal: true });
        x += cw;
    }
    // (under: { kw } whenever the setting is on, below every slot, whether or not one of them is the kW meter)
    if (under && G.isNum(under.kw)) drawUnderline(cv, t, under.kw, outMax, inMax, W, h);
}

/**
 * The thin kW bar along the panel's bottom (setting underline): its whole width inside the rounded corners,
 * zero where the regen and use spans meet (as the bar after the kW), recuperation left of it in green, use
 * right of it in the power colours. A hairline track when nothing flows.
 */
function drawUnderline(cv, t, kw, outMax, inMax, W, h) {
    const bh = Math.max(3, Math.round(h * 0.075)), inset = Math.round(h * 0.3), y = h - bh - Math.max(2, Math.round(h * 0.05));
    const bx = inset, bw = W - 2 * inset, span = outMax + inMax, x0 = bx + bw * inMax / span;
    const X = (v) => x0 + G.clamp(v, -inMax, outMax) / span * bw;
    cv.roundRect(bx, y, bw, bh, bh / 2, withAlpha(t.track, 0.9));
    if (G.isNum(kw) && Math.abs(kw) > 0.05) {
        if (kw > 0) cv.rampRect(x0, y, X(kw) - x0, bh, bh / 2, t.hotRamp || t.ramp, x0, bx + bw - x0);
        else cv.roundRect(X(kw), y, x0 - X(kw), bh, bh / 2, GO);
    }
    cv.fillRect(Math.round(x0) - 1, y - 2, 2, bh + 4, t.text);
}

/** The kW meter in the panel at x, w wide: the kW right-aligned, "kW", then the bar (regen left, use right). */
function drawPower(cv, t, pw, outMax, inMax, x, w, h, L, bar) {
    // (the block is at least as wide as its layout; rounding up to a multiple of 4 goes to the bar)
    const base = Math.round(h * 0.69);
    cv.text(pw.text, x + L.numR, base, Math.round(h * 0.54), pw.col, { font: 'bold', align: 'right', literal: true });
    cv.text('kW', x + L.unitX, base, Math.round(h * 0.25), t.dim, { font: 'bold', literal: true });
    if (!bar) return;
    const bx = x + L.bx, bw = Math.max(L.bw, w - L.bx - L.pad), bh = Math.max(6, Math.round(h * 0.2)), by = Math.round((h - bh) / 2);
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
 * ctx: the app's (settings, log, theme); src: what to show -
 *   power(t)   { kw, text, col } or null (no app provides it now)
 *   limits()   { outMax, inMax } the bar's ends in kW
 *   extras(t)  [{ label, text, col }] the values chosen
 *   keepFast() the panel is up: providers should read fast (Cluster Info tells them)
 *   indicator() 'off' | 'left' | 'right' | 'both';  night() true after dark
 * opts (tests): statusPath, ClusterRender, now, setInterval, clearInterval.
 */
function startOverlay(ctx, lv, opts) {
    opts = opts || {};
    const { settings, log } = ctx;
    const statusPath = opts.statusPath || STATUS;
    const now = opts.now || Date.now;
    const where = () => (settings.get('show') === 'off' ? 'off' : settings.get('place') || 'bottom');
    // 'map': on the display the Waze map is on, while it shows; 'hud': on the HUD whenever there is something to show
    const onHud = () => settings.get('show') === 'hud';
    /** Where the badge goes now: { target, pct } (the map's place it sits in), null for nowhere. */
    const place = () => {
        // (the HUD size chosen in Waze on cluster, even while its map is on the cluster: the panel stays put)
        if (onHud()) return { target: 'hud', pct: map.pct };
        return map.showing ? { target: map.target, pct: map.pct } : null;
    };
    let CR = opts.ClusterRender;
    let cr = null, ref = 0, geo = '', cv = null, last = null, visible = false, lastT = 0;
    let map = { showing: false, target: null, pct: 0 }, statusText = '';
    let warned = '';
    const warnOnce = (m) => { if (m !== warned) { warned = m; log.warn('map overlay: ' + m); } };

    function readStatus() {
        fs.readFile(statusPath, 'utf8', (err, txt) => {
            if (err) { if (map.showing) log.info('map overlay: Waze on cluster status gone'); map = { showing: false, target: null, pct: map.pct };   /* (the HUD size kept) */ statusText = ''; return tick(); }
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
        cr = new CR('cluster_info');
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
    let opacity = 1;
    /* The HUD extras' opacity: the brightness setting, dimmed at night when nightDim is on. */
    const hudOpacity = () => (Number(settings.get('hudBrightness')) || 100) / 100
        * (settings.get('nightDim') !== 'off' && lv.night && lv.night() ? NIGHT_DIM : 1);
    function layer(nExtras, hasPower) {
        const pl = place();
        const r = pl && mapRect(pl.target, pl.pct);
        if (!r) return 0;
        const b = badgeRect(r, where(), pl.target, nExtras, hasPower);
        const key = [pl.target, b.x, b.y, b.w, b.h].join(',');
        if (key === geo && ref) return ref;
        if (!client()) return 0;
        if (ref) cr.drop(ref);
        geo = key;
        visible = false;
        last = null;
        cv = new Canvas(b.w, b.h);
        opacity = pl.target === 'hud' ? hudOpacity() : 1;
        ref = cr.image({ target: pl.target, klass: 'overlay', z: 10, x: b.x, y: b.y, w: b.w, h: b.h, iw: b.w, ih: b.h, visible: false, opacity });
        if (!ref) warnOnce('the renderer refused a ' + b.w + 'x' + b.h + ' layer');
        else log.info('map overlay: ' + b.w + 'x' + b.h + ' at ' + b.x + ',' + b.y + ' on ' + pl.target);
        return ref;
    }

    function tick() {
        if (where() === 'off' || !place()) return hide();
        const t = ctx.theme(), p = lv.power ? lv.power(t) : null, pw = p && G.isNum(p.kw) ? p : null;
        const tg0 = place().target, under = lv.under ? lv.under(tg0) : null;
        const extras = lv.extras ? (lv.extras(t) || []).filter((e) => e && e.text !== '--') : [];
        if (!pw && !extras.length) return hide();          // nothing to show (parked, asleep, no provider)
        // the bar after the kW (setting bar): 'on' everywhere, 'cluster' on the cluster only, 'off' nowhere
        if (pw) {
            const bs = settings.get('bar'), tg = place().target;
            pw.bar = bs === 'on' || ((bs === 'cluster' || bs === undefined) && tg !== 'hud');
        }
        if (!layer(extras.length, pw ? (pw.bar ? true : 'number') : false)) return undefined;
        const op = place().target === 'hud' ? hudOpacity() : 1;
        if (op !== opacity) { opacity = op; cr.set(ref, { opacity }); }
        const tm = now();
        if (visible && tm - lastT < UPDATE_MS - 40) return undefined;    // (the draw timer's jitter)
        lastT = tm;
        const lim = (lv.limits && lv.limits()) || {};
        const outMax = G.isNum(lim.outMax) && lim.outMax > 0 ? lim.outMax : 100, inMax = G.isNum(lim.inMax) && lim.inMax > 0 ? lim.inMax : outMax * 0.5;
        // the kW meter after the values in slots before its own (values without a reading are left out)
        const pAt = lv.powerAt ? extras.filter((e) => (e.slot || 0) < lv.powerAt()).length : 0;
        drawBadge(cv, t, pw, outMax, inMax, extras, pAt, under);
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
        if (dir !== lastDir) { blinkFrom = tm - BLINK_LEAD_MS; lastDir = dir; lastPhase = null; }
        if (!arrowLayers()) return;
        if (!arrowsShown) { ['left', 'right'].forEach((d) => cr.set(arrows[d], { visible: true, opacity: 0 })); arrowsShown = true; }
        const on = (tm - blinkFrom) % (BLINK_ON_MS + BLINK_OFF_MS) < BLINK_ON_MS;
        if (on === lastPhase) return;
        lastPhase = on;
        const lit = hudOpacity();
        ['left', 'right'].forEach((d) => cr.set(arrows[d], { opacity: on && (dir === d || dir === 'both') ? lit : 0 }));
    }
    const arrowTimer = si(arrowTick, ARROW_TICK_MS);
    process.on('exit', () => { hideArrows(); });

    return {
        /** Whether the badge is on the map now. */
        shown: () => visible,
        /** The Waze map as status.json says: { showing, target, pct }. */
        map: () => Object.assign({}, map),
        stop() { ci(poll); ci(draw); ci(arrowTimer); if (watcher) watcher.close(); hide(); hideArrows(); if (cr) cr.close(); },
        /** For the diagnostics: the renderer link and the Waze map as status.json says. */
        status: () => ({
            renderer: cr ? (cr.ready ? 'connected' : 'connecting') : 'not needed yet',
            map: map.showing ? 'showing on ' + map.target + (map.target === 'hud' ? ' (' + (map.pct || 'standard') + (map.pct ? ' %' : '') + ')' : '') : statusText ? 'not showing' : 'no Waze on cluster status',
        }),
        /** The turn signal arrows: { shown, phase } (phase true: lit). */
        arrows: () => ({ shown: arrowsShown, phase: lastPhase, refs: Object.assign({}, arrows) }),
        _arrowTick: arrowTick,
        _tick: tick, _read: readStatus,
    };
}

module.exports = { startOverlay, mapRect, badgeRect, drawBadge, drawArrow, changed };

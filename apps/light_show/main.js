'use strict';
/**
 * Light Show - flash the car's exterior lamps in patterns, through the body controller's own lamp test functions
 * (lamps.js): emergency patterns (wig-wag and others, on lamps that are normally off while driving) and light
 * show patterns (any lamp, parked).
 *
 * Pages: Light Show (the pattern, start / stop, which lamps are lit now) and Lamp check (each lamp on for a moment
 * in turn, and whether the body controller took it: the lamps that refuse are left out of every pattern).
 *
 * Safety: Stop gives every lamp back to the car and ends the diagnostic session; if the app goes away without
 * that, the body controller ends the session itself a few seconds later (no tester present) and every lamp is the
 * car's own again. "Only while parked" (setting) stops a pattern as soon as the car moves.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Diag } = require('./kit/diag');
const { LampLink, LAMPS, BY_ID, NRC, hex } = require('./lamps');
const { PATTERNS, PATTERN, Player, lampsOf } = require('./patterns');

const W = 1600, H = 520;
const AMBER = '#ffad1f', RED = '#ff3030', WHITE = '#f4f7ff', FOG = '#fff2b0', GO = '#2fd27a';
const CHECK_ON_MS = 1200, CHECK_GAP_MS = 800;

/** Where each lamp sits on the car drawing: x -1 (left) .. 1 (right), y 0 (front) .. 1 (rear); its colour. */
const SPOT = {
    lowL: [-0.62, 0.04, WHITE], lowR: [0.62, 0.04, WHITE], highL: [-0.42, 0.03, WHITE], highR: [0.42, 0.03, WHITE],
    drlL: [-0.78, 0.07, WHITE], drlR: [0.78, 0.07, WHITE], fogL: [-0.7, 0.0, FOG], fogR: [0.7, 0.0, FOG],
    indFL: [-0.88, 0.1, AMBER], indFR: [0.88, 0.1, AMBER], indSL: [-1.04, 0.24, AMBER], indSR: [1.04, 0.24, AMBER],
    indRL: [-0.84, 0.93, AMBER], indRR: [0.84, 0.93, AMBER], tailL: [-0.74, 0.97, RED], tailR: [0.74, 0.97, RED],
    brakeL: [-0.6, 0.95, RED], brakeR: [0.6, 0.95, RED], brakeM: [0, 0.82, RED], rfogL: [-0.4, 1.0, RED], rfogR: [0.4, 1.0, RED],
    revL: [-0.24, 0.98, WHITE], revR: [0.24, 0.98, WHITE], plate: [0, 1.0, WHITE],
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true; diag.busyMs = 60;
        diag.init();
        const link = new LampLink(diag, log);

        /* ---------- the lamp check's results, kept: { id: { ok, why, t } } ---------- */
        const FILE = path.join(ctx.dataDir || '.', 'lamps.json');
        let checked = {};
        try { checked = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { /* none yet */ }
        const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(checked)); } catch (e) { log.warn('light show: ' + e.message); } };
        const usable = (id) => !checked[id] || checked[id].ok !== false;

        /* ---------- parked or moving (Vehicle2 speed) ---------- */
        let speed = null;
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => { const k = v && v.speedVehicleCentreOfGravity; if (typeof k === 'number' && k !== 65535) speed = k * 0.015625; },
        }, log, { pollMs: 2000 }).catch(() => null);
        const moving = () => speed !== null && speed > 3;

        /* ---------- the player ---------- */
        let lit = new Set(), frameAt = -1, startedAt = 0, stopWhy = '';
        const player = new Player(link, {
            log, usable,
            onFrame: (l, i) => { lit = new Set(l); frameAt = i; },
            refused: (id, nrc) => {
                // refused during a pattern: left out until the next lamp check
                checked[id] = { ok: false, why: NRC[nrc] || 'NRC ' + hex(nrc), t: Date.now() }; save();
                log.warn('light show: ' + BY_ID[id].name + ' refused (' + checked[id].why + '): left out');
            },
        });
        const pattern = () => PATTERN[settings.get('pattern')] || PATTERNS[0];
        const speedK = () => Number(settings.get('speed')) || 1;
        function start() {
            if (player.running || check.running) return;
            if (settings.get('parkedOnly') && moving()) { stopWhy = 'Not started: the car is moving (Only while parked is on)'; return; }
            stopWhy = ''; startedAt = Date.now();
            log.info('light show: ' + pattern().name + ' started');
            player.start(pattern(), speedK());
        }
        async function stop(why) {
            if (!player.running) return;
            stopWhy = why || '';
            log.info('light show: stopped' + (why ? ' (' + why + ')' : ''));
            await player.stop();
        }
        settings.onChange && settings.onChange((key) => {
            if (key === 'pattern' && player.running) player.setPattern(pattern());
            if (key === 'speed' && player.running) player.speed = speedK();
        });
        // the stops that don't need a button: moving (when parked only), the time limit
        setInterval(() => {
            if (!player.running) return;
            if (settings.get('parkedOnly') && moving()) stop('the car moved (Only while parked is on)');
            const lim = Number(settings.get('autoStop')) || 0;
            if (lim && Date.now() - startedAt > lim * 60000) stop('time limit, ' + lim + ' min');
        }, 250);

        /* ---------- the lamp check: each lamp on for a moment, in turn ---------- */
        const check = { running: false, at: -1, results: {} };
        async function runCheck() {
            if (check.running || player.running) return;
            check.running = true; check.results = {};
            await link.start();
            for (let i = 0; i < LAMPS.length && check.running; i++) {
                const l = LAMPS[i];
                check.at = i; lit = new Set([l.id]);
                let r = await link.set(l.id, true), how = 'own output';
                if (!r.ok && r.nrc !== null) {
                    // the output refused: its lamp function (both sides at once, for a time) instead
                    const fr = await link.fn(l.id, CHECK_ON_MS);
                    if (fr.ok) { r = fr; how = 'function only (both sides)'; }
                }
                check.results[l.id] = r;
                await new Promise((res) => setTimeout(res, CHECK_ON_MS));
                if (how === 'own output') await link.set(l.id, false, 'release');
                lit = new Set();
                checked[l.id] = r.ok && how === 'own output' ? { ok: true, t: Date.now(), ms: r.ms }
                    : { ok: false, why: r.ok ? how : r.nrc !== null ? NRC[r.nrc] || 'NRC ' + hex(r.nrc) : 'no answer', t: Date.now() };
                log.info('lamp check: ' + l.name + ' (' + hex(l.out) + '): ' + (checked[l.id].ok ? 'works, ' + r.ms + ' ms' : checked[l.id].why));
                await new Promise((res) => setTimeout(res, CHECK_GAP_MS));
            }
            save();
            await link.stop();
            check.running = false; check.at = -1;
        }

        /* ---------- pages ---------- */
        const PAGES = ['Light Show', 'Lamp check'];
        let page = 0;
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ui.onClick('BTN_RUN', () => {
            if (page === 1) { if (check.running) check.running = false; else runCheck(); }
            else if (player.running) stop('stopped'); else start();
            return render();
        });
        ui.onClick('BTN_PATTERN', () => {
            const i = PATTERNS.indexOf(pattern());
            settings.set('pattern', PATTERNS[(i + 1) % PATTERNS.length].id);
            if (player.running) player.setPattern(pattern());
            return render();
        });
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });

        /** The car from above, front at the top, each lamp a dot (lit: bright and haloed). */
        function car(cv, t, cx, y0, w, h, on, mark) {
            cv.roundRect(cx - w / 2, y0, w, h, w * 0.22, withAlpha('#ffffff', 0.06));
            cv.strokeRoundRect(cx - w / 2, y0, w, h, w * 0.22, 2, withAlpha('#ffffff', 0.25));
            cv.roundRect(cx - w * 0.36, y0 + h * 0.22, w * 0.72, h * 0.16, 10, withAlpha('#ffffff', 0.08));     // windscreen
            cv.roundRect(cx - w * 0.34, y0 + h * 0.74, w * 0.68, h * 0.1, 10, withAlpha('#ffffff', 0.08));      // rear window
            cv.text('FRONT', cx, y0 - 10, 14, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            LAMPS.forEach((l) => {
                const [sx, sy, col] = SPOT[l.id], x = cx + sx * w / 2, y = y0 + sy * h;
                const bad = checked[l.id] && checked[l.id].ok === false;
                if (on.has(l.id)) { cv.circle(x, y, 20, withAlpha(col, 0.25)); cv.circle(x, y, 11, col); }
                else cv.circle(x, y, 7, bad ? withAlpha(t.dim, 0.35) : withAlpha(col, 0.35));
                if (mark === l.id) cv.strokeRoundRect(x - 16, y - 16, 32, 32, 8, 2, t.text);
            });
        }

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const p = pattern();
            const stats = link.stats;
            const linkLine = 'Body controller: ' + (link.active ? 'session ' + (link.session || '...') : 'idle') + '   ·   '
                + stats.ok + ' ok, ' + stats.refused + ' refused, ' + stats.missed + ' unanswered' + (stats.ms ? '   ·   ' + Math.round(stats.ms) + ' ms a request' : '')
                + (diag.available ? '' : '   ·   diagnostic link not available');
            if (page === 0) {
                G.panel(cv, t, 24, 44, 1040, 468, 'Pattern');
                cv.text(p.name, 56, 140, 52, t.text, { font: 'bold' });
                cv.text(p.what, 56, 184, 22, t.dim, { literal: true });
                const kind = p.kind === 'emergency' ? 'EMERGENCY  ·  the car keeps its low beams, tail and brake lights' : 'LIGHT SHOW  ·  takes over any lamp: parked';
                cv.text(kind, 56, 222, 18, p.kind === 'emergency' ? AMBER : t.dim, { font: 'bold', spacing: 1 });
                const run = player.running;
                cv.roundRect(56, 252, 300, 70, 14, run ? withAlpha(RED, 0.85) : withAlpha(GO, 0.85));
                cv.text(run ? 'RUNNING' : 'STOPPED', 206, 298, 30, '#ffffff', { align: 'center', font: 'bold', spacing: 2 });
                cv.text(run ? 'Start / stop button: stop. Every lamp goes back to the car.' : 'Start / stop button: start.  Next pattern: ' + PATTERNS[(PATTERNS.indexOf(p) + 1) % PATTERNS.length].name,
                    380, 296, 20, t.text, { literal: true });
                const missing = lampsOf(p).filter((id) => !usable(id)).map((id) => BY_ID[id].name);
                const lines = [
                    'Speed x' + speedK() + '   ·   ' + (settings.get('parkedOnly') ? 'only while parked' : 'also while driving') + '   ·   '
                        + (Number(settings.get('autoStop')) ? 'stops after ' + settings.get('autoStop') + ' min' : 'no time limit')
                        + (run ? '   ·   running ' + Math.round((Date.now() - startedAt) / 1000) + ' s' + (player.late ? ', link too slow ' + player.late + 'x' : '') : ''),
                    missing.length ? 'Left out (refused in the lamp check): ' + missing.join(', ') : Object.keys(checked).length ? 'Every lamp of this pattern passed the lamp check' : 'Lamp check not run yet: see the Lamp check page',
                    stopWhy || player.error || (link.noRelease ? 'This body controller holds lamps dark between flashes (no single release)' : ''),
                    linkLine,
                ];
                lines.forEach((s, i) => cv.text(s, 56, 370 + i * 34, 18, i === 2 && (stopWhy || player.error) ? t.warn : t.dim, { literal: true }));
                G.panel(cv, t, 1088, 44, 488, 468, 'Lamps now');
                car(cv, t, 1332, 104, 250, 380, lit, null);
            } else {
                G.panel(cv, t, 24, 44, 1040, 468, 'Lamp check');
                const cur = check.at >= 0 ? LAMPS[check.at] : null;
                cv.text(check.running ? (cur ? cur.name : 'Starting...') : 'Each lamp on for a moment, in turn', 56, 130, 40, t.text, { font: 'bold', literal: true });
                cv.text(check.running ? (check.at + 1) + ' of ' + LAMPS.length + '   ·   Start / stop button: stop the check'
                    : 'Start / stop button: run it (about ' + Math.round(LAMPS.length * (CHECK_ON_MS + CHECK_GAP_MS) / 1000) + ' s). Watch or film the car: the order is the list below.', 56, 170, 20, t.dim, { literal: true });
                // the list in three columns: tick (took it), cross (refused, why), dot (not checked)
                LAMPS.forEach((l, i) => {
                    const col = Math.floor(i / 8), row = i % 8, x = 56 + col * 336, y = 222 + row * 34;
                    const c = checked[l.id], now = check.running && check.at === i;
                    const mark = now ? '>' : !c ? '·' : c.ok ? '✓' : '✗';
                    cv.text(mark, x, y, 20, now ? t.text : !c ? t.dim : c.ok ? GO : t.warn, { font: 'bold', literal: true });
                    cv.text((i + 1) + '. ' + l.name, x + 26, y, 17, now ? t.text : t.dim, { literal: true });
                    if (c && !c.ok) cv.text(c.why, x + 26, y + 15, 12, t.warn, { literal: true });
                });
                cv.text(linkLine, 56, 496, 16, t.dim, { literal: true });
                G.panel(cv, t, 1088, 44, 488, 468, 'Now on');
                car(cv, t, 1332, 104, 250, 380, lit, cur && cur.id);
            }
            G.frame(cv, t, PAGES, page, []);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 8, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
        process.on('exit', () => { if (player.running || check.running) log.warn('light show: closing while running: the body controller gives the lamps back in a few seconds'); });
        return { player, link, check, stop, start, runCheck, pages: () => page };
    },
});

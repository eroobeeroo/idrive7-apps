'use strict';

// Light Show (apps/light_show) against a simulated body controller: only its own requests ever leave, the
// emergency patterns never touch lamps the car keeps on while driving, Stop gives every lamp back and ends the
// session, the lamp check falls back to lamp functions and leaves refused lamps out, "only while parked" stops it.
//   node kit/tools/test_light_show.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'light_show');
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const themes = require(path.join(KIT, 'themes'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));

let passed = 0;
function check(name, fn) { try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }

/* the body controller: answers like the SGBD says, with knobs for refusals */
const sent = [];
// like the G05's: an output request with the control parameter (03) is the wrong length, without it it's taken
// (wantSta: a unit the other way round)
const bdc = { refuseOut: new Set(), noRelease: false, session: 0x01, wantSta: false };
function answer(target, sid, data) {
    if (target !== 0x40) return null;
    const d = data;
    if (sid === 0x10) { bdc.session = d[0]; return [0x50, d[0], 0x00, 0x32, 0x01, 0xF4]; }
    if (sid === 0x3E) return [0x7E, 0x00];
    if (sid === 0x2F) {
        if (d[2] === 0x00) return bdc.noRelease ? [0x7F, 0x2F, 0x31] : bdc.session === 0x03 ? [0x6F].concat(d) : [0x7F, 0x2F, 0x7F];
        const sta = d.length === 5 && d[2] === 0x03;
        if (sta !== bdc.wantSta) return [0x7F, 0x2F, 0x13];
        const out = sta ? d[3] : d[2];
        if (bdc.refuseOut.has(out)) return [0x7F, 0x2F, 0x31];
        if (bdc.session !== 0x03) return [0x7F, 0x2F, 0x7F];
        return [0x6F].concat(d);
    }
    if (sid === 0x2E) return [0x6E, d[0], d[1]];
    return [0x7F, sid, 0x11];
}
class FakeDiag extends EventEmitter {
    constructor() { super(); this.available = true; }
    init() {}
    async physical(target, sid, data, timeoutMs, accept) {
        sent.push([target, sid].concat(data));
        const u = answer(target, sid, data);
        await new Promise((r) => setImmediate(r));
        return u && (!accept || accept(u)) ? u : null;
    }
}
const stubs = { './kit/mgu': { run(a) { stubs.app = a; } }, './kit/diag': { Diag: FakeDiag } };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const hexs = (b) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const L = require(path.join(APP, 'lamps.js'));
    const P = require(path.join(APP, 'patterns.js'));

    check('only its own requests: other services, identifiers and units are refused before sending', () => {
        const no = [[0x40, [0x2E, 0xF1, 0x90, 1]], [0x40, [0x31, 0x01, 0xA5, 0x33]], [0x40, [0x2F, 0x60, 0xFD, 0x03, 0x10]], [0x40, [0x2F, 0xE3, 0xB5, 0x03, 0x26, 0x01]],
            [0x40, [0x2F, 0xE3, 0xB5, 0x03, 0x01, 0x05]], [0x40, [0x14, 0xFF, 0xFF, 0xFF]], [0x40, [0x10, 0x02]], [0x40, [0x11, 0x01]], [0x12, [0x2F, 0xE3, 0xB5, 0x03, 0x07, 0x01]],
            [0x40, [0x2E, 0xD5, 0x42, 0x00, 0x1D, 0, 10]]];
        no.forEach(([t, b]) => assert.throws(() => L.check(t, b), /not allowed|only the body/, hexs(b)));
        L.LAMPS.forEach((l) => { L.check(0x40, L.req.on(l)); L.check(0x40, L.req.off(l)); L.check(0x40, L.req.release(l)); });
        L.check(0x40, L.req.fn(0x05, 300));
    });
    check('requests as the SGBD describes them: 2F E3B5 <output> 01 (or with 03), 2F E3B5 00 <output>, 2E D542 <function> <10 ms>', () => {
        assert.strictEqual(hexs(L.req.on(L.BY_ID.highL)), '2F E3 B5 07 01');
        assert.strictEqual(hexs(L.req.on(L.BY_ID.highL, 'sta')), '2F E3 B5 03 07 01');
        assert.strictEqual(hexs(L.req.release(L.BY_ID.highR)), '2F E3 B5 00 08');
        assert.strictEqual(hexs(L.req.fn(0x05, 300)), '2E D5 42 00 05 00 1E');
    });
    check('emergency patterns never take over low beams, daytime, tail, plate or brake lights', () => {
        P.PATTERNS.filter((p) => p.kind === 'emergency').forEach((p) => assert(P.safeForDriving(p), p.id));
        assert(P.PATTERNS.every((p) => P.lampsOf(p).every((id) => L.BY_ID[id])), 'every lamp a pattern names exists');
        const ids = P.PATTERNS.map((p) => p.id), opts = SPEC.settings.find((s) => s.key === 'pattern').options.map((o) => o[0]);
        assert.deepStrictEqual(opts, ids, 'the pattern setting lists every pattern');
    });

    /* ---------- the app ---------- */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-show-'));
    const S = {}; SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    const loops = {}, clicks = {}, warns = [], listeners = [];
    let speedCb = null;
    const ctx = {
        app: {}, ui: { onClick: (id, fn) => { clicks[id] = fn; }, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f), display: (k) => String(S[k]) },
        log: { info() {}, warn: (m) => warns.push(m), error: (m, e) => warns.push(m + ' ' + e) },
        spec: SPEC, dataDir: dir,
        signals: { watch: (iface, inst, h) => { if (h.statusCarSpeed2) speedCb = h.statusCarSpeed2; return Promise.resolve({}); } },
        onTab() {}, loop: (name, fps, fn) => { loops[name] = fn; },
        theme: () => themes.theme('m_tricolour'), canvas: (w, h) => new Canvas(w, h),
    };
    require(path.join(APP, 'main.js'));
    const app = await stubs.app.start(ctx);
    await loops.MAIN(); await clicks.BTN_PAGE(); await loops.MAIN(); await clicks.BTN_PAGE();
    check('both pages draw without errors', () => assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | ')));

    // wig-wag for a moment
    sent.length = 0;
    await clicks.BTN_RUN();
    await sleep(900);
    await loops.MAIN();
    const during = sent.map((s) => hexs(s.slice(1)));
    check('start: the extended session first, then the high beams in turn, each given back between flashes', () => {
        assert.strictEqual(during[0], '10 03');
        assert(during.indexOf('2F E3 B5 07 01') > 0 && during.indexOf('2F E3 B5 08 01') > 0, during.join(' | '));
        assert(during.indexOf('2F E3 B5 00 07') > during.indexOf('2F E3 B5 07 01'), 'left given back after its flash');
        assert(sent.every((s) => s[0] === 0x40), 'only the body controller');
        assert(!during.some((s) => /^2F E3 B5 (03 )?(01|02|03|04|14|15|18|19|22|23) 0[01]$/.test(s)), 'no lamp the car keeps on');
    });
    sent.length = 0;
    await clicks.BTN_RUN();            // stop
    await sleep(50);
    const after = sent.map((s) => hexs(s.slice(1)));
    check('stop: every lamp given back, then the default session', () => {
        assert.strictEqual(after[after.length - 1], '10 01', after.join(' | '));
        assert(!app.player.running && app.link.held.size === 0 && !app.link.active);
    });

    // a unit that gives no single lamp back: lamps held dark between flashes, the session's end gives them back
    bdc.noRelease = true; sent.length = 0;
    await clicks.BTN_RUN(); await sleep(900); await clicks.BTN_RUN(); await sleep(50);
    const held = sent.map((s) => hexs(s.slice(1)));
    check('no single release: high beams held dark between flashes instead, session ended at stop', () => {
        assert(app.link.noRelease && held.indexOf('2F E3 B5 07 00') === held.indexOf('2F E3 B5 00 07') + 1, held.join(' | '));
        assert(held.indexOf('2F E3 B5 07 00') < held.indexOf('2F E3 B5 08 01'), 'dark before the other side lights');
        assert.strictEqual(held[held.length - 1], '10 01');
    });
    bdc.noRelease = false; app.link.noRelease = false;

    // a unit that wants the control parameter: found from the "wrong length" refusal, then used
    bdc.wantSta = true; app.link.outForm = null; sent.length = 0;
    await clicks.BTN_RUN(); await sleep(900); await clicks.BTN_RUN(); await sleep(50);
    const sta = sent.map((s) => hexs(s.slice(1)));
    check('the other layout when the first is the wrong length, kept after that', () => {
        assert(app.link.outForm === 'sta' && sta.indexOf('2F E3 B5 03 08 01') > 0, sta.join(' | '));
        assert.strictEqual(sta.filter((x) => x === '2F E3 B5 07 01').length, 1, 'the plain layout tried once');
    });
    bdc.wantSta = false; app.link.outForm = null;

    // only while parked
    S.parkedOnly = true;
    speedCb({ speedVehicleCentreOfGravity: 40 / 0.015625 });
    await clicks.BTN_RUN();
    check('only while parked, moving: not started', () => assert(!app.player.running));
    speedCb({ speedVehicleCentreOfGravity: 0 });
    await clicks.BTN_RUN(); await sleep(300);
    speedCb({ speedVehicleCentreOfGravity: 20 / 0.015625 });
    await sleep(600);
    check('only while parked: stops as the car moves', () => assert(!app.player.running && !app.link.active));
    S.parkedOnly = false; speedCb({ speedVehicleCentreOfGravity: 0 });

    // the lamp check (its waits made short), with the low beam output refused: its lamp function answers instead
    const realST = global.setTimeout;
    global.setTimeout = (fn, ms, ...a) => realST(fn, ms >= 500 ? 1 : ms, ...a);
    bdc.refuseOut.add(0x01); bdc.refuseOut.add(0x0D);
    await clicks.BTN_PAGE();
    await clicks.BTN_RUN();
    for (let i = 0; i < 200 && app.check.running; i++) await new Promise((r) => realST(r, 5));
    global.setTimeout = realST;
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'lamp-check.json'), 'utf8'));
    check('lamp check: every lamp tried; a refused output tried as its function, and left out of patterns', () => {
        assert(!app.check.running && Object.keys(saved).length === L.LAMPS.length, Object.keys(saved).length + ' lamps');
        assert(saved.lowL.ok === false && /function only/.test(saved.lowL.why) && saved.highL.ok === true, JSON.stringify(saved.lowL));
        assert(sent.some((s) => hexs(s.slice(1)) === '2E D5 42 00 03 00 78'), 'low beam function for 1.2 s');
    });
    // the front left turn signal's output refused, its (left-only) function works: the corner strobe uses it
    check('a side\'s own lamp function stands in for a refused output (turn signals only)', () => assert(saved.indFL.ok === false && saved.indFL.fn === true && saved.lowL.fn === true));
    S.pattern = 'corners'; sent.length = 0;
    await clicks.BTN_PAGE();
    await clicks.BTN_RUN(); await sleep(700); await clicks.BTN_RUN(); await sleep(50);
    const corners = sent.map((s) => hexs(s.slice(1)));
    check('corner strobe: the left turn signal by its function, the right by its output; the low beams never', () => {
        assert(corners.some((x) => /^2E D5 42 00 06 /.test(x)) && corners.indexOf('2F E3 B5 21 01') > 0, corners.join(' | '));
        assert(!corners.some((x) => /^2E D5 42 00 03 /.test(x)) && !corners.includes('2F E3 B5 0D 01'));
    });
    S.pattern = 'wigwag';
    await loops.MAIN();
    check('the check page draws with results', () => assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | ')));

    console.log(passed + ' checks passed');
    process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });

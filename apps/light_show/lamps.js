'use strict';
/**
 * lamps.js - the car's exterior lamps, one by one, through BMW's own test functions, as the SGBDs for the G05's
 * body controller (BDC_G05, address 0x40) and its LED headlight modules (FLM02_L / FLM02_R, 0x43 / 0x44) describe
 * them:
 *
 *   body controller, LICHT_AUSGANG_DIGITAL_STEUERN: 0x2F (I/O control) on 0xE3B5, one lamp output at a time
 *   (TAB_LEUCHTEN_AUSGANG_DIGITAL_ARG: every lamp, each side its own). The SGBD names the arguments (output, on /
 *   off) but not the request's exact layout, and the G05 refused the two obvious ones (2F E3 B5 <output> 01: "out
 *   of range"; 2F E3 B5 03 <output> 01: "wrong length"), so the link tries the LAYOUTS below on one lamp and keeps
 *   the first the unit takes. Back to the car: 2F E3 B5 00 <output> (return control to the ECU), or 2F E3 B5 00.
 *
 *   headlight modules, FLM_FUNKTION_LICHTVERTEILUNG: 0x2E on 0xD6DC, a light function in THAT headlight for a
 *   time: 2E D6 DC <function, 2 bytes> <seconds> (TAB_LF_LV_FRONT_ARG). One module a side, so the front lamps
 *   can be split left / right this way when the body controller's outputs refuse. Off: the same with 0 seconds.
 *
 *   body controller, LEUCHTEN_FUNKTION: 0x2E on 0xD542, a lamp function for a time (both sides at once, except the
 *   turn signals): 2E D5 42 <function, 2 bytes> <time, 10 ms>. The lamp check's last try.
 *
 * Every unit used gets the extended session (10 03), kept with tester present (3E 00) every 2 s. If the app stops
 * talking the units drop back to their default session within a few seconds and every lamp is the car's own again.
 * Only these requests are ever built: check() refuses anything else before it reaches the transport.
 */
const BDC = 0x40, FLM_L = 0x43, FLM_R = 0x44;
const OUT_DID = [0xE3, 0xB5], FN_DID = [0xD5, 0x42], LV_DID = [0xD6, 0xDC];
const TP_MS = 2000;                       // tester present (the session ends after ~5 s without)

/** The lamps. out: body controller output; flm: { ecu, lv } its headlight module's light function; side: which
 *  side; usual: what the lamp normally is while driving at night ('on' / 'brake': the emergency patterns never take
 *  it over). */
const HIGH = 0x45, LOW = 0x05, DRL = 0x33, BLINK = 0x49;     // Fernlichtblinken, Abblendlicht LV5, Tagfahrlicht, Blinken
const LAMPS = [
    { id: 'lowL', out: 0x01, flm: { ecu: FLM_L, lv: LOW }, name: 'Low beam left', end: 'front', side: 'L', usual: 'on' },
    { id: 'lowR', out: 0x02, flm: { ecu: FLM_R, lv: LOW }, name: 'Low beam right', end: 'front', side: 'R', usual: 'on' },
    { id: 'highL', out: 0x07, flm: { ecu: FLM_L, lv: HIGH }, name: 'High beam left', end: 'front', side: 'L' },
    { id: 'highR', out: 0x08, flm: { ecu: FLM_R, lv: HIGH }, name: 'High beam right', end: 'front', side: 'R' },
    { id: 'drlL', out: 0x03, flm: { ecu: FLM_L, lv: DRL }, name: 'Daytime light left', end: 'front', side: 'L', usual: 'on' },
    { id: 'drlR', out: 0x04, flm: { ecu: FLM_R, lv: DRL }, name: 'Daytime light right', end: 'front', side: 'R', usual: 'on' },
    { id: 'fogL', out: 0x0B, name: 'Fog light left', end: 'front', side: 'L' },
    { id: 'fogR', out: 0x0C, name: 'Fog light right', end: 'front', side: 'R' },
    { id: 'indFL', out: 0x0D, flm: { ecu: FLM_L, lv: BLINK }, name: 'Turn signal front left', end: 'front', side: 'L' },
    { id: 'indFR', out: 0x0E, flm: { ecu: FLM_R, lv: BLINK }, name: 'Turn signal front right', end: 'front', side: 'R' },
    { id: 'indSL', out: 0x10, name: 'Side repeater left', end: 'side', side: 'L' },
    { id: 'indSR', out: 0x11, name: 'Side repeater right', end: 'side', side: 'R' },
    { id: 'indRL', out: 0x20, name: 'Turn signal rear left', end: 'rear', side: 'L' },
    { id: 'indRR', out: 0x21, name: 'Turn signal rear right', end: 'rear', side: 'R' },
    { id: 'tailL', out: 0x14, name: 'Tail light left', end: 'rear', side: 'L', usual: 'on' },
    { id: 'tailR', out: 0x15, name: 'Tail light right', end: 'rear', side: 'R', usual: 'on' },
    { id: 'brakeL', out: 0x18, name: 'Brake light left', end: 'rear', side: 'L', usual: 'brake' },
    { id: 'brakeR', out: 0x19, name: 'Brake light right', end: 'rear', side: 'R', usual: 'brake' },
    { id: 'brakeM', out: 0x23, name: 'Third brake light', end: 'rear', side: 'M', usual: 'brake' },
    { id: 'rfogL', out: 0x1C, name: 'Rear fog light left', end: 'rear', side: 'L' },
    { id: 'rfogR', out: 0x1D, name: 'Rear fog light right', end: 'rear', side: 'R' },
    { id: 'revL', out: 0x1E, name: 'Reversing light left', end: 'rear', side: 'L' },
    { id: 'revR', out: 0x1F, name: 'Reversing light right', end: 'rear', side: 'R' },
    { id: 'plate', out: 0x22, name: 'Number plate light', end: 'rear', side: 'M', usual: 'on' },
];
const BY_ID = {};
LAMPS.forEach((l) => { BY_ID[l.id] = l; });
const LVS = [HIGH, LOW, DRL, BLINK];

/** Lamp functions (TAB_LEUCHTEN_FUNKTION_ARG) for 0xD542. */
const FN = { lowL: 0x03, lowR: 0x03, highL: 0x05, highR: 0x05, drlL: 0x04, drlR: 0x04, fogL: 0x08, fogR: 0x08,
    indFL: 0x06, indSL: 0x06, indRL: 0x06, indFR: 0x07, indSR: 0x07, indRR: 0x07, brakeL: 0x0C, brakeR: 0x0C, brakeM: 0x0C,
    rfogL: 0x0E, rfogR: 0x0E, revL: 0x0F, revR: 0x0F };

/** The body controller output request's layouts tried, in order (after 2F E3 B5; E output, A 01 on / 00 off). */
const LAYOUTS = [
    { id: 'E A', b: ['E', 'A'] },
    { id: '03 E A', b: [0x03, 'E', 'A'] },
    { id: '03 E A 00', b: [0x03, 'E', 'A', 0x00] },
    { id: '03 00 E A', b: [0x03, 0x00, 'E', 'A'] },
    { id: '03 E A FF', b: [0x03, 'E', 'A', 0xFF] },
    { id: '03 E A 00 00', b: [0x03, 'E', 'A', 0x00, 0x00] },
    { id: '03 E', b: [0x03, 'E'] },
];
const LAYOUT = {};
LAYOUTS.forEach((x) => { LAYOUT[x.id] = x; });
const PROBE_LAMP = 'indRL';               // a lamp every car has, harmless to flash: the layout probe's

const NRC = { 0x10: 'refused', 0x11: 'not supported', 0x12: 'not supported', 0x13: 'wrong length', 0x22: 'conditions not correct',
    0x31: 'out of range', 0x33: 'locked (security access)', 0x7E: 'not in this session', 0x7F: 'not in this session' };
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const why = (r) => (r.ok ? 'ok' : r.nrc !== null ? NRC[r.nrc] || 'NRC ' + hex(r.nrc) : 'no answer');

const fill = (lay, l, a) => lay.b.map((x) => (x === 'E' ? l.out : x === 'A' ? a : x));
const req = {
    out: (l, lay, on) => [0x2F].concat(OUT_DID, fill(lay, l, on ? 1 : 0)),
    release: (l) => [0x2F].concat(OUT_DID, [0x00, l.out]),
    releaseShort: () => [0x2F].concat(OUT_DID, [0x00]),
    lv: (lv, s) => [0x2E].concat(LV_DID, [0x00, lv, s]),
    fn: (fn, ms) => { const t = Math.max(1, Math.min(32700, Math.round(ms / 10))); return [0x2E].concat(FN_DID, [0x00, fn, t >> 8, t & 0xFF]); },
    session: (s) => [0x10, s],
    tp: () => [0x3E, 0x00],
};

/** Throws unless the request is one of the above, to the unit it belongs to. */
function check(target, bytes) {
    const bad = () => new Error('light show: request not allowed: ' + hex(target) + ': ' + bytes.map(hex).join(' '));
    if ([BDC, FLM_L, FLM_R].indexOf(target) < 0) throw new Error('light show: only the body controller and the headlight modules');
    const [sid, a] = bytes, key = bytes.map(hex).join(' ');
    if (sid === 0x10 && bytes.length === 2 && (a === 0x01 || a === 0x03)) return;
    if (sid === 0x3E && bytes.length === 2 && a === 0x00) return;
    if (target === BDC) {
        const ok = LAMPS.some((l) => [req.release(l), req.releaseShort()].concat(...LAYOUTS.map((lay) => [req.out(l, lay, true), req.out(l, lay, false)]))
            .some((r) => r.map(hex).join(' ') === key))
            || Object.values(FN).some((f) => req.fn(f, 10).slice(0, 5).map(hex).join(' ') === bytes.slice(0, 5).map(hex).join(' ') && bytes.length === 7);
        if (ok) return;
        throw bad();
    }
    if (sid === 0x2E && bytes.length === 6 && bytes[1] === LV_DID[0] && bytes[2] === LV_DID[1] && bytes[3] === 0x00 && LVS.indexOf(bytes[4]) >= 0 && bytes[5] <= 2) return;
    throw bad();
}

/**
 * The link to the lamps: one request at a time, the sessions kept, every lamp it took over given back.
 *   const link = new LampLink(diag, log);
 *   await link.start();                  // the body controller's extended session (tester present)
 *   await link.probe();                  // the output request's layout, once: link.layout (null: none taken)
 *   link.how[id] = 'out' | 'flm';        // how a lamp is switched (the lamp check finds it; default 'out')
 *   await link.set('highL', true, 0, ms);  await link.set('highL', false, 'release' | 'off');
 *   await link.stop();                   // every lamp back to the car, default sessions
 */
class LampLink {
    constructor(diag, log, opts) {
        this.diag = diag; this.log = log; this.opts = opts || {};
        this.held = new Set();            // lamps taken over and not given back
        this.active = false; this.session = null; this.releaseForm = 'long'; this.noRelease = false;
        this.layout = null; this.probed = null;   // the layout taken; the probe's results [{ id, why }]
        this.how = {};
        this.sessions = new Set();        // units in the extended session
        this.stats = { sent: 0, ok: 0, refused: 0, missed: 0, ms: 0, last: null };
        this.queue = Promise.resolve(); this.tp = null; this.lastSent = {};
    }
    /** one request, in turn; resolves with { ok, nrc, ms, reply } */
    request(target, bytes) {
        check(target, bytes);
        const run = async () => {
            const t0 = Date.now(), sid = bytes[0], data = bytes.slice(1);
            const echo = data.slice(0, sid === 0x2F || sid === 0x2E ? 2 : 1);
            const accept = (u) => (u[0] === sid + 0x40 && echo.every((x, i) => u[i + 1] === x)) || (u[0] === 0x7F && u[1] === sid);
            this.stats.sent++; this.lastSent[target] = t0;
            let u = null;
            try { u = await this.diag.physical(target, sid, data, this.opts.timeoutMs || 800, accept, { maxRetries: 1, retryBaseMs: 60, pendingTimeoutMs: 1000, callTimeoutMs: 1500 }); }
            catch (e) { this.stats.last = String(e.message || e); }
            const ms = Date.now() - t0;
            this.stats.ms = this.stats.ms ? this.stats.ms * 0.8 + ms * 0.2 : ms;
            if (!u) { this.stats.missed++; return { ok: false, nrc: null, ms, reply: null }; }
            if (u[0] === 0x7F) { this.stats.refused++; this.stats.last = hex(target) + ' ' + bytes.slice(0, 3).map(hex).join(' ') + ': ' + (NRC[u[2]] || 'NRC ' + hex(u[2])); return { ok: false, nrc: u[2], ms, reply: u }; }
            this.stats.ok++;
            return { ok: true, nrc: null, ms, reply: u };
        };
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => null);
        return p;
    }
    /** a unit into the extended session (once), kept there by tester present */
    async enter(target) {
        if (this.sessions.has(target)) return true;
        const r = await this.request(target, req.session(0x03));
        this.sessions.add(target);                // (tried: not again, whatever the answer)
        if (target === BDC) this.session = r.ok ? 'extended' : 'default (' + why(r) + ')';
        this.log.info('light show: ' + hex(target) + ' session ' + (r.ok ? 'extended' : why(r)));
        return r.ok;
    }
    async start() {
        if (this.active) return true;
        this.active = true;
        clearInterval(this.tp);
        this.tp = setInterval(() => {
            if (!this.active) return;
            this.sessions.forEach((t) => { if (Date.now() - (this.lastSent[t] || 0) > TP_MS * 0.75) this.request(t, req.tp()); });
        }, TP_MS / 2);
        return this.enter(BDC);
    }
    /** finds the output request's layout the body controller takes (on the rear left turn signal, a moment each) */
    async probe() {
        if (this.probed) return this.layout;
        const l = BY_ID[PROBE_LAMP];
        this.probed = [];
        for (const lay of (this.layout ? [this.layout] : LAYOUTS)) {
            const r = await this.request(BDC, req.out(l, lay, true));
            this.probed.push({ id: lay.id, why: why(r) });
            if (r.ok) {
                this.layout = lay;
                await new Promise((res) => setTimeout(res, 300));
                await this.request(BDC, req.out(l, lay, false));
                await this.release(PROBE_LAMP);
                break;
            }
        }
        this.log.info('light show: output layouts ' + this.probed.map((p) => p.id + ': ' + p.why).join(', '));
        if (!this.layout) this.log.warn('light show: the body controller took no output layout');
        return this.layout;
    }
    /** on = true / false; off as 'release' (the car's own again) or 'off' (held dark). ms: how long the frame is
     *  (a headlight module's function is set for whole seconds: 1, or 2 for a long frame). */
    async set(id, on, offAs, ms) {
        const l = BY_ID[id];
        if (!l) return { ok: false, nrc: null, ms: 0 };
        if (this.how[id] === 'flm' && l.flm) {
            await this.enter(l.flm.ecu);
            const r = await this.request(l.flm.ecu, req.lv(l.flm.lv, on ? (ms > 900 ? 2 : 1) : 0));
            if (r.ok) { if (on) this.held.add(id); else this.held.delete(id); }
            return r;
        }
        if (!this.layout) return { ok: false, nrc: null, ms: 0, why: 'no output layout' };
        if (on || offAs === 'off') {
            const r = await this.request(BDC, req.out(l, this.layout, on));
            if (r.ok) this.held.add(id);
            return r;
        }
        return this.release(id);
    }
    async release(id) {
        const l = BY_ID[id];
        if (this.how[id] === 'flm') return this.set(id, false);
        let r = await this.request(BDC, this.releaseForm === 'short' ? req.releaseShort() : req.release(l));
        // (some units take the release without the output)
        if (!r.ok && r.nrc === 0x13 && this.releaseForm === 'long') { this.releaseForm = 'short'; r = await this.request(BDC, req.releaseShort()); }
        if (r.ok) { if (this.releaseForm === 'short') this.held.clear(); else this.held.delete(id); this.noRelease = false; }
        else if (r.nrc !== null && !this.noRelease) {
            // the unit doesn't give single lamps back: from now on lamps that are normally off are held dark
            // between flashes, and the others left alone (the session's end gives everything back)
            this.noRelease = true;
            this.log.warn('light show: ' + l.name + ' not given back (' + why(r) + '): lamps are held dark between flashes');
        }
        // a lamp that is normally off goes dark now (one the car keeps on stays as it is until the session ends)
        if (!r.ok && r.nrc !== null && !l.usual && this.layout) { const o = await this.request(BDC, req.out(l, this.layout, false)); if (o.ok) this.held.add(id); }
        return r;
    }
    /** a body controller lamp function for ms (both sides, except the turn signals), then the car's own again */
    fn(id, ms) { return FN[id] ? this.request(BDC, req.fn(FN[id], ms)) : Promise.resolve({ ok: false, nrc: null, ms: 0 }); }
    /** every lamp back to the car, then the default sessions (which give back anything left) */
    async stop() {
        if (!this.active) return;
        for (const id of Array.from(this.held)) await this.release(id);
        clearInterval(this.tp); this.tp = null;
        for (const t of Array.from(this.sessions)) await this.request(t, req.session(0x01));
        this.sessions.clear();
        this.held.clear();
        this.active = false;
        this.log.info('light show: lamps given back to the car');
    }
}

module.exports = { LampLink, LAMPS, BY_ID, FN, NRC, LAYOUTS, LAYOUT, BDC, FLM_L, FLM_R, req, check, hex, why };

'use strict';
/**
 * lamps.js - the car's exterior lamps, one by one, through the body controller's own test functions (BDC, 0x40),
 * as BMW's SGBD for the G05 body controller (BDC_G05) describes them:
 *
 *   LICHT_AUSGANG_DIGITAL_STEUERN, 0x2F (I/O control) on 0xE3B5, one lamp output at a time:
 *       2F E3 B5 03 <output> 01     on     (03: short term adjustment)
 *       2F E3 B5 03 <output> 00     off
 *       2F E3 B5 00 <output>        back to the car (00: return control to the ECU; the car's own lights: the
 *                                   driver's brake pedal, the light switch, the turn signals work again)
 *   LEUCHTEN_FUNKTION, 0x2E on 0xD542, a lamp function for a time, then the car's own again (fallback, and the
 *   lamp check's second try):
 *       2E D5 42 <function, 2 bytes> <time, 2 bytes, 10 ms units>
 *
 * The outputs need the extended diagnostic session (10 03), kept alive with tester present (3E 00) every 2 s. If
 * the app stops talking (closed, crashed, the head unit restarted) the body controller drops back to its default
 * session within a few seconds and every lamp is the car's own again: the failsafe that needs nothing from us.
 *
 * Only the requests above (and the session ones) are ever built here: check() refuses anything else.
 */
const BDC = 0x40;
const OUT_DID = [0xE3, 0xB5], FN_DID = [0xD5, 0x42];
const TP_MS = 2000;                       // tester present (the session ends after ~5 s without)

/** Lamp outputs (TAB_LEUCHTEN_AUSGANG_DIGITAL_ARG), by the names the patterns use. side: which side of the car;
 *  end: front / rear; usual: what the lamp normally is while driving at night ('on': taking it over turns it off
 *  between flashes, which the emergency patterns never do). */
const LAMPS = [
    { id: 'lowL', out: 0x01, name: 'Low beam left', end: 'front', side: 'L', usual: 'on' },
    { id: 'lowR', out: 0x02, name: 'Low beam right', end: 'front', side: 'R', usual: 'on' },
    { id: 'highL', out: 0x07, name: 'High beam left', end: 'front', side: 'L' },
    { id: 'highR', out: 0x08, name: 'High beam right', end: 'front', side: 'R' },
    { id: 'drlL', out: 0x03, name: 'Daytime light left', end: 'front', side: 'L', usual: 'on' },
    { id: 'drlR', out: 0x04, name: 'Daytime light right', end: 'front', side: 'R', usual: 'on' },
    { id: 'fogL', out: 0x0B, name: 'Fog light left', end: 'front', side: 'L' },
    { id: 'fogR', out: 0x0C, name: 'Fog light right', end: 'front', side: 'R' },
    { id: 'indFL', out: 0x0D, name: 'Turn signal front left', end: 'front', side: 'L' },
    { id: 'indFR', out: 0x0E, name: 'Turn signal front right', end: 'front', side: 'R' },
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

/** Lamp functions (TAB_LEUCHTEN_FUNKTION_ARG) for 0xD542: both sides at once, for a time. The lamp check tries
 *  a lamp's function when its own output is refused. */
const FN = { lowL: 0x03, lowR: 0x03, highL: 0x05, highR: 0x05, drlL: 0x04, drlR: 0x04, fogL: 0x08, fogR: 0x08,
    indFL: 0x06, indSL: 0x06, indRL: 0x06, indFR: 0x07, indSR: 0x07, indRR: 0x07, brakeL: 0x0C, brakeR: 0x0C, brakeM: 0x0C,
    rfogL: 0x0E, rfogR: 0x0E, revL: 0x0F, revR: 0x0F };

const NRC = { 0x10: 'refused', 0x11: 'not supported', 0x12: 'not supported', 0x13: 'wrong length', 0x22: 'conditions not correct',
    0x31: 'not fitted', 0x33: 'locked (security access)', 0x7E: 'not in this session', 0x7F: 'not in this session' };
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');

const req = {
    on: (l) => [0x2F, OUT_DID, 0x03, l.out, 0x01],
    off: (l) => [0x2F, OUT_DID, 0x03, l.out, 0x00],
    release: (l) => [0x2F, OUT_DID, 0x00, l.out],
    releaseShort: () => [0x2F, OUT_DID, 0x00],
    fn: (fn, ms) => { const t = Math.max(1, Math.min(32700, Math.round(ms / 10))); return [0x2E, FN_DID, 0x00, fn, t >> 8, t & 0xFF]; },
    session: (s) => [0x10, s],
    tp: () => [0x3E, 0x00],
};
Object.keys(req).forEach((k) => { const f = req[k]; req[k] = (...a) => [].concat(...f(...a)); });

/** Throws unless the request is one of the above (to the body controller, the lamp identifiers only). */
function check(target, bytes) {
    if (target !== BDC) throw new Error('light show: only the body controller');
    const [sid, a, b, c, d, e] = bytes;
    const outs = LAMPS.map((l) => l.out);
    if (sid === 0x10 && bytes.length === 2 && (a === 0x01 || a === 0x03)) return;
    if (sid === 0x3E && bytes.length === 2 && a === 0x00) return;
    if (sid === 0x2F && a === 0xE3 && b === 0xB5) {
        if (bytes.length === 6 && c === 0x03 && outs.indexOf(d) >= 0 && (e === 0 || e === 1)) return;
        if (bytes.length === 5 && c === 0x00 && outs.indexOf(d) >= 0) return;
        if (bytes.length === 4 && c === 0x00) return;
    }
    if (sid === 0x2E && a === 0xD5 && b === 0x42 && bytes.length === 7 && c === 0x00 && Object.values(FN).indexOf(d) >= 0) return;
    throw new Error('light show: request not allowed: ' + bytes.map(hex).join(' '));
}

/**
 * The link to the body controller: one request at a time, the session kept, every lamp it took over given back.
 *   const link = new LampLink(diag, log);
 *   await link.start();                  // extended session (and tester present) - false when refused
 *   await link.set('highL', true);       // { ok, nrc, ms }
 *   await link.set('highL', false, 'release' | 'off');
 *   await link.stop();                   // every lamp back to the car, default session
 */
class LampLink {
    constructor(diag, log, opts) {
        this.diag = diag; this.log = log; this.opts = opts || {};
        this.held = new Set();            // lamps taken over (on or forced off) and not given back
        this.active = false; this.session = null; this.releaseForm = 'long';
        this.stats = { sent: 0, ok: 0, refused: 0, missed: 0, ms: 0, last: null };
        this.queue = Promise.resolve(); this.tp = null; this.lastSent = 0;
    }
    /** one request, in turn; resolves with { ok, nrc, ms, reply } */
    request(bytes) {
        check(BDC, bytes);
        const run = async () => {
            const t0 = Date.now(), sid = bytes[0], data = bytes.slice(1);
            const echo = data.slice(0, sid === 0x2F ? 3 : sid === 0x2E ? 2 : 1);
            const accept = (u) => (u[0] === sid + 0x40 && echo.every((x, i) => u[i + 1] === x)) || (u[0] === 0x7F && u[1] === sid);
            this.stats.sent++; this.lastSent = t0;
            let u = null;
            try { u = await this.diag.physical(BDC, sid, data, this.opts.timeoutMs || 800, accept, { maxRetries: 1, retryBaseMs: 60, pendingTimeoutMs: 1000, callTimeoutMs: 1500 }); }
            catch (e) { this.stats.last = String(e.message || e); }
            const ms = Date.now() - t0;
            this.stats.ms = this.stats.ms ? this.stats.ms * 0.8 + ms * 0.2 : ms;
            if (!u) { this.stats.missed++; return { ok: false, nrc: null, ms, reply: null }; }
            if (u[0] === 0x7F) { this.stats.refused++; this.stats.last = (bytes.slice(0, 3).map(hex).join(' ')) + ': ' + (NRC[u[2]] || 'NRC ' + hex(u[2])); return { ok: false, nrc: u[2], ms, reply: u }; }
            this.stats.ok++;
            return { ok: true, nrc: null, ms, reply: u };
        };
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => null);
        return p;
    }
    async start() {
        if (this.active) return true;
        this.active = true;
        const r = await this.request(req.session(0x03));
        this.session = r.ok ? 'extended' : 'default (' + (r.nrc !== null ? NRC[r.nrc] || 'NRC ' + hex(r.nrc) : 'no answer') + ')';
        this.log.info('light show: body controller session ' + this.session);
        clearInterval(this.tp);
        this.tp = setInterval(() => { if (this.active && Date.now() - this.lastSent > TP_MS * 0.75) this.request(req.tp()); }, TP_MS / 2);
        return r.ok;
    }
    /** on = true / false; off as 'release' (the car's own again) or 'off' (held dark). */
    async set(id, on, offAs) {
        const l = BY_ID[id];
        if (!l) return { ok: false, nrc: null, ms: 0 };
        if (on || offAs === 'off') {
            const r = await this.request(on ? req.on(l) : req.off(l));
            if (r.ok) this.held.add(id);
            return r;
        }
        return this.release(id);
    }
    async release(id) {
        const l = BY_ID[id];
        let r = await this.request(this.releaseForm === 'short' ? req.releaseShort() : req.release(l));
        // (the description has the output among its arguments; some units take the release without it)
        if (!r.ok && r.nrc === 0x13 && this.releaseForm === 'long') { this.releaseForm = 'short'; r = await this.request(req.releaseShort()); }
        if (r.ok) { if (this.releaseForm === 'short') this.held.clear(); else this.held.delete(id); this.noRelease = false; }
        else if (r.nrc !== null && !this.noRelease) {
            // the unit doesn't give single lamps back: from now on the player holds lamps that are normally off
            // dark instead, and leaves the others alone (the session's end gives everything back)
            this.noRelease = true;
            this.log.warn('light show: ' + l.name + ' not given back (' + (NRC[r.nrc] || 'NRC ' + hex(r.nrc)) + '): lamps are held dark between flashes');
        }
        // a lamp that is normally off goes dark now (one the car keeps on stays as it is until the session ends)
        if (!r.ok && r.nrc !== null && !l.usual) { const o = await this.request(req.off(l)); if (o.ok) this.held.add(id); }
        return r;
    }
    /** a lamp function for ms (both sides), then the car's own again */
    fn(id, ms) { return FN[id] ? this.request(req.fn(FN[id], ms)) : Promise.resolve({ ok: false, nrc: null, ms: 0 }); }
    /** every lamp back to the car, then the default session (which gives back anything left) */
    async stop() {
        if (!this.active) return;
        for (const id of Array.from(this.held)) await this.release(id);
        clearInterval(this.tp); this.tp = null;
        await this.request(req.session(0x01));
        this.held.clear();
        this.active = false;
        this.log.info('light show: lamps given back to the car');
    }
}

module.exports = { LampLink, LAMPS, BY_ID, FN, NRC, BDC, req, check, hex };

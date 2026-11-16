'use strict';
/**
 * fastkw.js - the battery's power as fast as the cluster's eDRIVE needle, and as real as the battery's own readings.
 *
 * The battery's power is read from the battery unit over the head unit's diagnostic gateway: a reading a second or
 * so, each one late. The car sends its eDRIVE needle (Efficiencytainment2.statusPowerRelativHybrid: the electric
 * drive and the recuperation as shares of their most) by itself many times a second, and the AC compressor's power
 * (Climate2.statusActualValuePowerACCompressor). So:
 *
 *   kW now = a x drive share - b x recuperation share + AC compressor + c
 *
 * a and b (kW at a full needle) and c (the rest the car draws: heater, 12 V, pumps) are learned from the battery's
 * readings by recursive least squares that slowly forgets (the car's state moves), each reading set against the
 * needle as it was when the reading was taken (LAG_MS before it arrived). Until a few readings have been learned,
 * or without a fresh needle, there is no fast value and the readings are shown.
 *
 *   const f = new FastKw();
 *   f.needle(drive, recup, t)   f.ac(kw)   f.reading(kw, t)
 *   f.now(t) -> kW | null        f.fit -> { a, b, c, n, err }
 */
const LAG_MS = 250;          // fallback lag if reading() isn't given the measured read latency (request + answer)
const FRESH_MS = 1500;       // a needle older than this: no fast value
const KEEP_MS = 4000;        // needle history kept (to match readings that arrive late)
const MIN_FIT = 6;           // readings learned before a fast value is given (a touch more warm-up: steadier first value)
const FORGET = 0.98;         // each reading weighs this much more than the last (~50 readings: a/b/c are physical scale)

const isNum = (v) => typeof v === 'number' && isFinite(v);

class FastKw {
    constructor(o) {
        const opt = o || {};
        this.lag = opt.lagMs || LAG_MS;
        this.hist = [];                      // [t, drive, recup]
        this.acKw = 0;
        // a, b, c with their uncertainty: a full needle about 1 kW a percent to start with
        this.theta = [1, 0.6, 0.8];
        this.P = [[4, 0, 0], [0, 4, 0], [0, 0, 4]];
        this.n = 0; this.err = null;
        this.electric = true;                // engine off: the needle's %->kW scale is only the battery's then
    }

    /** The needle: drive and recuperation shares (as the car sends them), at t. */
    needle(drive, recup, t) {
        if (!isNum(drive) && !isNum(recup)) return;
        this.hist.push([t, isNum(drive) ? drive : 0, isNum(recup) ? recup : 0]);
        while (this.hist.length > 2 && t - this.hist[0][0] > KEEP_MS) this.hist.shift();
    }

    ac(kw) { this.acKw = isNum(kw) && kw > 0 ? kw : 0; }

    /** The engine's state (pass engineOn). The eDRIVE needle's percent->kW scale is only the battery's with the
     *  engine off; running, the needle's full-scale reference changes, so we neither learn nor emit a fast value
     *  (the raw readings are shown instead). */
    engine(on) { this.electric = on === false; }

    /** The needle as it was at t (the last one sent before it), or null. */
    at(t) {
        let best = null;
        for (const h of this.hist) { if (h[0] <= t) best = h; else break; }
        return best && t - best[0] < FRESH_MS ? best : null;
    }

    /** A battery reading (kW, + the battery gives power) that arrived at t: learned against the needle then. */
    reading(kw, t, lagMs) {
        if (!isNum(kw) || !this.electric) return;   // engine running: the %->kW scale isn't the battery's - don't learn
        const lag = isNum(lagMs) ? Math.min(2000, Math.max(50, lagMs)) : this.lag;  // the measured read latency when given
        const h = this.at(t - lag);
        if (!h) return;
        const x = [h[1], -h[2], 1], y = kw - this.acKw;
        const Px = this.P.map((r) => r[0] * x[0] + r[1] * x[1] + r[2] * x[2]);
        const den = FORGET + x[0] * Px[0] + x[1] * Px[1] + x[2] * Px[2];
        const k = Px.map((v) => v / den);
        const e = y - (this.theta[0] * x[0] + this.theta[1] * x[1] + this.theta[2] * x[2]);
        this.theta = this.theta.map((v, i) => v + k[i] * e);
        this.P = this.P.map((r, i) => r.map((v, j) => (v - k[i] * Px[j]) / FORGET));
        // a full needle is never less than nothing; keeps a wild early reading from turning the gauge round
        this.theta[0] = Math.max(0.05, this.theta[0]); this.theta[1] = Math.max(0, this.theta[1]);
        this.err = this.err === null ? Math.abs(e) : this.err * 0.8 + Math.abs(e) * 0.2;
        this.n++;
    }

    /** The power now (kW), or null: not learned yet, or no fresh needle. */
    now(t) {
        if (!this.electric || this.n < MIN_FIT || !this.hist.length) return null;
        const h = this.hist[this.hist.length - 1];
        if (t - h[0] > FRESH_MS) return null;
        return this.theta[0] * h[1] - this.theta[1] * h[2] + this.acKw + this.theta[2];
    }

    get fit() { return { a: this.theta[0], b: this.theta[1], c: this.theta[2], n: this.n, err: this.err }; }
}

module.exports = { FastKw, LAG_MS, FRESH_MS, MIN_FIT };

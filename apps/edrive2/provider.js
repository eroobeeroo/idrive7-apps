'use strict';
/**
 * provider.js - eDrive Live's values for Cluster Info's panel over the Waze map (apps/cluster_info,
 * providers.js there has the folder's format): the battery's power (kW, the bar's ends from the battery's
 * limits) and the battery and engine oil temperatures.
 *
 * Cluster Info writes wanted.json in the folder while its panel is up; only then does eDrive Live read fast
 * (keepFast) and write its file, 4 times a second, so the car can sleep otherwise.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.CLUSTER_INFO_DIR || '/dev/shm/cluster-info';   // (the variable: tests)
const FILE = 'edrive2.json';
const TICK_MS = 250;
const WANTED_FRESH_MS = 3000;

/**
 * src: { power() -> { kw, old } | null, limits() -> { out, in } | null, battery() -> deg C | null,
 *        oil() -> deg C | null, keepFast(), on() -> whether to provide (setting) }.
 * opts (tests): dir, now, setInterval.
 */
function startProvider(log, src, opts) {
    opts = opts || {};
    const dir = opts.dir || DIR, now = opts.now || Date.now;
    let wanted = null, wantedRead = 0, writing = false, failed = false;
    const status = { wanted: false, written: 0, error: null };
    function readWanted() {
        if (now() - wantedRead < 1000) return wanted;
        wantedRead = now();
        try {
            const w = JSON.parse(fs.readFileSync(path.join(dir, 'wanted.json'), 'utf8'));
            wanted = w && now() - w.t < WANTED_FRESH_MS ? w : null;
        } catch (e) { wanted = null; }
        return wanted;
    }
    function tick() {
        const w = src.on() ? readWanted() : null;
        status.wanted = !!w;
        if (!w) { if (writing) { writing = false; try { fs.unlinkSync(path.join(dir, FILE)); } catch (e) { /* gone */ } } return; }
        src.keepFast();
        const out = { v: 1, t: now(), app: 'eDrive Live', values: {} };
        const p = w.power ? src.power() : null;
        if (p && typeof p.kw === 'number') {
            const lim = src.limits();
            out.power = { kw: Math.round(p.kw * 100) / 100, old: !!p.old, outMax: src.gaugeKw(),
                inMax: Math.max(10, lim && lim.in >= 15 ? Math.round(lim.in) : src.gaugeKw() * 0.5) };
        }
        const b = src.battery(), o = src.oil();
        if (typeof b === 'number') out.values.battery = { c: Math.round(b * 10) / 10 };
        if (typeof o === 'number') out.values.oil = { c: Math.round(o) };
        const f = path.join(dir, FILE), tmp = f + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o644 });
            fs.renameSync(tmp, f);
            writing = true; status.written = now(); status.error = null; failed = false;
        } catch (e) {
            status.error = e.message;
            if (!failed) { failed = true; log.warn('cluster info: ' + e.message); }
        }
    }
    (opts.setInterval || setInterval)(tick, TICK_MS);
    return { status: () => Object.assign({}, status), wanted: () => readWanted(), _tick: tick };
}

module.exports = { startProvider };

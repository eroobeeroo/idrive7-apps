'use strict';
/**
 * providers.js - values other apps hand Cluster Info for its panel, through files in a shared folder.
 *
 * Any app (it runs as its own user, in the group every app has) writes /dev/shm/cluster-info/<its id>.json,
 * replacing it whole (write a temporary file, then rename it over), a few times a second while it has fresh
 * values:
 *
 *   { "v": 1, "t": <Date.now() when written>, "app": "eDrive Live",
 *     "power": { "kw": -1.2, "outMax": 100, "inMax": 60, "old": false },     (optional: the battery's power)
 *     "values": { "battery": { "c": 24.5 }, "oil": { "c": 81 },              (optional: temperatures in deg C,
 *                 "soc": { "pct": 64.4 } } }                                   a percentage, or { "text", "label" })
 *
 * A file older than STALE_MS counts as gone. Cluster Info writes wanted.json in the same folder while its panel
 * is up: { "t": ..., "power": true, "values": ["battery", "oil"] } - what it shows now, so a provider can read
 * fast only then (and let the car sleep otherwise).
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.CLUSTER_INFO_DIR || '/dev/shm/cluster-info';   // (the variable: tests)
const STALE_MS = 3000;
const WANTED = 'wanted.json';

function startProviders(log, opts) {
    opts = opts || {};
    const dir = opts.dir || DIR;
    const now = opts.now || Date.now;
    let entries = {};          // id -> parsed file
    let ready = false;
    function ensureDir() {
        if (ready) return true;
        try {
            try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }    // (Node 8: no recursive)
            // every app may drop its file here, and only remove its own (sticky)
            fs.chmodSync(dir, 0o1777);
            ready = true;
        } catch (e) {
            if (!ensureDir.warned) { ensureDir.warned = true; log.warn('providers: ' + dir + ': ' + e.message); }
        }
        return ready;
    }
    function scan() {
        if (!ensureDir()) return;
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        const next = {};
        names.forEach((n) => {
            if (!/\.json$/.test(n) || /^wanted(-[\w.-]+)?\.json$/.test(n)) return;   // (what the apps want: not a provider)
            try {
                const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
                if (j && typeof j.t === 'number' && now() - j.t < STALE_MS) next[n.replace(/\.json$/, '')] = j;
            } catch (e) { /* half written or not ours: the next scan */ }
        });
        const before = Object.keys(entries).sort().join(','), after = Object.keys(next).sort().join(',');
        if (before !== after) log.info('providers: ' + (after || 'none'));
        entries = next;
    }
    /** The power from the first provider that has it: { kw, outMax, inMax, old, app } or null. */
    function power() {
        for (const id of Object.keys(entries).sort()) {
            const p = entries[id].power;
            if (p && typeof p.kw === 'number' && isFinite(p.kw)) return Object.assign({ app: entries[id].app || id }, p);
        }
        return null;
    }
    /** A named value from the first provider that has it: { c }, { pct } or { text, label }, with app; or null. */
    function value(name) {
        for (const id of Object.keys(entries).sort()) {
            const v = entries[id].values && entries[id].values[name];
            if (v && (typeof v.c === 'number' || typeof v.pct === 'number' || typeof v.text === 'string')) return Object.assign({ app: entries[id].app || id }, v);
        }
        return null;
    }
    let wantedT = 0;
    /** The panel is up showing these: tell the providers (at most once a second). */
    function want(what) {
        if (now() - wantedT < 1000 || !ensureDir()) return;
        wantedT = now();
        const f = path.join(dir, WANTED), tmp = f + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(Object.assign({ t: now() }, what)), { mode: 0o644 });
            fs.renameSync(tmp, f);
        } catch (e) { /* the folder went: made again next time */ ready = false; }
    }
    /* A provider's new file is seen at once (the folder watched: a rename over the file), not at the next scan;
     * the scan every scanMs stays for a folder that can't be watched. */
    let watcher = null, pending = false;
    const soon = () => {
        if (pending) return;
        pending = true;
        setImmediate(() => { pending = false; scan(); if (opts.onChange) opts.onChange(); });
    };
    function watchDir() {
        if (watcher || !ready || (opts.watch === undefined ? !!opts.setInterval : !opts.watch)) return;   // (tests with their own timers: unwatched)
        try {
            watcher = fs.watch(dir, (ev, name) => { if (!name || (/\.json$/.test(name) && !/^wanted/.test(name))) soon(); });
            watcher.on('error', () => { try { watcher.close(); } catch (e) { /* gone */ } watcher = null; });
        } catch (e) { watcher = null; }
    }
    const si = opts.setInterval || setInterval;
    const timer = si(() => { scan(); watchDir(); }, opts.scanMs || 250);
    scan(); watchDir();
    return {
        power, value, want, scan,
        /** For the status page: the providers now, { id: app name }. */
        list: () => { const o = {}; Object.keys(entries).forEach((id) => { o[id] = entries[id].app || id; }); return o; },
        stop: () => { (opts.clearInterval || clearInterval)(timer); if (watcher) { watcher.close(); watcher = null; } },
    };
}

module.exports = { startProviders, DIR, STALE_MS, WANTED };

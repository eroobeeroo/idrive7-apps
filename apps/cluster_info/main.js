'use strict';
/**
 * Cluster Info - a small panel of live values over the Waze map in the instrument cluster or on the HUD
 * (Waze on cluster), plus turn signal arrows on the HUD. For any car:
 *
 *   - its own values from the car: engine oil and coolant temperature (CDS statusEngineTemperature), the turn
 *     signals (body Light), day / night (to dim the HUD extras), the driver profile (each driver keeps their
 *     own settings);
 *   - values other apps provide through /dev/shm/cluster-info (providers.js): eDrive Live gives the battery's
 *     power (the kW meter and its bar) and the battery temperature; any app can add its own the same way.
 *
 * The panel itself is overlay.js; this page shows what it shows now, larger, and whether each source works.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { startOverlay, drawBadge, badgeRect, mapRect } = require('./overlay');
const { startProviders, DIR } = require('./providers');
const IND = require('./indicators');

const W = 1600, H = 520;
const GO = '#2fd27a';
const IDLE_KW = 0.3;
const VALUES = {
    battery: { label: 'BATT', what: 'battery temperature' },
    oil: { label: 'OIL', what: 'engine oil temperature' },
    coolant: { label: 'COOL', what: 'coolant temperature' },
    soc: { label: 'SOC', what: 'battery charge (%)' },
    // the engine, from the car's own signals (no diagnostics): boost (the sport display's), speed, torque
    boost: { label: 'BOOST', what: 'boost pressure', engine: true },
    rpm: { label: 'RPM', what: 'engine speed', engine: true },
    torque: { label: 'NM', what: 'engine torque', engine: true },
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['temps', 'rpm', 'torque']);
        const providers = startProviders(log);
        const live = { indicator: 'off', night: null, profile: null, raw: {} };
        const sigStatus = {};
        const one = (v, key) => {
            if (!v || typeof v !== 'object') return undefined;
            if (key in v) return v[key];
            for (const k of Object.keys(v)) { const r = one(v[k], key); if (r !== undefined) return r; }
            return undefined;
        };
        const watch = (iface, handlers, what, opts, instance) => ctx.signals.watch(iface, instance || '1', handlers, log, opts)
            .then((s) => { sigStatus[what] = s.error ? 'error: ' + s.error : 'subscribed'; log.info(what + ' ' + sigStatus[what]); return s; });

        /* ---------- units ---------- */
        const F = () => settings.get('tempUnit') === 'f';
        const temp = (c) => (G.isNum(c) ? G.fmt(F() ? c * 9 / 5 + 32 : c, 0) + '°' : '--');

        /* ---------- turn signals: either field may be the one the car fills, so both are watched ----------
         * controlIndicateDirection: 1 / 3 tap / steady left, 2 / 4 right, 8 both (hazards), 0 off; else
         * activeFunctionIndicateDirection, the function blinking: 7 / 9 / 18 / 20 / 22 left, 8 / 10 / 19 / 21 / 23
         * right, hazards and alarms both, 0 off. The raw values show on this app's page. */
        const onIndicators = (what) => (v) => {
            live.raw[what] = JSON.stringify(v);
            const c = one(v, 'controlIndicateDirection'), a = one(v, 'activeFunctionIndicateDirection');
            const dir = IND.direction(c, a);
            if (dir) { if (dir !== live.indicator) log.info('turn signals: ' + dir + ' (' + what + ' ' + c + ' / ' + a + ')'); live.indicator = dir; }
        };
        watch('de.bmw.body.Light', {
            StatusFunctionsIndicators: onIndicators('indicators'),
            StatusFunctionsIndicators2: onIndicators('indicators 2'),
        }, 'turn signals');
        // day or night (the car's light sensor): 1 day, 2 night, 0 unchanged
        watch('de.bmw.infotainment.vehicle.Vehicle', {
            statusDayNightChangeOver: (v) => {
                live.raw['day / night'] = JSON.stringify(v);
                const n = IND.night(one(v, 'dayNightChangeOver'));
                if (n !== null) live.night = n;
            },
        }, 'day / night');

        /* ---------- settings per driver profile ----------
         * The head unit's current user account (SessionManager.currentUserAccountReference: a getter only, read
         * every 5 s). Each driver keeps their own PROFILE_KEYS in profiles.json: a change is kept for the driver at
         * the time, and a driver seen again gets theirs back; one seen for the first time keeps what is set. */
        const PROFILE_KEYS = ['show', 'place', 'slot1', 'slot2', 'slot3', 'bar', 'turnSignals', 'hudBrightness', 'nightDim'];
        const PROFILE_FILE = path.join(ctx.dataDir, 'profiles.json');
        let profiles = {}, applying = false;
        try { profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) || {}; } catch (e) { /* none yet */ }
        const saveProfiles = () => { try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(profiles)); } catch (e) { log.warn('profiles: ' + e); } };
        const snapshot = () => { const o = {}; PROFILE_KEYS.forEach((k) => { o[k] = settings.get(k); }); return o; };
        function onProfile(id) {
            if (!id || id === live.profile) return;
            live.profile = id;
            const saved = profiles[id];
            if (saved) {
                applying = true;
                PROFILE_KEYS.forEach((k) => { if (saved[k] !== undefined && saved[k] !== settings.get(k)) settings.set(k, saved[k]); });
                applying = false;
                log.info('driver profile ' + id + ': their settings');
            } else {
                profiles[id] = snapshot();
                saveProfiles();
                log.info('driver profile ' + id + ': first seen, the current settings kept for them');
            }
        }
        settings.onChange((k, v) => {
            if (applying || !live.profile || PROFILE_KEYS.indexOf(k) < 0) return;
            profiles[live.profile] = Object.assign(profiles[live.profile] || snapshot(), { [k]: v });
            saveProfiles();
        });
        watch('de.bmw.infotainment.personalization.SessionManager', {
            currentUserAccountReference: (v) => {
                const id = typeof v === 'string' ? v : v && (v.value || v.currentUserAccountReference);
                if (id) onProfile(String(id));
            },
        }, 'driver profile', { pollMs: 5000 }, 'de.bmw.infotainment.personalization.SessionManager');

        /* ---------- boost, from the car's sport display signal ----------
         * FES statusSwitchDriveDynamicSport2: displayBoostPressure in hundredths of a bar over atmosphere
         * (tenths read ten times too high against the engine unit and M Vitals, issue #7); 254 and up: none. */
        watch('de.bmw.infotainment.drivingexcitement.FES', {
            statusSwitchDriveDynamicSport2: (v) => {
                live.raw.sport = JSON.stringify(v);
                const b = one(v, 'displayBoostPressure');
                if (typeof b === 'number' && b >= 0 && b < 254) { live.boost = b / 100; live.boostT = Date.now(); }
            },
        }, 'boost', { pollMs: 1000 });

        /* ---------- what the panel shows ---------- */
        /** The three slots in order: 'power' (the kW meter) or a value's name; none and repeats left out. */
        const slots = () => [settings.get('slot1'), settings.get('slot2'), settings.get('slot3')]
            .filter((k, i, a) => (k === 'power' || VALUES[k]) && a.indexOf(k) === i);
        const chosen = () => slots().filter((k) => k !== 'power');
        /** A value now, in deg C: the car's own (oil, coolant) first, else a provider's; { c, src } or null. */
        function valueNow(name) {
            const d = car.data();
            // the engine's (car signals): text in the panel's units (psi with °F, bar with °C)
            if (VALUES[name] && VALUES[name].engine) {
                const metric = settings.get('tempUnit') === 'c';
                if (name === 'boost') {
                    if (!G.isNum(live.boost) || Date.now() - (live.boostT || 0) > 5000) return null;
                    return { text: metric ? live.boost.toFixed(2) : (live.boost * 14.5038).toFixed(1), label: metric ? 'BOOST bar' : 'BOOST psi', src: 'car signal (sport display)' };
                }
                if (name === 'rpm') return G.isNum(d.rpm) && !d.demo ? { text: String(Math.round(d.rpm / 50) * 50), src: 'car signal' } : null;
                if (name === 'torque') {
                    if (!G.isNum(d.torque) || d.demo) return null;
                    // Settings > Torque unit: Nm, or kgm (to a tenth)
                    return settings.get('torqueUnit') === 'kgm'
                        ? { text: (d.torque / 9.80665).toFixed(1), label: 'KGM', src: 'car signal' }
                        : { text: String(Math.round(d.torque)), src: 'car signal' };
                }
            }
            if ((name === 'oil' || name === 'coolant') && !d.demo && G.isNum(d[name])) return { c: d[name], src: 'car signal' };
            const p = providers.value(name);
            return p ? { c: p.c, text: typeof p.pct === 'number' ? Math.round(p.pct) + '%' : p.text, label: p.label, src: p.app } : null;
        }
        const tempCol = (t, name, c) => {
            if (!G.isNum(c)) return t.dim;
            if (name === 'battery') return c < 5 ? t.cold : c > 45 ? t.crit : c > 38 ? t.warn : t.text;
            if (name === 'soc') return t.text;
            return c >= 125 ? t.warn : c < 60 ? (t.cold || t.text) : t.text;
        };
        const src = {
            power(t) {
                if (slots().indexOf('power') < 0) return null;
                const p = providers.power();
                if (!p) return null;
                const v = p.kw, a = Math.abs(v);
                return { kw: v, text: (v < -IDLE_KW ? '-' : '') + G.fmt(a, a < 10 ? 1 : 0), col: p.old ? t.dim : v < -IDLE_KW ? GO : a >= 60 ? t.warn : t.text };
            },
            /** The thin kW bar along the bottom (setting underline: 'cluster' on the cluster only, 'on' also on the
             *  HUD): { kw } whenever an app provides the power, below all three slots, even with no kW meter among them. */
            under(target) {
                if (!this.underOn(target)) return null;
                const p = providers.power();
                return { kw: p && G.isNum(p.kw) ? p.kw : null };
            },
            /** Whether the thin kW bar shows on this target (its strip under the panel is kept while it does). */
            underOn(target) {
                const us = settings.get('underline');
                return us === 'on' || (us === 'cluster' && target !== 'hud');
            },
            limits() { const p = providers.power(); return p ? { outMax: p.outMax, inMax: p.inMax } : null; },
            extras(t) {
                return chosen().map((k) => {
                    const v = valueNow(k);
                    return { slot: slots().indexOf(k), label: (v && v.label) || VALUES[k].label, text: v ? (G.isNum(v.c) ? temp(v.c) : v.text || '--') : '--', col: k === 'soc' ? (v ? t.text : t.dim) : tempCol(t, k, v && v.c) };
                });
            },
            /** The kW meter's slot (0-2 among the slots in use; values with a lower slot go before it). */
            powerAt() { return Math.max(0, slots().indexOf('power')); },
            keepFast() { providers.want({ power: slots().indexOf('power') >= 0 || (settings.get('underline') || 'off') !== 'off', values: chosen() }); },
            indicator: () => live.indicator,
            night: () => live.night === true,
        };
        let overlay = null, overlayError = null;
        try { overlay = startOverlay(ctx, src); } catch (e) { overlayError = String(e); log.warn('overlay: ' + e); }

        /* ---------- this app's page: the panel as it is now, larger, and every source's state ---------- */
        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            G.panel(cv, t, 24, 44, 1552, 468, 'Cluster Info');
            const pw = src.power(t), ex = src.extras(t).filter((e) => e.text !== '--');
            if (pw || ex.length) {
                const b = badgeRect(mapRect('map', 0), 'bottom', 'map', ex.length, !!pw, src.underOn('map'));
                const lim = src.limits() || {};
                // the panel drawn into this page, 1.5 times its cluster size, centred
                const k = 1.5, ox = Math.round(800 - b.w * k / 2), oy = 92;
                const view = {
                    w: b.w, h: b.h, clear() { return view; },
                    roundRect: (x, y, w, h, r, c) => cv.roundRect(ox + x * k, oy + y * k, w * k, h * k, r * k, c),
                    rampRect: (x, y, w, h, r, stops, sx, sw) => cv.rampRect(ox + x * k, oy + y * k, w * k, h * k, r * k, stops, ox + sx * k, sw * k),
                    fillRect: (x, y, w, h, c) => cv.fillRect(ox + x * k, oy + y * k, w * k, h * k, c),
                    text: (str, x, y, size, c, o) => cv.text(str, ox + x * k, oy + y * k, size * k, c, o),
                    textWidth: (str, size, o) => cv.textWidth(str, size * k, o) / k,
                };
                if (pw) pw.bar = settings.get('bar') !== 'off';            // (as on the cluster)
                drawBadge(view, t, pw, lim.outMax || 100, lim.inMax || 50, ex, ex.filter((e) => e.slot < src.powerAt()).length, src.under('map'), b.ph);
            } else {
                cv.text('Nothing to show now: no power from an app, and no value chosen has a reading', 800, 150, 24, t.dim, { align: 'center' });
            }
            const ov = overlay && overlay.status ? overlay.status() : null;
            const st = (k) => sigStatus[k] || 'waiting';
            const provs = providers.list(), pnames = Object.keys(provs).map((k) => provs[k]);
            const lines = [
                ['Shown', settings.display('show') + (settings.get('show') === 'off' ? '' : ', ' + settings.display('place').toLowerCase())
                    + '   ·   Waze map: ' + (ov ? ov.map : '--') + '   ·   Cluster renderer: ' + (overlayError ? 'error: ' + overlayError : ov ? ov.renderer : 'not started')],
                ['Apps providing', (pnames.length ? pnames.join(', ') : 'none') + (pw ? '   ·   power ' + pw.text + ' kW' : '') + '   (folder ' + DIR + ')'],
                ['Values', chosen().map((k) => { const v = valueNow(k); return VALUES[k].label + ' ' + (v ? (G.isNum(v.c) ? temp(v.c) : v.text) + ' from ' + v.src : 'no reading'); }).join('   ·   ') || 'none chosen'],
                ['Turn signals', st('turn signals') + (live.indicator !== 'off' ? ' (now ' + live.indicator + ')' : '')
                    + '   ·   Day / night: ' + (live.night === null ? st('day / night') + ', none received' : live.night ? 'night' : 'day')
                    + '   ·   Driver profile: ' + (live.profile || (st('driver profile') === 'subscribed' ? 'none read yet' : st('driver profile')))],
            ];
            lines.forEach(([k, v], i) => {
                cv.text(k, 48, 300 + i * 40, 20, t.dim, { font: 'bold' });
                cv.text(v, 260, 300 + i * 40, 20, t.text, { font: 'label', literal: true });
            });
            const raws = Object.keys(live.raw).map((k) => k + ': ' + live.raw[k]).join('   ').slice(0, 190);
            cv.text(raws || 'No raw turn signal or day / night value received yet.', 48, 488, 16, t.dim, { font: 'label', literal: true });
            G.frame(cv, t, ['Cluster Info'], 0, []);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

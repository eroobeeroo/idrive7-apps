'use strict';
/**
 * awake.js - whether the car is switched on, so that no app talks to the car's units once it is parked.
 *
 * Every diagnostic request goes through the car's gateway (the body controller) and wakes the car's networks. Asked
 * after the car is locked, they never get to sleep: the body controller stores "no sleep in parking state" and
 * "sleep error while customer absent" (801C16 - 801C18, "PWF status query faulty" 801C10), the engine unit misses
 * its switch-off time, and the car warns "Battery management: malfunction while shutting down the vehicle
 * electronics" (Nov 10 2026, on the car: the cluster apps asked eDrive Live for the power whenever they were set
 * to show, locked or not, and eDrive Live read the battery unit for them).
 *
 * The car's own state: VehicleCondition.statusConditionVehicle (BMW's PWF state; notifications, no getter):
 *    1, 2  PARKEN: parked (locked, or left)            7  PRUEFEN_ANALYSE_DIAGNOSE: ignition on
 *    3     STANDFUNKTIONEN: standby, nobody in it       8  drive readiness starting
 *    5     WOHNEN: someone in it, ignition off          10 FAHREN: ready to drive / driving (a hybrid with the engine off too)
 *                                                       12 drive readiness ending
 * Not told yet (no change since the app started): the car's speed and engine, as the app samples them - moving or
 * running in the last 3 minutes.
 *
 *   const awake = require('./kit/awake').watch(ctx, log, { sample: () => ({ speed: km/h, rpm }) });
 *   awake.on()          switched on (ignition, ready, driving), moving or running now; not told: moved or ran in the last 3 min
 *   awake.parked()      the car says nobody is in it (PARKEN, STANDFUNKTIONEN): nothing may be asked at all
 *   awake.off()         the car says it is switched off (any state but on), not moving or running: an app without the
 *                       car's speed and engine of its own asks nothing then (not told: not off, the app asking decides)
 *   awake.condition()   the state's number, or undefined
 *   awake.why()         a short line for logs and status pages
 *   awake.onChange(fn)  fn(on) when on() changes
 *
 * Needs "de.bmw.infrastructure.VehicleCondition": { "VehicleCondition": "s" } in app.json "signals".
 */
const IFACE = 'de.bmw.infrastructure.VehicleCondition';
const NAMES = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const LABEL = { 1: 'parked', 2: 'parked', 3: 'standby, nobody in the car', 5: 'someone in the car, ignition off',
    7: 'ignition on', 8: 'getting ready to drive', 10: 'ready to drive', 12: 'switching off' };
const ON = [7, 8, 10, 12], PARKED = [1, 2, 3];
const AFTER_MS = 3 * 60000;         // not told the state: on this long after the car last moved or ran
const NOW_MS = 30000;               // moving or running this recently: on, whatever the state said last

/** A state from a notification: a number or a name, alone or as statusConditionVehicle in a struct. */
function conditionOf(v) {
    if (v && typeof v === 'object') {
        if (v.statusConditionVehicle !== undefined) return conditionOf(v.statusConditionVehicle);
        for (const k of Object.keys(v)) { if (/condition/i.test(k)) { const c = conditionOf(v[k]); if (c !== undefined) return c; } }
        return undefined;
    }
    const n = typeof v === 'number' ? v : NAMES[String(v).toUpperCase()];
    return n >= 1 && n <= 12 ? n : undefined;
}

/** The decisions alone (tests): state from note(), activity from active(speed, rpm, t). */
function createAwake(opts) {
    opts = opts || {};
    const now = opts.now || Date.now;
    let cond, condT = 0, activeT = 0, last = null;
    const fns = [];
    const recent = (ms) => activeT > 0 && now() - activeT < ms;
    const self = {
        note(v) { const c = conditionOf(v); if (c === undefined) return; cond = c; condT = now(); self._check(); },
        active(speed, rpm) {
            if ((typeof speed === 'number' && speed > 1) || (typeof rpm === 'number' && rpm > 400)) activeT = now();
            self._check();
        },
        condition: () => cond,
        parked: () => PARKED.indexOf(cond) >= 0 && !recent(NOW_MS),
        on: () => recent(NOW_MS) || (cond !== undefined ? ON.indexOf(cond) >= 0 : recent(AFTER_MS)),
        off: () => cond !== undefined && ON.indexOf(cond) < 0 && !recent(NOW_MS),
        why: () => (cond !== undefined ? LABEL[cond] || 'state ' + cond : 'car state not told yet') + (recent(NOW_MS) ? ', moving or running' : ''),
        onChange(fn) { fns.push(fn); },
        _check() {
            const o = self.on();
            if (last !== null && o !== last) fns.forEach((fn) => { try { fn(o); } catch (e) { /* the listener's own */ } });
            last = o;
        },
    };
    return self;
}

function watch(ctx, log, opts) {
    opts = opts || {};
    const a = createAwake();
    a.onChange((on) => log && log.info('car ' + (on ? 'on' : 'off') + ' (' + a.why() + ')' + (on ? '' : ': no requests to its units')));
    if (ctx && ctx.signals && ctx.signals.watch) {
        ctx.signals.watch(IFACE, '1', {
            VehicleCondition: (v) => {
                const was = a.condition();
                a.note(v);
                if (a.condition() !== was && log) log.info('car state: ' + a.why());
            },
        }, log).then((s) => log && log.info('car state ' + (s && s.error ? 'error: ' + s.error : 'subscribed')), () => null);
    }
    if (opts.sample) {
        const t = setInterval(() => { try { const s = opts.sample() || {}; a.active(s.speed, s.rpm); } catch (e) { /* next time */ } }, 1000);
        if (t.unref) t.unref();
    }
    return a;
}

module.exports = { watch, createAwake, conditionOf, ON, PARKED };

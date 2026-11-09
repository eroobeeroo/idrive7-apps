'use strict';
/**
 * economy.js - the onboard computer's average fuel economy for the mode the driver has chosen (Individual,
 * Since refuelling, Since charging, Since start of journey, Long-term), as the car's reset logic sends it
 * (de.bmw.infotainment.resetlogic.ResetLogic3, or 2, or 1: bcDataAll, in this G05 PHEV's catalog), and an
 * uncapped figure of our own where the car's stops at its gauge's top (about 90 mpg).
 *
 * bcDataAll holds the chosen mode only (bcData3.resetOption / activeResetLogic), with its average, its distance
 * and when it was reset. The other modes show as they were when last chosen.
 *
 * Our own figure: the fuel the engine used (whole litres the tank went down while the car was on; a rise is a
 * refuel and is not counted) over the distance driven (the odometer, KombiIF.statusRangeTankStatus
 * mileageKilometre), counted from when the mode was reset. It counts only while this app runs (it starts with
 * the car), so it says how much of the mode's distance it saw; a litre's steps make it rough over short spans.
 */
const L_PER_GAL_US = 3.785411784, L_PER_GAL_UK = 4.54609, KM_PER_MI = 1.609344;
const MODES = { 1: 'INDIVIDUAL', 2: 'REFUEL', 3: 'CHARGE', 4: 'STARTOFDRIVING', 5: 'LONGTERM', 6: 'AVERAGE' };
const MODE_NAMES = { INDIVIDUAL: 'Individual', REFUEL: 'Since refuelling', CHARGE: 'Since charging', STARTOFDRIVING: 'Since start',
    LONGTERM: 'Long-term', AVERAGE: 'Average', DEFAULT: 'Default' };
/* the car's consumption units (StatusUnitConsumptionBC / BC3) */
const UNITS = { 1: 'L/100km', 2: 'mpg (UK)', 3: 'mpg', 4: 'km/L', 5: 'kg/100km', 6: 'kg/100mi', 7: 'L/h', 8: 'gal/h', 9: 'gal (UK)/h' };
const UNIT_NAMES = { CONSUMPTION_KM: 1, CONSUMPTION_UK: 2, CONSUMPTION_US: 3, CONSUMPTION_KML: 4, CONSUMPTION_KGH2_100KM: 5,
    CONSUMPTION_KGH2_100MI: 6, CONSUMPTION_L_H: 7, CONSUMPTION_GAL_US_H: 8, CONSUMPTION_GAL_UK_H: 9 };
const MIN_KM = 3;              // our figure from this much distance on
const FULL_COVER = 0.9;        // ... and counted as the mode's whole span when we saw this share of its distance

/** An enum as a number: its value, or its name looked up (the binding gives either). */
function enumNum(v, names) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        if (/^\d+$/.test(v)) return Number(v);
        for (const k of Object.keys(names)) if (names[k] === v || k === v) return typeof names[k] === 'number' ? names[k] : Number(k);
    }
    return null;
}
const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined) return o[k]; return undefined; };

/**
 * One bcDataAll value: { mode, modeName, avg, unit, unitNum, max, capped, km, eKm, speedAvg, resetAt, raw }.
 * avg in the car's unit (its digit / 10, the one decimal the cluster shows); null when not given.
 */
function decode(v) {
    if (!v || typeof v !== 'object') return null;
    const bc = v.bcData3 || v.bcData2 || v.bcData || {};
    const units = v.bcUnits || {};
    const modeNum = enumNum(bc.resetOption, MODES);
    const mode = MODES[modeNum] || (typeof bc.resetOption === 'string' ? bc.resetOption : null);
    const unitNum = enumNum(pick(units, ['averageConsumptionCombustion', 'consumption']), UNIT_NAMES);
    const digit = pick(bc, ['consumptionCombustionAverageDigit', 'consumptionAverage']);
    const maxRaw = v.maxValues ? v.maxValues.maxValueAverageConsumptionCombustion : undefined;
    const ok = (n) => typeof n === 'number' && n >= 0 && n < 65535;
    const avg = ok(digit) ? digit / 10 : null;
    const max = ok(maxRaw) && maxRaw > 0 ? maxRaw / 10 : null;
    const r = bc.dateTimeReset;
    const resetAt = r && r.year ? '20' + String(r.year).padStart(2, '0') + '-' + String(r.month).padStart(2, '0') + '-' + String(r.day).padStart(2, '0')
        + ' ' + String(r.hour).padStart(2, '0') + ':' + String(r.minute).padStart(2, '0') : null;
    const dist = (n) => (typeof n === 'number' && n >= 0 && n < 4294967295 ? n : null);
    return {
        mode, modeName: MODE_NAMES[mode] || mode || '?', unitNum, unit: UNITS[unitNum] || null, avg, max,
        // the car stops its figure at the gauge's top: at (or within a tenth of) it, it may be more
        capped: avg !== null && ((max !== null && avg >= max - 0.1) || (unitNum === 3 && avg >= 89.9 && avg <= 90.1)),
        km: dist(bc.counterDistance), eKm: dist(bc.counterDistanceEDrive),
        speedAvg: ok(bc.speedAverage) ? bc.speedAverage / 10 : null, resetAt, active: v.activeResetLogic,
        raw: { digit, scale: pick(bc, ['consumptionCombustionAverageScale']), max: maxRaw, option: bc.resetOption, unit: pick(units, ['averageConsumptionCombustion', 'consumption']) },
    };
}

/** A consumption in one unit as US mpg (null where it can't be). */
function toMpg(v, unitNum) {
    if (typeof v !== 'number') return null;
    if (unitNum === 3) return v;
    if (unitNum === 2) return v * L_PER_GAL_US / L_PER_GAL_UK;
    if (unitNum === 1) return v > 0 ? (100 / v) * L_PER_GAL_US / KM_PER_MI : Infinity;
    if (unitNum === 4) return v * L_PER_GAL_US / KM_PER_MI;
    return null;
}
/** Litres over kilometres as US mpg. */
const mpgOf = (litres, km) => (litres > 0 ? (km / KM_PER_MI) / (litres / L_PER_GAL_US) : Infinity);

/**
 * Our own count for each mode, from its reset on: { [mode]: { resetAt, startKm, odoStart, odo, litres, lastLevel } }.
 * note(bc, level, odo): the newest bcDataAll (decoded), the tank's litres and the odometer's km (either may be null).
 * The state is plain JSON, kept by the app across restarts.
 */
class Tracker {
    constructor(state) { this.s = state && typeof state === 'object' ? state : {}; }
    state() { return this.s; }
    /** The tank went from a to b litres: what it used (a rise is a refuel: none). */
    static used(a, b) { return typeof a === 'number' && typeof b === 'number' && b < a ? a - b : 0; }
    note(bc, level, odo) {
        const lv = typeof level === 'number' && level > 0 && level < 255 ? level : null;
        const od = typeof odo === 'number' && odo > 0 && odo < 4294967295 ? odo : null;
        // every mode counts the fuel used: modes not on show keep counting from their own resets
        Object.keys(this.s).forEach((m) => {
            const e = this.s[m];
            if (lv !== null) { e.litres += Tracker.used(e.lastLevel, lv); e.lastLevel = lv; }
            if (od !== null) e.odo = od;
        });
        if (!bc || !bc.mode) return;
        let e = this.s[bc.mode];
        if (!e || (bc.resetAt && e.resetAt !== bc.resetAt) || (typeof bc.km === 'number' && typeof e.startKm === 'number' && bc.km + 0.5 < e.startKm)) {
            // first seen, or reset since: count from here; the mode's own distance then says how much was before us
            e = this.s[bc.mode] = { resetAt: bc.resetAt || null, startKm: typeof bc.km === 'number' ? bc.km : null, odoStart: od, odo: od, litres: 0, lastLevel: lv };
        }
        e.last = { avg: bc.avg, unit: bc.unit, unitNum: bc.unitNum, capped: bc.capped, km: bc.km, eKm: bc.eKm, at: Date.now() };
    }
    /** Our figure for a mode: { mpg, litres, km, cover (0-1, the mode's distance we saw), full } or null. */
    figure(mode) {
        const e = this.s[mode];
        if (!e || typeof e.odo !== 'number' || typeof e.odoStart !== 'number') return null;
        const km = e.odo - e.odoStart;
        const total = e.last && typeof e.last.km === 'number' ? e.last.km : null;
        // the mode's distance in the car's unit (km or mi): ours as a share of it
        const cover = total && total > 0 ? Math.min(1, (typeof e.startKm === 'number' ? (total - e.startKm) / total : 0)) : (e.startKm === 0 ? 1 : 0);
        return { mpg: km >= MIN_KM ? mpgOf(e.litres, km) : null, litres: e.litres, km, cover, full: cover >= FULL_COVER };
    }
}

module.exports = { decode, toMpg, mpgOf, Tracker, MODES, MODE_NAMES, UNITS, L_PER_GAL_US, KM_PER_MI };

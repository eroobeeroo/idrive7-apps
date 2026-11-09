'use strict';
/**
 * test_economy.js - eDrive Live's economy.js: the onboard computer's bcDataAll decoded (names or numbers, the
 * three services' shapes), the car's cap seen, unit conversions, and our own uncapped figure per mode (fuel
 * from the tank, distance from the odometer, from the mode's reset; refuels not counted; coverage).
 *   node kit/tools/test_economy.js
 */
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', '..', 'apps', 'edrive2', 'economy.js'));
let n = 0;
const check = (name, fn) => { fn(); n++; console.log('ok   ' + name); };
const reset = { year: 26, month: 11, day: 1, hour: 7, minute: 5, second: 0 };
const v3 = (o) => ({ activeResetLogic: 2, bcUnits: { averageConsumptionCombustion: o.unit || 3 }, maxValues: { maxValueAverageConsumptionCombustion: 900 },
    bcData3: { resetOption: o.opt, consumptionCombustionAverageDigit: o.digit, consumptionCombustionAverageScale: 7, counterDistance: o.km, counterDistanceEDrive: o.ekm || 0,
        speedAverage: 412, dateTimeReset: o.reset || reset } });

check('ResetLogic3: mode, figure, unit, distance, reset time', () => {
    const b = E.decode(v3({ opt: 2, digit: 412, km: 230, ekm: 120 }));
    assert.strictEqual(b.mode, 'REFUEL'); assert.strictEqual(b.modeName, 'Since refuelling');
    assert.strictEqual(b.avg, 41.2); assert.strictEqual(b.unit, 'mpg'); assert.strictEqual(b.capped, false);
    assert.strictEqual(b.km, 230); assert.strictEqual(b.eKm, 120); assert.strictEqual(b.resetAt, '2026-11-01 07:05'); assert.strictEqual(b.speedAvg, 41.2);
});
check('enum names as the binding may give them; the top of the gauge is the cap', () => {
    const b = E.decode(v3({ opt: 'CHARGE', unit: 'CONSUMPTION_US', digit: 900, km: 50 }));
    assert.strictEqual(b.mode, 'CHARGE'); assert.strictEqual(b.unitNum, 3); assert.strictEqual(b.capped, true);
});
check('ResetLogic (1): its older shape', () => {
    const b = E.decode({ activeResetLogic: 1, bcUnits: { consumption: 1 }, bcData: { resetOption: 1, consumptionAverage: 65, speedAverage: 300 } });
    assert.strictEqual(b.mode, 'INDIVIDUAL'); assert.strictEqual(b.avg, 6.5); assert.strictEqual(b.unit, 'L/100km');
    assert(Math.abs(E.toMpg(6.5, 1) - 36.19) < 0.01, 'L/100km to mpg');
});
check('wrapped as the binding may hand it over: in the field\'s name, or deeper; enums as { name, value }', () => {
    const b = E.decode({ bcDataAll: v3({ opt: { name: 'REFUEL', value: 2 }, digit: 412, km: 230 }) });
    assert.strictEqual(b.mode, 'REFUEL'); assert.strictEqual(b.avg, 41.2);
    assert.strictEqual(E.decode({ value: { x: v3({ opt: 1, digit: 300, km: 1 }) } }).mode, 'INDIVIDUAL');
    assert.strictEqual(E.decode({ nothing: 1 }), null);
});
check('ResetLogic.averageConsumption: the figure without the mode', () => {
    const a = E.decodeAverage({ averageConsumption: { consumptionCombustionCurrentDigit: 385, combustionUnit: 'CONSUMPTION_US' } });
    assert.strictEqual(a.avg, 38.5); assert.strictEqual(a.unitNum, 3); assert.strictEqual(a.unit, 'mpg');
});
check('ours since this app: from the tank and odometer alone, no mode needed', () => {
    const T = new E.Tracker();
    T.note(null, 40, 10000); T.note(null, 39, 10060); T.note(null, 38, 10130);
    const f = T.figure(E.APP);
    assert.strictEqual(f.litres, 2); assert.strictEqual(f.km, 130); assert(f.full);
    assert(Math.abs(f.mpg - E.mpgOf(2, 130)) < 1e-9);
});
check('units to US mpg', () => {
    assert(Math.abs(E.toMpg(50, 2) - 41.63) < 0.01, 'UK mpg'); assert.strictEqual(E.toMpg(40, 3), 40); assert(Math.abs(E.toMpg(15, 4) - 35.28) < 0.01, 'km/L');
    assert(Math.abs(E.mpgOf(3.785411784, 160.9344) - 100) < 1e-9, '1 gal over 100 mi');
});
check('ours: from the reset, refuels not counted, coverage whole', () => {
    const T = new E.Tracker();
    T.note(E.decode(v3({ opt: 1, digit: 0, km: 0 })), 40, 10000);           // reset now
    T.note(null, 39, 10050); T.note(null, 39, 10100); T.note(null, 60, 10120);   // a refuel: +21 L, not counted
    T.note(null, 58, 10200);
    T.note(E.decode(v3({ opt: 1, digit: 900, km: 124 })), 58, 10200);       // capped
    const f = T.figure('INDIVIDUAL');
    assert.strictEqual(f.litres, 3); assert.strictEqual(f.km, 200); assert(f.full && f.cover === 1);
    assert(Math.abs(f.mpg - E.mpgOf(3, 200)) < 1e-9 && f.mpg > 150, 'uncapped: ' + f.mpg);
});
check('ours: a mode first seen part way says how much it saw; a reset starts it again', () => {
    const T = new E.Tracker();
    T.note(E.decode(v3({ opt: 5, digit: 300, km: 1000 })), 40, 5000);
    T.note(E.decode(v3({ opt: 5, digit: 310, km: 1100 })), 38, 5100);
    let f = T.figure('LONGTERM');
    assert(!f.full && Math.abs(f.cover - 100 / 1100) < 1e-9, 'saw a tenth');
    T.note(E.decode(v3({ opt: 5, digit: 0, km: 0, reset: { year: 26, month: 11, day: 9, hour: 9, minute: 0 } })), 38, 5100);
    f = T.figure('LONGTERM');
    assert.strictEqual(f.litres, 0); assert.strictEqual(f.km, 0); assert(f.full, 'from its new reset');
    assert.strictEqual(f.mpg, null, 'nothing under 3 km');
});
check('ours: every mode counts the fuel, shown or not; state survives as JSON', () => {
    const T = new E.Tracker();
    T.note(E.decode(v3({ opt: 1, digit: 0, km: 0 })), 40, 100);
    T.note(E.decode(v3({ opt: 2, digit: 0, km: 0 })), 40, 100);
    T.note(null, 38, 180);
    const U = new E.Tracker(JSON.parse(JSON.stringify(T.state())));
    assert.strictEqual(U.figure('INDIVIDUAL').litres, 2); assert.strictEqual(U.figure('REFUEL').litres, 2); assert.strictEqual(U.figure('REFUEL').km, 80);
});
console.log(n + ' passed');

'use strict';
/**
 * indicators.js - the turn signals and day / night from the car's own enums, which the SOME/IP binding hands
 * over as their names (seen on a G05: "DAUER_BLINKEN_RECHTS_EIN", "TAG") or as numbers.
 */
const ACTIVE_LEFT = [7, 9, 18, 20, 22], ACTIVE_RIGHT = [8, 10, 19, 21, 23], ACTIVE_BOTH = [1, 5, 6, 11, 12, 13, 16, 17, 24, 25];
// the binding hands the enums over as their names (seen on a G05: "DAUER_BLINKEN_RECHTS_EIN"), or as numbers
const CONTROL = { BLINKEN_AUS: 0, TIPP_BLINKEN_LINKS_EIN: 1, TIPP_BLINKEN_RECHTS_EIN: 2, DAUER_BLINKEN_LINKS_EIN: 3,
    DAUER_BLINKEN_RECHTS_EIN: 4, BEIDSEITIGES_BLINKEN_EIN: 8 };
const ACTIVE = { BLINKEN_AUS: 0, CRASH_BLINKEN: 1, REVERSIER_BLINKEN: 2, QUITTIERUNGSBLINKEN_SCHAERFEN: 3,
    QUITTIERUNGSBLINKEN_ENTSCHAERFEN: 4, DWA_BLINKEN: 5, WARNBLINKEN_MANUELL: 6, DAUERBLINKEN_LINKS: 7, DAUERBLINKEN_RECHTS: 8,
    TIPPBLINKEN_LINKS: 9, TIPPBLINKEN_RECHTS: 10, UEBERFALLALARM: 11, FAS_WARNBLINKEN_AUSPRAEGUNG_1: 12, AUFFAHRWARNBLINKEN: 13,
    ANKUENDIGUNGSBLINKEN_OEFFNEN: 14, ANKUENDIGUNGSBLINKEN_SCHLIESSEN: 15, WARNBLINKEN_NACH_GEFAHRENBREMSUNG: 16,
    WARNBLINKEN_VON_RCP: 17, FAS_RICHTUNGSBLINKEN_LOWPRIO_LINKS: 18, FAS_RICHTUNGSBLINKEN_LOWPRIO_RECHTS: 19,
    FAS_RICHTUNGSBLINKEN_MIDPRIO_LINKS: 20, FAS_RICHTUNGSBLINKEN_MIDPRIO_RECHTS: 21, FAS_RICHTUNGSBLINKEN_HIGHPRIO_LINKS: 22,
    FAS_RICHTUNGSBLINKEN_HIGHPRIO_RECHTS: 23, FAS_WARNBLINKEN_AUSPRAEGUNG_2: 24, FAS_WARNBLINKEN_AUSPRAEGUNG_3: 25,
    ANKUENDIGUNGSBLINKEN_REMOTE_MOTORSTART: 26 };
const num = (x, names) => (typeof x === 'string' && x in names ? names[x] : x);

/** The turn signal direction from a StatusFunctionsIndicators(2) value: 'off' | 'left' | 'right' | 'both', or null
 *  when it says nothing. one(v, key) finds a field however the value is wrapped. */
function direction(c, a) {
    c = num(c, CONTROL); a = num(a, ACTIVE);
    let dir = null;
    if (c === 1 || c === 3) dir = 'left'; else if (c === 2 || c === 4) dir = 'right'; else if (c === 8) dir = 'both'; else if (c === 0) dir = 'off';
    if (dir === null || (dir === 'off' && typeof a === 'number' && a > 0 && a < 250)) {
        dir = ACTIVE_LEFT.indexOf(a) >= 0 ? 'left' : ACTIVE_RIGHT.indexOf(a) >= 0 ? 'right' : ACTIVE_BOTH.indexOf(a) >= 0 ? 'both' : a === 0 ? 'off' : dir;
    }
    return dir;
}
const DAY_NIGHT = { KEINE_AENDERUNG: 0, TAG: 1, NACHT: 2, SIGNAL_UNGUELTIG: 3 };
/** true night, false day, null unchanged / invalid. */
function night(x) { const c = num(x, DAY_NIGHT); return c === 2 ? true : c === 1 ? false : null; }

module.exports = { direction, night, num };

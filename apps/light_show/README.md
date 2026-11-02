# Light Show

Flashes the exterior lamps in patterns through the body controller's own lamp test functions (BDC, diagnostic
address 0x40), as BMW's SGBD for the G05 body controller (`BDC_G05`) describes them:

| What | Request | SGBD job |
| --- | --- | --- |
| one lamp output on / off | `2F E3 B5 03 <output> 01` / `00` | LICHT_AUSGANG_DIGITAL_STEUERN |
| that output back to the car | `2F E3 B5 00 <output>` | (return control to the ECU) |
| a lamp function for a time (lamp check fallback) | `2E D5 42 00 <function> <time, 10 ms>` | LEUCHTEN_FUNKTION |
| session / keep-alive | `10 03`, `3E 00` every 2 s, `10 01` at stop | |

Outputs and functions: `lamps.js` (TAB_LEUCHTEN_AUSGANG_DIGITAL_ARG / TAB_LEUCHTEN_FUNKTION_ARG). Nothing else can
be sent: `check()` refuses any other request before it reaches the transport.

## Pages

- **Light Show**: the pattern (Next pattern, or Settings), Start / stop, the lamps lit now.
- **Lamp check**: each lamp on for 1.2 s in turn (about 48 s, the order is the list on the page). A lamp the body
  controller refuses is left out of every pattern; run it again after a software update.

## Patterns

- **Emergency** (wig-wag, wig-wag + fogs, double flash, front and rear, rear only, corner strobe): only lamps that
  are normally off while driving (high beams, fog lights, turn signals, rear fog and reversing lights). Between
  flashes each lamp goes back to the car, so the low beams, tail lights and brake lights stay the car's own (the
  brake pedal works as always).
- **Show** (chase, sweep, everything, blink): any lamp, held dark between flashes. For a parked car.

## Safety

- Stop gives every lamp back and ends the diagnostic session.
- If the app goes away without stopping (closed, crashed, head unit restart), the body controller drops back to its
  default session a few seconds later (no tester present) and every lamp is the car's own again.
- **Only while parked** (setting, off for now): a pattern doesn't start, or stops, once the car moves (> 3 km/h).
  Meant to be on for a public light show release.
- **Stop by itself after** (setting): a time limit.

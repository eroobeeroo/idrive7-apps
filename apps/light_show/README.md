# Light Show

Flashes the exterior lamps in patterns through BMW's own test functions, as the SGBDs for the G05's body controller
(`BDC_G05`, diagnostic address 0x40) and LED headlight modules (`FLM02_L` / `FLM02_R`, 0x43 / 0x44) describe them:

| What | Request | SGBD job |
| --- | --- | --- |
| one lamp output on / off (body controller, every lamp, each side its own) | `2F E3 B5` + a layout the lamp check finds | LICHT_AUSGANG_DIGITAL_STEUERN |
| that output back to the car | `2F E3 B5 00 <output>` | (return control to the ECU) |
| a light function in one headlight (front lamps, one module a side) | `2E D6 DC 00 <function> <seconds>` (0 s: off) | FLM_FUNKTION_LICHTVERTEILUNG |
| a lamp function for a time (both sides, except the turn signals) | `2E D5 42 00 <function> <time, 10 ms>` | LEUCHTEN_FUNKTION |
| session / keep-alive | `10 03`, `3E 00` every 2 s, `10 01` at stop | |

The SGBD names the output request's arguments (output, on / off) but not its layout, and the G05 refused the two
obvious ones (`2F E3 B5 <output> 01`: out of range, `2F E3 B5 03 <output> 01`: wrong length). The lamp check tries
the layouts in `lamps.js` (LAYOUTS) on the rear left turn signal and keeps the first one taken; the page shows what the
body controller said to each. Without one, the front lamps go through their headlight module (one a side) and the
turn signals through their side's own lamp function.

Nothing else can be sent: `check()` refuses any other request, or a request to another unit, before it reaches the
transport.

## Pages

- **Light Show**: the pattern (Next pattern, or Settings), Start / stop, the lamps lit now.
- **Lamp check**: first the output layout (the rear left turn signal blinks a few times), then each lamp on for
  1.2 s in turn (about 50 s, the order is the list on the page): by its own output, else its headlight module, else
  its lamp function. A lamp that only works through a both-sides function is left out of every pattern (the turn
  signals are the exception: left and right are separate functions).

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

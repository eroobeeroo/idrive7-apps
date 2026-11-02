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
  1.2 s in turn (about 50 s, the order is the list on the page): front lamps by their headlight module first (on the
  G05's LED headlights the body controller takes their output requests and nothing lights), then by the body
  controller's output, else by the lamp function. Under each lamp: how it works, and whether it was given back. A lamp that only works through a both-sides function is left out of every pattern (the turn
  signals are the exception: left and right are separate functions).

## Patterns

- **Emergency** (wig-wag, wig-wag + fogs, double flash, front and rear, rear only, corner strobe): only lamps that
  are normally off while driving (high beams, fog lights, turn signals, rear fog and reversing lights). Between
  flashes each lamp goes back to the car, so the low beams, tail lights and brake lights stay the car's own (the
  brake pedal works as always).
- **Show** (chase, sweep, everything, blink): any lamp, held dark between flashes. For a parked car.

## What the lamp check measures

- **Output request layout**: `03 <output> <on/off> 00` on the G05 (the line at the bottom of the page).
- **Time byte**: whether that layout's last byte is an activation time - the rear fog light on with it set to 10, then
  1, its state read from the body controller (`22 E3 B9`, LICHT_AUSGANG_DIGITAL: a byte an output, by its number)
  until it goes dark by itself. If it does, every output is sent with a time and goes back to the car by itself:
  no give-back request (the G05 refuses every form of it: "conditions not correct").
- **Read on / read OFF** under each lamp: what the body controller says the output is while it should be lit.
- (The high beams use Fernlicht Modus 1a: an earlier check's tries in the left headlight found it - Fernlichtblinken
  was taken and nothing lit.)
- **Flash tries A-E** (2.5 s each): the car's own flashing modes, one request each - the left headlight's Panik-Modus,
  alarm flashing and hold-up alarm, the body controller's special flashing and reversing flash. The driver says which
  flashed. (The car takes one request at a time, ~300 ms each - several sent together, only the first is taken - so
  a fast strobe needs a mode that flashes by itself.)
- Afterwards the brake lights are read: still on (pedal not pressed) = stuck, a red bar on both pages.

A **light show** starts dark: lamps on before it (read from the body controller) are held off while it runs - never
the brake lights, and tail / plate lights only when outputs are timed. Emergency patterns leave other lamps alone.

## Safety

- A lamp the car normally keeps on (brake, tail, plate) is never held dark. If the body controller won't take one
  back (a G05 kept its brake lights on after 0.2.0's check: ending the session did not give them back), the app
  tries every give-back form (`releases()` in lamps.js), and if none is taken it marks the lamp stuck: a red bar on
  both pages names it. **Give lamps back** (button) tries every form on every output, also for lamps held from an
  earlier run; if a lamp still stays on, switching the car off and on gives it back.

- Stop gives every lamp back and ends the diagnostic session.
- If the app goes away without stopping (closed, crashed, head unit restart), the body controller drops back to its
  default session a few seconds later (no tester present) and every lamp is the car's own again.
- **Only while parked** (setting, off for now): a pattern doesn't start, or stops, once the car moves (> 3 km/h).
  Meant to be on for a public light show release.
- **Stop by itself after** (setting): a time limit.

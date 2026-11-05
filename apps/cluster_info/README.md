# Cluster Info

A small panel of live values over the Waze map in the instrument cluster or on the HUD (with
[Waze on cluster](https://github.com/eroobeeroo/idrive-apps)), and turn signal arrows on the HUD. For any car.

- **Its own values from the car:** engine oil and coolant temperature, boost (the car's sport display signal),
  engine speed and torque, the turn signals, day / night (the HUD
  panel and arrows are dimmer at night), the driver profile (each driver keeps their own settings).
- **Values from other apps:** eDrive Live provides the battery's power (the kW meter and its bar) and the
  battery temperature. Any app can add values the same way. Optionally (Settings > Thin kW bar along the
  bottom) a slim centre-zero kW bar runs along the panel's bottom edge: use to the right, recuperation to the
  left in green.
- **Where:** where the Waze map is (cluster or HUD), or always on the HUD; at the bottom or top of the map.
  Shown only while the map is (or, on the HUD, while there is something to show), so it never holds the
  cluster or HUD on its own.
- **Its page** shows the panel as it is now, larger, and whether each source works (turn signals, day / night,
  driver profile, the apps providing, the cluster renderer, the Waze map).

## Providing values from your app

Write `/dev/shm/cluster-info/<your app id>.json` a few times a second while you have fresh values, replacing
it whole (write a temporary file, then rename it over it):

```json
{ "v": 1, "t": 1793560000000, "app": "My app",
  "power": { "kw": -1.2, "outMax": 100, "inMax": 60, "old": false },
  "values": { "battery": { "c": 24.5 }, "oil": { "c": 81 } } }
```

`t` is `Date.now()` when written; a file older than 3 s counts as gone. `power` is optional (the kW meter);
`values` are temperatures in °C under the names the settings offer (`battery`, `oil`, `coolant`), or
`{ "text": "...", "label": "..." }`. The car's own oil and coolant temperatures win over a provider's.

While its panel is up, Cluster Info writes `wanted.json` in the same folder: `{ "t": ..., "power": true,
"values": ["battery", "oil"] }`. Read it to know when to read fast and write (and let the car sleep
otherwise); eDrive Live does (`apps/edrive2/provider.js`).

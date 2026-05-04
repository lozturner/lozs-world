# Tuning Loz's World

## Where the dials live

`public/config.json`

Edit it in Notepad (right-click -> Edit, or any text editor). Save. Refresh the browser tab. Done.

## Mouse feel

| Key                         | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `mouse.sensitivity`         | Master speed multiplier. 0.3 = slow & precise, 1.0 = fast.              |
| `mouse.sensitivityX`        | Horizontal-only multiplier. Leave at 1.0 unless you want asymmetric.    |
| `mouse.sensitivityY`        | Vertical-only multiplier. Drop to 0.7 if pitch feels twitchy.           |
| `mouse.invertY`             | `true` = pull down to look up (flight-sim). `false` = normal FPS.       |
| `mouse.smoothing`           | 0 = instant (default). 0.5 = soft. 0.85 = silky but laggy.              |
| `mouse.maxLookUpDeg`        | How far you can look up before the camera clamps. 85 = normal.          |
| `mouse.maxLookDownDeg`      | Same for looking down.                                                  |

## Walk feel

| Key                         | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `movement.walkSpeed`        | Default WASD speed. 4.5 m/s is "brisk walk".                            |
| `movement.sprintSpeed`      | Hold Shift speed. 9.0 m/s is "jog".                                     |
| `movement.verticalSpeed`    | Space (rise) / Ctrl (fall) speed. 5.4 m/s.                              |

## World

| Key                         | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `world.fovDeg`              | Field of view in degrees. 70 is comfortable. 90 is fish-eye.            |

## Quick recipes

- **"Mouse too fast/sketchy"**: drop `sensitivity` to `0.3`. If still bad, set `smoothing` to `0.4`.
- **"Mouse feels laggy after smoothing"**: set `smoothing` back to `0`, raise `sensitivity` instead.
- **"Vertical jumpy, horizontal fine"**: lower `sensitivityY` to `0.7` while keeping `sensitivityX` at `1.0`.
- **"I'm a flight-sim person"**: set `invertY` to `true`.
- **"I want WoW-style fast turning"**: `sensitivity` to `1.2`, `smoothing` to `0`.
- **"Walking is too slow / fast"**: edit `walkSpeed` and `sprintSpeed`.

## Diagnostics

Open DevTools (F12) and type:
```
lozsworld.CONFIG
```
to see the live values. To experiment without editing the file, you can also do:
```
lozsworld.CONFIG.mouse.sensitivity = 0.3
```
and the change applies immediately. To make it permanent, copy the value into `config.json` and refresh.

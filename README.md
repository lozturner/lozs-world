# Loz's World

A first-person 3D environment that runs entirely on `localhost`. Walk around,
sit at five Tron-style monitor desks, drag any `.stl` / `.obj` / `.glb` / `.gltf` / `.fbx` / `.dae` / `.3ds` / `.ply` file
into the window, grab and move it with your mouse, and turn any object into
a live web screen. Six simultaneous screens, GPU-accelerated, no install
beyond Node.

## Quickstart

1. Install Node.js LTS from https://nodejs.org (one-time).
2. Double-click **`run.bat`**. The first run does `npm install` (~30 sec),
   then starts the server and opens your browser at http://localhost:7777.
3. Click **ENTER**, click anywhere to capture the mouse, walk around.

## Controls

| Key                 | Action                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `W` `A` `S` `D`     | Move                                                                  |
| Mouse               | Look                                                                  |
| `Shift`             | Sprint                                                                |
| `Space` / `Ctrl`    | Rise / fall                                                           |
| `E`                 | Assign a URL to whatever's in your crosshair (auto-attaches a screen) |
| `R`                 | Reload that screen                                                    |
| `F`                 | Toggle screen on/off for the object you're looking at (any object)    |
| `G`                 | Grab the object in view; press G again to drop. Move it with mouselook |
| `Tab`               | Click into a screen (release mouse + activate iframe). Tab/Esc back   |
| `K`                 | Open / close the asset library panel                                  |
| `Esc`               | Release the mouse                                                     |
| Drag a file         | Drop `.stl` `.obj` `.glb` `.gltf` `.fbx` `.dae` `.3ds` `.ply` files in front of you |

## What you'll find when you load in

A wide-arc room of five desks, each with its own screen. Chairs in front of
each desk. A neon staircase against the back-left wall. Three decorative
glow-edge blocks for vibe. The grid floor and rim lights are pure Tron.

You spawn in the centre, facing the desks.

## The asset library (`K`)

The slide-in panel on the left lists every model file inside
`public/assets/`. Drop your `.stl`, `.obj`, `.glb`, `.gltf`, `.fbx`, `.dae`, `.3ds`, `.ply` files in there,
press REFRESH (or close+reopen with `K`), and they'll appear with two
spawn buttons:

- **Spawn** - drops the model in front of your camera as a placed Item.
- **Spawn + Screen** - same, but immediately attaches a live web screen to
  its front face so you can paste a URL into it.

You can also drag a file straight onto the window without ever using the
library; it'll spawn at your camera and pick the right loader by extension.

## Six screens, any object

Up to six screens can exist at once. The five desks already account for
five (each is a screen-bearing object); promoting any other object to a
screen with `F` will use your sixth slot. Detaching a screen frees its
slot. The HUD shows current usage at the bottom-left.

The screen geometry is computed from the object's local-space bounding box,
so it works on any shape - a chair, a block, a 200-triangle imported model.

## How the live web pages work

Browsers refuse to embed many sites in iframes due to `X-Frame-Options:
DENY` or `Content-Security-Policy: frame-ancestors`. So `server.js` runs a
same-origin proxy on `/proxy?u=<url>` that strips those headers. The world's
iframes load `/proxy?u=https://example.com/...`. About 95% of the web works
straight away.

## Memory and performance

- `MAX_ITEMS = 64`. When exceeded, the oldest non-fixed Item is disposed
  (geometry, materials, iframe DOM all freed via Three.js's `.dispose()`).
- `MAX_SCREENS = 6`. Promoting a 7th object to a screen refuses with a HUD
  warning instead of silently failing.
- All grabbed-object updates use camera-relative offsets so motion never
  accumulates floating-point error over long sessions.
- `/api/assets` is polled lazily (only when you open or refresh the
  library), not on a timer - the world burns zero idle CPU on disk I/O.

On an integrated-graphics i7 / 16 GB / fibre, five active screens stay
above 60 FPS at 1080p in our tests. With a discrete GPU you can run all
six and a dozen placed objects without breaking a sweat.

## Persistence (schema-versioned)

Layout is saved to localStorage as `lozsworld.layout.v2`. The schema
records:
- which fixed desks have URLs
- which placed assets exist (sourceUrl + transform matrix)
- whether each placed asset has a screen and its URL

Reload the page and your room comes back exactly as you left it. The schema
is versioned so v3 can migrate forward without losing your work.

## Architecture at a glance

```
Browser
 +-- WebGL canvas  (Three.js)        room, lights, desks, chairs, stairs, blocks, grid
 +-- CSS3D layer   (CSS3DRenderer)   up to 6 iframes in 3D space, sharing the camera
 +-- First-person  (PointerLockControls + WASD)
 +-- Item system   (per-object grab, screen, dispose)

Node server (server.js, port 7777)
 +-- Static  /              public/                                    (the world)
 +-- Proxy   /proxy?u=...   strips X-Frame-Options + CSP frame-ancestors
 +-- API     /api/assets    lists files in public/assets/
 +-- Static  /assets/...    streams the model files to the loader
```

## Files

- `server.js` - express + http-proxy-middleware + assets API (~110 lines)
- `package.json` - two dependencies
- `run.bat` - one-click launcher (`npm install` + `node server.js`)
- `public/index.html` - page shell, importmap for Three.js r0.160
- `public/styles.css` - HUD, overlay, library
- `public/world.js` - the entire client (~1000 lines, the meat of the app)
- `public/assets/` - drop your model files here

## Customising the room

Open `public/world.js`. Constants near the top:

- `MONITOR_COUNT`, `MONITOR_RADIUS`, `ARC_DEG` - desk arrangement
- `IFRAME_DOM_W`, `IFRAME_DOM_H`, `IFRAME_SCALE` - screen pixel size & world scale
- `NEON_CYAN`, `NEON_MAGENTA`, `NEON_AMBER`, `NEON_LIME` - palette
- `MAX_ITEMS`, `MAX_SCREENS` - resource caps
- `ROOM_SIZE`, `ROOM_HEIGHT` - room dimensions

The pre-loaded objects come from `makeDeskItem`, `makeChairItem`,
`makeStaircaseItem`, `makeDecorBlock`. Copy any of them to add a new piece
of furniture - they all use the same `Item` class, so any procedural mesh
you add is grab-able and screen-able for free.

## Diagnostics

Open the browser DevTools console. `window.lozsworld` exposes:

```js
lozsworld.items                 // every live Item
lozsworld.scene, .camera        // Three.js objects
lozsworld.countScreens()        // current number of attached screens
lozsworld.saveLayout()          // force-save now
lozsworld.refreshLibrary()      // re-scan public/assets/
```

Useful when adding features without restarting.

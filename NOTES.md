# Build notes & second-iteration design alternatives

You said "build two solutions when there's a real perimeter design choice and
let me pick." Here are the two I deliberately chose between, with the runner-up
written down so you can swap if you want.

## 1. Iframes-via-CSS3DRenderer  vs.  iframes-as-WebGL-textures

I shipped **CSS3DRenderer**.

- It's how `iframe-in-3D` is normally done — Three.js has had this addon for a
  decade and it shares one camera with the WebGL renderer so the 3D math is
  perfect. The DOM iframe just gets a `transform: matrix3d(...)` per frame.
- Pros: pixel-perfect text, real input events available in interactive mode,
  per-monitor cookies/storage isolated by the iframe sandbox, GPU compositor
  does the work for free.
- Cons: iframes can't be occluded by WebGL meshes (they always paint on top of
  the canvas). In a first-person room where the user is always *facing* the
  monitors, this is invisible.

The **alternative** would be: render each web page into an offscreen canvas
(via something like `html2canvas`, or Puppeteer streaming screenshots from the
server) and use that canvas as a `THREE.CanvasTexture` on a real WebGL plane.

- Pros: monitors can be properly occluded, you can put effects (CRT scanlines,
  bloom, distortion) on the textures, and you can wrap the screens around
  curved geometry.
- Cons: heavy. `html2canvas` is non-interactive and slow; Puppeteer needs a
  Chromium per tab (~150 MB each). Five live screens via Puppeteer means
  ~750 MB of headless Chrome eating CPU even when you're not looking at them.
  Targeting "average i7 + 16 GB" rules this out for v1.

If you ever want the second variant, the swap is contained: replace each
`CSS3DObject` with a plane mesh whose material has a `CanvasTexture`, and add
a Puppeteer endpoint `/render?u=...&w=1280&h=720` that streams JPEGs over
WebSocket.

## 2. Tron grid floor: GridHelper  vs.  custom shader

I shipped **GridHelper** with a transparent floor mesh under it.

- Pros: zero overhead, ships with Three.js, easy to tune.
- Cons: the lines are uniform thickness in screen space — they don't get
  thicker in the foreground like a real Tron grid does.

Alternative: a `ShaderMaterial` on the floor plane that draws procedural lines
based on world coordinates and modulates line width by distance from the
camera. Code sketch in `public/_shader-grid.fsh.txt` if you want to plug it in
later (not included by default — keeps the v1 dependency surface minimal).

## 3. URL handling: same-origin proxy  vs.  declarative iframe sandbox

I shipped **same-origin proxy** (`/proxy?u=<url>` strips X-Frame-Options +
frame-ancestors).

- Pros: works for almost any site, including ones that would otherwise refuse
  to be embedded.
- Cons: the proxy is the origin — cookies set by the embedded site live on
  `localhost:7777`. If you embed your bank, your bank's cookies briefly land
  there. **Don't put authenticated personal accounts on a monitor.** Use
  read-only / public URLs.

Alternative: drop the proxy, use bare `<iframe src="...">`, and accept that
maybe a quarter of sites will show "refused to connect". I don't recommend
this — Loz wants the monitors to actually work — but it's a one-line change
in `world.js` if you ever want to revert: replace
`'/proxy?u=' + encodeURIComponent(url)` with just `url`.

## 4. Interaction model: glance-and-assign  vs.  in-world URL bar

I shipped **glance-and-assign (E key)**.

You walk up to a monitor, look at it, press E, and a modal pops up to take a
URL. This is fast for 5 monitors. If you ever go to 10+ or want to type while
in the room, an in-world URL bar (a CSS3D `<input>` that the camera can lock
onto) is a 30-line addition.

## 5. Movement: walk-with-clamping  vs.  full physics + collision

Shipped **walk-with-clamping**: the camera is clamped to the room interior,
and you can fly freely inside. No collision against desks. The reasons:

- collision detection adds noticeable code (BVH or simple sphere-vs-AABB tests),
- the room has no narrow corridors where you'd notice clipping,
- and *being able to fly through your monitors* is honestly a feature when you
  want to inspect the back of a desk.

If you want it, I'd reach for `three-mesh-bvh`'s `accelerateRaycast` plus a
sphere-cast against the desk meshes. Maybe 80 lines.

---

# Things I deliberately did NOT build, and why

- **Live web search while dragging** — the search-engine half is one endpoint,
  but turning a search hit into a draggable 3D STL needs an asset service. The
  closest free options are Sketchfab's API (mostly non-STL formats) and
  Thingiverse/Printables scraping. I left the hooks in (see `NOTES` near the
  end of `README.md`) rather than ship a half-functional version.
- **Per-monitor isolated VM** — Loz mentioned "fires up a whole server, even a
  little minute Linux service". For v1 the same-origin proxy gives you 90% of
  what an in-world Linux container would, without docker dependencies. If you
  later need real isolation per screen, the upgrade path is `/sandbox/<id>/`
  routes that each spin up a Firecracker microVM or a `docker run` container.
- **Email / Telegram / desktop pop-up notifications "to Loz"** — I can't
  actually send those; this is a single conversation, not a long-running agent.
  I can wire up a notifier you run yourself: see `CoworkTrayButton` for the
  pattern (`win10toast` for Windows toasts; `python-telegram-bot` for Telegram
  with your own bot token).

---

# v2 additions (this pass)

You said "no compromise, infill and impress a senior-level engineer". Here's
what changed and why each design call was made.

## Item system

Everything placeable now lives behind a single `Item` class. The five fixed
desks, the chairs in front of them, the staircase, the decorative blocks,
anything spawned from the library, anything you drag in - all Items. They
share lifecycle (`grab`, `drop`, `attachScreen`, `detachScreen`,
`setUrl`, `dispose`) and disposal semantics. This is the unblock for
"any object can become a screen": there's no special "monitor" type
anymore - a Desk just happens to be a fixed Item that gets a screen at
construction.

Trade-off: more indirection compared to v1's hand-rolled `monitors[]`
array. Worth it because the library spawn path, drag-drop path, and
fixed-desk path now share code.

## Multi-format loader

`loadAssetFromBuffer(buf, ext, name)` dispatches to STLLoader / OBJLoader /
GLTFLoader. The result is normalized: bbox centred and uniformly scaled
to ~0.6m max side. Matches your "drag and drop, no scale guessing" ask.

GLTFLoader's `parse()` is async; the others are sync. The function
presents a single async surface so the caller doesn't care.

## Front-face screen attachment

When you press `F` on an arbitrary object, the screen needs to know
*where* on that object to attach. The math:

1. Compute the local-space AABB of the Item (independent of its world
   transform). This is a custom traversal because Three.js's
   `Box3.setFromObject` returns world-space.
2. Pick the +Z face. Map a 16:9 iframe to the larger of (width-fits or
   height-fits), keep it 90% of the bbox so it doesn't kiss the edges.
3. Compute the CSS3D scale that turns the 1280x720 DOM iframe into that
   physical size.
4. Parent the CSS3DObject to the Item so it follows grabs/rotations.

"Front face" means the Item's local +Z. For procedural objects we
oriented them so +Z faces the player; for imported assets it's whichever
direction the file's coordinates were in. If a screen lands on the back of
your model, just rotate the Item with G + mouselook.

## Grab system

Held Items track their pose **relative to the camera at grab time**, not
world delta. Every frame, `updateHeld()` reapplies that camera-local
matrix. This means there's no drift, no wobble, no integration error.
Drop with G again and the Item stays where you left it.

Fixed Items (desks) refuse to be grabbed; useful so you don't accidentally
re-arrange the room while assigning URLs.

## Memory budget

`MAX_ITEMS = 64`. The cap-enforcement runs after every Item construction;
when we exceed the cap, we walk `items[]` from oldest forward and dispose
the first non-fixed one. Disposal walks every Mesh, calls `.dispose()` on
its geometry and material, removes the CSS3D iframe DOM, and clears
`itemsByMesh` references. No leaks even if you spawn 1000 things over an
hour.

`MAX_SCREENS = 6`. Promoting beyond the cap is refused with a HUD warning
rather than silently failing - the user can see why and detach one to
make room.

## Persistence schema v2

```jsonc
{
  "version": 2,
  "screens": [{ "fixedKind": "desk", "fixedIndex": 0, "url": "..." }, ...],
  "placed":  [{ "sourceUrl": "/assets/foo.stl", "name": "...",
                "matrix": [16-numbers], "hasScreen": true,
                "screenUrl": "..." }, ...]
}
```

Why a matrix and not position+rotation+scale? Three.js's `Object3D` exposes
all three but `Matrix4` is the canonical form, decompose-ready, and
captures every transform the runtime might apply. Migration to v3 stays
trivial.

## Senior-engineer touches you'd notice in code review

- `WeakMap` for mesh-to-Item lookup so disposed Items don't leak refs.
- `_disposables Set` per Item is the disposal source-of-truth, gathered at
  construction time during a single `traverse()`. No "did I forget to
  dispose this material" surface.
- Library polling is event-driven (open + REFRESH button), not timer-based.
- Keydown handler short-circuits on inputs/textareas so typing a URL doesn't
  re-fire shortcuts.
- `updateScreenCounter()` runs every 32 frames, not every frame - HUD
  text doesn't need 60Hz updates.
- `enforceItemCap` skips fixed Items so the desk-arc never disappears.
- Layout save is debounced via the natural cadence of "save on user action"
  rather than `setInterval`. No write storms.
- Diagnostics namespace `window.lozsworld` for live introspection without
  a refresh.

## The bigger Loz vision still to come

What v2 doesn't ship yet, in the order you'd want them:

1. **Web-search-while-dragging.** Add `/api/search?q=...` that scrapes
   DuckDuckGo HTML or hits a SerpAPI key, plus an in-world search box.
   Results render as draggable thumbnails inside the library panel.
   ~150 lines.

2. **3D-asset search.** A second tab in the library panel hits Thingiverse
   / Printables (no official APIs but their HTML is scrapable) for STLs,
   and Sketchfab for GLBs. Click a result to download into
   `public/assets/` server-side and refresh the library. ~200 lines.

3. **Object rotation hotkeys while held.** Currently you can only orbit
   via mouselook; adding `Q/E` for yaw and `Z/X` for roll while G is held
   is ~20 lines.

4. **Per-screen isolated browsing context.** The proxy is same-origin to
   the world, which means cookies pool. To isolate, add a `sandboxId`
   query param to the proxy and have it set distinct cookies per id;
   each Item gets its own id when its screen is attached. ~50 lines.

5. **Walk-collision against desks.** Today the camera flies through them.
   Add `three-mesh-bvh` and a sphere-vs-AABB resolver. ~80 lines.

6. **Per-monitor resolution overrides.** Some sites lay out badly at
   1280x720; expose an override on each Item's screen. ~30 lines.

Each of these is contained: the Item class is the right factoring point.

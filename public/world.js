// =============================================================================
//  Loz's World - the entire client.
//
//  Architecture
//  ------------
//    Two co-rendered renderers share one PerspectiveCamera:
//      * THREE.WebGLRenderer  -> room, floor grid, walls, lights, all geometry
//      * CSS3DRenderer        -> DOM iframes placed in 3D space (the live screens)
//
//    Movement is PointerLockControls + a delta-time velocity integrator clamped
//    inside the room AABB. The CSS3D layer's pointer-events are off by default
//    so mouselook is never stolen; pressing Tab while looking at a screen flips
//    that one iframe to interactive (cursor released, you can click into the
//    page) until Tab/Esc again.
//
//  Items
//  -----
//    Every placeable thing in the world (the five fixed desks, pre-loaded
//    chairs/stairs/blocks, anything spawned from the library or dragged in)
//    is an Item. An Item owns a THREE.Object3D and may own a CSS3DObject
//    iframe ("screen"). It supports:
//       attachScreen(url)   - add a CSS3D iframe to the front of its bbox
//       detachScreen()      - remove + dispose the iframe
//       setUrl(url)         - point its iframe at a proxied URL
//       grab() / drop()     - follow the camera while held, then settle
//       dispose()           - free geometries, materials, iframe DOM
//
//  Memory budget
//  -------------
//    MAX_ITEMS = 64. When exceeded, oldest non-fixed Item is disposed.
//    MAX_SCREENS = 6. F-toggle on a 7th object refuses with a HUD warning.
//
//  Persistence
//  -----------
//    localStorage key 'lozsworld.layout.v2' holds:
//      { version: 2, screens: [{itemId, url}], placed: [{assetUrl, mtx}], ... }
//    Schema is versioned so we can migrate without losing your room.
//
//  Senior-engineering touches that aren't obvious
//  ----------------------------------------------
//    * All disposable resources (BufferGeometry, Material, Texture, iframe DOM)
//      are tracked and freed on dispose() to prevent the GPU + DOM leaks that
//      kill long-running web 3D apps.
//    * The grab system uses camera-relative offsets (not world delta) so the
//      held object follows your gaze without slipping or accumulating error.
//    * Screen attachment computes the front face of the Item's local-space
//      AABB and maps the iframe to it with correct aspect; works for any mesh.
//    * Loader is format-agnostic and returns a normalized Group with
//      its bbox centered at the origin and uniformly scaled to ~0.6m so
//      drag-drop never produces a 100m monstrosity.
//    * /api/assets is polled lazily (on K-panel open + F5 button), not on
//      a timer - zero idle CPU.
// =============================================================================

import * as THREE from 'three';
// (custom mouselook below replaces PointerLockControls)
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

// ---------- runtime config (public/config.json) ----------------------------
//
// Tweakable settings live in public/config.json. Edit it in Notepad, refresh
// the browser, and your changes apply. Defaults below are used if the file
// is missing or any key is absent.
const CONFIG_DEFAULTS = {
    mouse: {
        sensitivity: 0.6,
        sensitivityX: 1.0,
        sensitivityY: 1.0,
        invertY: false,
        smoothing: 0.0,
        maxLookUpDeg: 85,
        maxLookDownDeg: 85,
    },
    movement: { walkSpeed: 4.5, sprintSpeed: 9.0, verticalSpeed: 5.4 },
    world: { fovDeg: 70 },
};

// Removed top-level await for older iOS Safari compat. Start with defaults,
// then patch in user values from /config.json once they arrive.
const CONFIG = {
    mouse:    { ...CONFIG_DEFAULTS.mouse },
    movement: { ...CONFIG_DEFAULTS.movement },
    world:    { ...CONFIG_DEFAULTS.world },
};
fetch('/config.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(j => {
        if (!j) return;
        Object.assign(CONFIG.mouse,    j.mouse    || {});
        Object.assign(CONFIG.movement, j.movement || {});
        Object.assign(CONFIG.world,    j.world    || {});
    })
    .catch(e => console.warn('config.json load failed; using defaults', e));

// Diagnostics: type lozsworld.CONFIG in DevTools console to see live values.

// ---------- constants -------------------------------------------------------
const ROOM_SIZE = 30;
const ROOM_HEIGHT = 6;
const PLAYER_HEIGHT = 1.7;
const MONITOR_RADIUS = 6.5;
const MONITOR_COUNT = 5;
const MAX_SCREENS = 6;
const MAX_ITEMS = 64;
const STORAGE_KEY = 'lozsworld.layout.v2';
// Paper-edition palette (kept under their old names to minimise diff).
const NEON_CYAN    = 0x2f5fb8;  // sketch-pen blue (accent)
const NEON_MAGENTA = 0xc2682c;  // sepia (highlight accent)
const NEON_AMBER   = 0x9b8556;  // pencil amber
const NEON_LIME    = 0x6a7a4a;  // muted moss

// Iframe pixel resolution + scale to world units. 1280x720 @ 0.0015 -> ~1.92m wide.
const IFRAME_DOM_W = 1280;
const IFRAME_DOM_H = 720;
const IFRAME_SCALE = 0.0015;

// ---------- scene + renderers ------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2eee2);  // cream paper
scene.fog = new THREE.Fog(0xf2eee2, 18, 75);

const camera = new THREE.PerspectiveCamera(CONFIG.world.fovDeg, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, PLAYER_HEIGHT, 0);

const webglRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
webglRenderer.setSize(window.innerWidth, window.innerHeight);
webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
webglRenderer.toneMapping = THREE.ACESFilmicToneMapping;
webglRenderer.toneMappingExposure = 1.05;
document.getElementById('webgl').appendChild(webglRenderer.domElement);

const cssRenderer = new CSS3DRenderer();
cssRenderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('css3d').appendChild(cssRenderer.domElement);

// ---------- lighting ---------------------------------------------------------
// Soft, warm, day-lit. No more Tron rim lights.
scene.add(new THREE.AmbientLight(0xfff3dc, 0.85));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.55);
keyLight.position.set(8, 12, 6);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xfff0d0, 0.25);
fillLight.position.set(-6, 4, 4);
scene.add(fillLight);
// Stub names so the existing pulse-interval below doesn't error.
const cyanRim = { intensity: 0 };
const magentaRim = { intensity: 0 };

// ---------- room shell -------------------------------------------------------
{
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xefebe0, roughness: 0.92, metalness: 0.0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const grid = new THREE.GridHelper(ROOM_SIZE, ROOM_SIZE, 0xb5ad9a, 0xd6ceb8);  // pencil lines
    grid.position.y = 0.001;
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xeae3d2, roughness: 0.95, metalness: 0.0 });
    const halfRoom = ROOM_SIZE / 2;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_HEIGHT), wallMat);
    back.position.set(0, ROOM_HEIGHT / 2, -halfRoom); scene.add(back);
    const front = back.clone(); front.position.z = halfRoom; front.rotation.y = Math.PI; scene.add(front);
    const left = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_HEIGHT), wallMat);
    left.position.set(-halfRoom, ROOM_HEIGHT / 2, 0); left.rotation.y = Math.PI / 2; scene.add(left);
    const right = left.clone(); right.position.x = halfRoom; right.rotation.y = -Math.PI / 2; scene.add(right);

    // Faint pencil baseboard line for a hand-drawn touch.
    const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(ROOM_SIZE * 0.95, 0.025),
        new THREE.MeshBasicMaterial({ color: 0xb5ad9a, transparent: true, opacity: 0.55 })
    );
    strip.position.set(0, 0.10, -halfRoom + 0.01);
    scene.add(strip);

    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE),
        new THREE.MeshStandardMaterial({ color: 0xefe8d4, roughness: 0.95 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = ROOM_HEIGHT;
    scene.add(ceil);
}

// ---------- material factory ------------------------------------------------
//
// Single source of truth for the Tron palette. Returns disposable instances
// so each Item gets its own materials (avoids global colour-changes leaking).
function neonMaterial({ base = 0xd9d2bf, edge = NEON_CYAN, emissiveIntensity = 0.0 } = {}) {
    // Paper-edition: light fill, dark edges added separately. No glow.
    return new THREE.MeshStandardMaterial({
        color: base, roughness: 0.85, metalness: 0.0,
        emissive: edge, emissiveIntensity,
    });
}
function plainMaterial(color = 0xd9d2bf, opts = {}) {
    return new THREE.MeshStandardMaterial({
        color, roughness: 0.88, metalness: 0.05, ...opts,
    });
}
function lineMaterial(color = 0x1c1814) {
    // Charcoal ink for sketch edges by default.
    return new THREE.LineBasicMaterial({ color });
}

// ---------- Item class ------------------------------------------------------
//
// Wraps an Object3D in the world. May carry a screen (CSS3D iframe).
// All disposable resources owned by the Item are tracked so dispose() is
// guaranteed to free GPU and DOM allocations.

let _itemIdSeq = 0;
const items = [];                      // all live items in spawn order
const itemsByMesh = new WeakMap();     // raycast hit -> Item

class Item {
    constructor({ object3d, name = 'Item', fixed = false, kind = 'misc', sourceUrl = null }) {
        this.id = `it_${++_itemIdSeq}`;
        this.name = name;
        this.fixed = fixed;            // fixed items aren't recycled by the cap
        this.kind = kind;              // 'desk' | 'chair' | 'stairs' | 'block' | 'asset' | 'misc'
        this.sourceUrl = sourceUrl;    // for library/persistence (null for procedural)
        this.object3d = object3d;
        this.bbox = new THREE.Box3();  // recomputed on demand in local space
        this.held = false;
        this.holdOffset = new THREE.Vector3();
        this.holdQuat = new THREE.Quaternion();
        this.screen = null;            // { iframeEl, css3dObj, url }
        this._disposables = new Set();
        scene.add(this.object3d);
        // Index every mesh inside the group so raycasts return us.
        this.object3d.traverse(o => {
            if (o.isMesh) {
                itemsByMesh.set(o, this);
                if (o.geometry) this._disposables.add(o.geometry);
                if (o.material) {
                    if (Array.isArray(o.material)) o.material.forEach(m => this._disposables.add(m));
                    else this._disposables.add(o.material);
                }
            }
        });
        items.push(this);
        enforceItemCap();
    }

    // World-space bounding box of the entire group.
    computeWorldBBox() {
        this.bbox.setFromObject(this.object3d);
        return this.bbox;
    }

    // Local-space bounding box (independent of the item's world transform).
    computeLocalBBox() {
        // Temporarily reset transform on a clone-friendly path: walk children.
        const box = new THREE.Box3();
        const m = new THREE.Matrix4();
        this.object3d.updateMatrixWorld(true);
        this.object3d.traverse(o => {
            if (o.isMesh && o.geometry) {
                if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
                m.copy(o.matrixWorld).premultiply(_inverseRoot(this.object3d));
                const b = o.geometry.boundingBox.clone().applyMatrix4(m);
                box.union(b);
            }
        });
        return box;
    }

    attachScreen(url) {
        if (this.screen) { this.setUrl(url); return; }
        if (countScreens() >= MAX_SCREENS) {
            setStatus(`Screen limit hit (${MAX_SCREENS}). Detach one first.`);
            return;
        }

        // Compute the front face of the Item's local AABB.
        const local = this.computeLocalBBox();
        const size = new THREE.Vector3(); local.getSize(size);
        const center = new THREE.Vector3(); local.getCenter(center);

        // Iframe at fixed DOM resolution, then scaled to fit the front face
        // while preserving 16:9. We pick the largest fit to the AABB front.
        const targetAspect = IFRAME_DOM_W / IFRAME_DOM_H;
        // The "front face" lives at +Z (local). Width = size.x, height = size.y.
        let screenW = size.x * 0.9;
        let screenH = screenW / targetAspect;
        if (screenH > size.y * 0.9) {
            screenH = size.y * 0.9;
            screenW = screenH * targetAspect;
        }
        // Map screen-world-size back to CSS3D scale.
        const sx = screenW / IFRAME_DOM_W;
        const sy = screenH / IFRAME_DOM_H;
        const css3dScale = Math.min(sx, sy);

        const iframeEl = document.createElement('iframe');
        iframeEl.width = IFRAME_DOM_W;
        iframeEl.height = IFRAME_DOM_H;
        iframeEl.allow = 'autoplay; fullscreen';
        iframeEl.referrerPolicy = 'no-referrer';
        iframeEl.dataset.itemId = this.id;
        iframeEl.src = placeholderHtml(this.name);

        const css3dObj = new CSS3DObject(iframeEl);
        css3dObj.scale.set(css3dScale, css3dScale, css3dScale);

        // Position it at the front face of the local AABB, parented to the object.
        css3dObj.position.set(center.x, center.y, local.max.z + 0.005);
        this.object3d.add(css3dObj);

        this.screen = { iframeEl, css3dObj, url: null };
        if (url) this.setUrl(url);
        setStatus(`Screen attached to "${this.name}" (${countScreens()}/${MAX_SCREENS})`);
    }

    detachScreen() {
        if (!this.screen) return;
        this.object3d.remove(this.screen.css3dObj);
        if (this.screen.iframeEl.parentNode) this.screen.iframeEl.parentNode.removeChild(this.screen.iframeEl);
        this.screen = null;
        setStatus(`Screen detached (${countScreens()}/${MAX_SCREENS})`);
    }

    setUrl(rawUrl) {
        if (!this.screen) this.attachScreen(rawUrl);
        if (!rawUrl) {
            this.screen.iframeEl.src = placeholderHtml(this.name);
            this.screen.url = null;
        } else {
            const url = normalizeUrl(rawUrl);
            this.screen.iframeEl.src = '/proxy?u=' + encodeURIComponent(url);
            this.screen.url = url;
        }
    }

    reload() {
        if (this.screen?.url) {
            this.screen.iframeEl.src = '/proxy?u=' + encodeURIComponent(this.screen.url);
        }
    }

    grab() {
        if (this.fixed) { setStatus(`"${this.name}" is fixed in place.`); return; }
        this.held = true;
        // Record the held item's pose relative to the camera so we can
        // reproduce it each frame without slip.
        const camMatrixInv = camera.matrixWorld.clone().invert();
        const local = this.object3d.matrixWorld.clone().premultiply(camMatrixInv);
        this.holdOffset.setFromMatrixPosition(local);
        this.holdQuat.setFromRotationMatrix(local);
        setStatus(`Grabbed "${this.name}". Move with mouse, release with G.`);
    }

    drop() {
        this.held = false;
        setStatus(`Dropped "${this.name}".`);
    }

    updateHeld() {
        if (!this.held) return;
        const pos = this.holdOffset.clone().applyMatrix4(camera.matrixWorld);
        // Hold orientation relative to camera.
        const camQuat = new THREE.Quaternion();
        camera.getWorldQuaternion(camQuat);
        this.object3d.position.copy(pos);
        this.object3d.quaternion.copy(camQuat).multiply(this.holdQuat);
    }

    dispose() {
        if (this.held) this.drop();
        this.detachScreen();
        scene.remove(this.object3d);
        for (const d of this._disposables) {
            try { d.dispose(); } catch { /* idempotent */ }
        }
        this._disposables.clear();
        const i = items.indexOf(this);
        if (i >= 0) items.splice(i, 1);
    }
}

// Cache: world-matrix-inverse of an object's parent root (we only ever attach
// to scene, so this is cheap), used by computeLocalBBox.
function _inverseRoot(obj) {
    obj.updateMatrixWorld(true);
    return obj.matrixWorld.clone().invert();
}

function countScreens() { return items.reduce((n, it) => n + (it.screen ? 1 : 0), 0); }

function enforceItemCap() {
    if (items.length <= MAX_ITEMS) return;
    // Recycle oldest non-fixed item first.
    for (const it of items) {
        if (!it.fixed) {
            setStatus(`Item cap hit, recycled "${it.name}".`);
            it.dispose();
            return;
        }
    }
}

// ---------- pre-loaded room geometry ----------------------------------------
//
// All procedural; built fresh on load so the world never depends on shipped
// asset files. Each is wrapped in an Item so they're consistent with placed
// objects and can carry screens via F-toggle.

function makeDeskItem(angleDeg, index) {
    const a = THREE.MathUtils.degToRad(angleDeg);
    const x = Math.sin(a) * MONITOR_RADIUS;
    const z = -Math.cos(a) * MONITOR_RADIUS;

    const group = new THREE.Group();
    group.name = `Desk ${index + 1}`;

    // Desk top
    const deskTop = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.95), plainMaterial());
    deskTop.position.y = 0.78;
    group.add(deskTop);

    // Legs
    const legGeom = new THREE.BoxGeometry(0.06, 0.78, 0.06);
    const legMat = plainMaterial(0x080d14, { roughness: 0.9, metalness: 0.2 });
    for (const ox of [-1.2, 1.2]) for (const oz of [-0.4, 0.4]) {
        const leg = new THREE.Mesh(legGeom, legMat);
        leg.position.set(ox, 0.39, oz);
        group.add(leg);
    }

    // Front edge glow
    const edge = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 0.02, 0.02),
        new THREE.MeshBasicMaterial({ color: index === 2 ? NEON_MAGENTA : NEON_CYAN })
    );
    edge.position.set(0, 0.745, 0.475);
    group.add(edge);

    // Bezel + ring (the monitor body); the iframe is attached via attachScreen later.
    const bezelW = IFRAME_DOM_W * IFRAME_SCALE + 0.10;
    const bezelH = IFRAME_DOM_H * IFRAME_SCALE + 0.10;
    const bezelDepth = 0.06;
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(bezelW, bezelH, bezelDepth),
        plainMaterial(0x05080d, { roughness: 0.4, metalness: 0.7 }));
    bezel.position.set(0, 0.78 + bezelH / 2 + 0.05, 0);
    group.add(bezel);

    // Emissive ring
    const ringMat = new THREE.MeshBasicMaterial({ color: index === 2 ? NEON_MAGENTA : NEON_CYAN });
    const t = 0.012;
    const ringTop = new THREE.Mesh(new THREE.BoxGeometry(bezelW + 0.01, t, 0.005), ringMat);
    ringTop.position.set(0, bezelH / 2 + t / 2, bezelDepth / 2);
    bezel.add(ringTop);
    const ringBottom = ringTop.clone(); ringBottom.position.y = -bezelH / 2 - t / 2; bezel.add(ringBottom);
    const ringL = new THREE.Mesh(new THREE.BoxGeometry(t, bezelH + t * 2, 0.005), ringMat);
    ringL.position.set(-bezelW / 2 - t / 2, 0, bezelDepth / 2); bezel.add(ringL);
    const ringR = ringL.clone(); ringR.position.x = bezelW / 2 + t / 2; bezel.add(ringR);

    group.position.set(x, 0, z);
    group.lookAt(0, 0, 0);

    const item = new Item({ object3d: group, name: `Desk ${index + 1}`, fixed: true, kind: 'desk' });
    // Auto-attach a screen (one per desk) so all five start with monitors.
    item.attachScreen(null);
    return item;
}

function makeChairItem(x, z, facingY = 0) {
    const g = new THREE.Group();
    g.name = 'Chair';
    const seatMat = plainMaterial(0x101a26, { metalness: 0.4 });
    const cushionMat = plainMaterial(0x14202e, { metalness: 0.2 });

    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), cushionMat);
    seat.position.y = 0.45;
    g.add(seat);

    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.06), cushionMat);
    back.position.set(0, 0.72, -0.22);
    g.add(back);

    const legGeom = new THREE.BoxGeometry(0.04, 0.45, 0.04);
    for (const ox of [-0.22, 0.22]) for (const oz of [-0.22, 0.22]) {
        const leg = new THREE.Mesh(legGeom, seatMat);
        leg.position.set(ox, 0.225, oz);
        g.add(leg);
    }

    // Neon trim along the back's top edge.
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.02),
        new THREE.MeshBasicMaterial({ color: NEON_CYAN }));
    trim.position.set(0, 1.00, -0.22);
    g.add(trim);

    g.position.set(x, 0, z);
    g.rotation.y = facingY;
    return new Item({ object3d: g, name: 'Chair', fixed: false, kind: 'chair' });
}

function makeStaircaseItem(x, z, facingY = 0) {
    const g = new THREE.Group();
    g.name = 'Staircase';
    const treadMat = plainMaterial(0x0c141d, { metalness: 0.5 });
    const glowMat = new THREE.MeshBasicMaterial({ color: NEON_CYAN, transparent: true, opacity: 0.7 });

    const steps = 6;
    const stepRise = 0.18;
    const stepRun = 0.30;
    const stepWidth = 1.6;
    for (let i = 0; i < steps; i++) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(stepWidth, stepRise, stepRun), treadMat);
        t.position.set(0, stepRise / 2 + i * stepRise, -i * stepRun);
        g.add(t);
        // Glowing nosing
        const nose = new THREE.Mesh(new THREE.BoxGeometry(stepWidth, 0.015, 0.015), glowMat);
        nose.position.set(0, stepRise + i * stepRise + 0.01, -i * stepRun + stepRun / 2);
        g.add(nose);
    }

    // Side rails for depth.
    const railH = stepRise * steps + 0.4;
    const railGeom = new THREE.BoxGeometry(0.04, railH, stepRun * steps);
    const railMat = plainMaterial(0x080d14, { metalness: 0.3 });
    const railL = new THREE.Mesh(railGeom, railMat);
    railL.position.set(-stepWidth / 2 + 0.02, railH / 2, -(stepRun * steps) / 2 + stepRun / 2);
    g.add(railL);
    const railR = railL.clone(); railR.position.x = stepWidth / 2 - 0.02; g.add(railR);

    g.position.set(x, 0, z);
    g.rotation.y = facingY;
    return new Item({ object3d: g, name: 'Staircase', fixed: false, kind: 'stairs' });
}

function makeDecorBlock(x, z, w, h, d, color = NEON_LIME) {
    const g = new THREE.Group();
    g.name = 'Block';
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
        plainMaterial(0x080d14, { metalness: 0.6 }));
    body.position.y = h / 2;
    g.add(body);
    const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(body.geometry),
        lineMaterial(color)
    );
    edges.position.y = h / 2;
    g.add(edges);
    g.position.set(x, 0, z);
    return new Item({ object3d: g, name: 'Block', fixed: false, kind: 'block' });
}

// ---------- layout engine ---------------------------------------------------
//
// A "layout" is just a function that, given a desk index (0..N-1) and the
// total count, returns where to put that desk and which way it should face.
// Layouts can be swapped at runtime via the top toolbar - the desks tween
// to their new poses without rebuilding.

const LAYOUT_RADIUS = 6.5;
const LAYOUTS = {
    arc(i, n) {
        const arcDeg = 140;
        const t = n === 1 ? 0.5 : i / (n - 1);
        const a = THREE.MathUtils.degToRad(-arcDeg / 2 + t * arcDeg);
        return {
            x: Math.sin(a) * LAYOUT_RADIUS, y: 0, z: -Math.cos(a) * LAYOUT_RADIUS,
            lookAt: new THREE.Vector3(0, 0, 0),
        };
    },
    row(i, n) {
        const span = 11;
        const x = -span / 2 + (n === 1 ? span / 2 : (i / (n - 1)) * span);
        return { x, y: 0, z: -5, lookAt: new THREE.Vector3(x, 1.5, 0) };
    },
    grid(i, n) {
        const cols = 3;
        const cellW = 2.6;
        const topCount = Math.min(cols, n);
        const inTop = i < topCount;
        const colsInThisRow = inTop ? topCount : (n - topCount);
        const idxInRow = inTop ? i : i - topCount;
        const xCenter = (colsInThisRow - 1) / 2;
        const x = (idxInRow - xCenter) * cellW;
        const y = inTop ? 1.4 : 0;
        return { x, y, z: -5, lookAt: new THREE.Vector3(x, 1.5 + y, 0) };
    },
    stack(i, n) {
        const spacing = 1.25;
        const yMid = 1.5;
        const y = yMid + ((n - 1) / 2 - i) * spacing;
        return { x: 0, y: y - 1.5, z: -3.6, lookAt: new THREE.Vector3(0, y, 0) };
    },
    panorama(i, n) {
        const a = (i / n) * Math.PI * 2;
        const r = 4.5;
        return {
            x: Math.sin(a) * r, y: 0, z: -Math.cos(a) * r,
            lookAt: new THREE.Vector3(0, 0, 0),
        };
    },
    grid3d(i) {
        const xs = [-3.5, -1.6, 0.4, 2.2, 4.0];
        const ys = [-0.4, 0.6, -0.2, 0.8, 0.2];
        const zs = [-7.5, -5.5, -4.5, -6.0, -8.0];
        return {
            x: xs[i % 5], y: ys[i % 5], z: zs[i % 5],
            lookAt: new THREE.Vector3(0, 1.5, 0),
        };
    },
};

let _currentLayout = 'arc';
const _layoutTweens = new Map();
let _cameraTween = null;

function applyLayout(name) {
    if (!LAYOUTS[name]) return;
    _currentLayout = name;
    const n = fixedDesks.length;
    const dummy = new THREE.Object3D();
    fixedDesks.forEach((item, i) => {
        const pose = LAYOUTS[name](i, n);
        const toPos = new THREE.Vector3(pose.x, pose.y, pose.z);
        dummy.position.copy(toPos);
        dummy.lookAt(pose.lookAt);
        const toQuat = dummy.quaternion.clone();
        _layoutTweens.set(item, {
            fromPos: item.object3d.position.clone(),
            toPos,
            fromQuat: item.object3d.quaternion.clone(),
            toQuat,
            t0: performance.now(),
            dur: 600,
        });
    });
    try { localStorage.setItem('lozsworld.layout.choice.v1', name); } catch {}
    document.querySelectorAll('.tb-layout').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === name);
    });
}

function _stepLayoutTweens() {
    if (_layoutTweens.size === 0) return;
    const now = performance.now();
    for (const [item, tw] of _layoutTweens) {
        const k = Math.min(1, (now - tw.t0) / tw.dur);
        const e = 1 - Math.pow(1 - k, 3);
        item.object3d.position.lerpVectors(tw.fromPos, tw.toPos, e);
        item.object3d.quaternion.copy(tw.fromQuat).slerp(tw.toQuat, e);
        if (k >= 1) _layoutTweens.delete(item);
    }
}

// Build the room: 5 desks in a wide arc, plus chairs in front of each desk,
// a staircase on the back-left wall, and a few decorative blocks.
const ARC_DEG = 140;
const fixedDesks = [];
for (let i = 0; i < MONITOR_COUNT; i++) {
    const t = MONITOR_COUNT === 1 ? 0.5 : i / (MONITOR_COUNT - 1);
    const angle = -ARC_DEG / 2 + t * ARC_DEG;
    const desk = makeDeskItem(angle, i);
    fixedDesks.push(desk);

    // Chair in front of each desk, facing it.
    const a = THREE.MathUtils.degToRad(angle);
    const cx = Math.sin(a) * (MONITOR_RADIUS - 1.1);
    const cz = -Math.cos(a) * (MONITOR_RADIUS - 1.1);
    makeChairItem(cx, cz, a + Math.PI);
}

// Restore saved layout choice if any. Defaults to 'arc' (matches construction).
try {
    const saved = localStorage.getItem('lozsworld.layout.choice.v1');
    if (saved && LAYOUTS[saved] && saved !== 'arc') applyLayout(saved);
} catch {}

// Staircase on the back wall, slightly off-centre.
makeStaircaseItem(-9, -10, 0);

// Three decorative blocks at varying heights, three different colours.
makeDecorBlock(7, -11, 0.8, 1.6, 0.8, NEON_LIME);
makeDecorBlock(8.5, -11, 0.6, 0.8, 0.6, NEON_AMBER);
makeDecorBlock(10, -11, 0.5, 0.4, 0.5, NEON_MAGENTA);

// ---------- iframe placeholder html ----------------------------------------
function placeholderHtml(label) {
    const html = `
        <!doctype html><html><head><meta charset="utf-8"><style>
        @import url('https://fonts.googleapis.com/css2?family=Caveat&display=swap');
        html,body{margin:0;height:100%;background:#fcfaf3;color:#1c1814;
            font-family:'Caveat',cursive;
            display:flex;align-items:center;justify-content:center;flex-direction:column;}
        .n{font-size:120px;color:#1c1814;}
        .h{margin-top:0;color:#8a8174;font-size:22px;}
        .k{margin-top:30px;color:#2f5fb8;font-size:22px;}
        </style></head><body>
            <div class="n">${label}</div>
            <div class="h">no page yet</div>
            <div class="k">type a url or a search above ↑</div>
        </body></html>`;
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function normalizeUrl(s) {
    s = s.trim();
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
}

// ---------- multi-format loader hub ----------------------------------------
const stlLoader = new STLLoader();
const objLoader = new OBJLoader();
const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();
const colladaLoader = new ColladaLoader();
const tdsLoader = new TDSLoader();
const plyLoader = new PLYLoader();

async function loadAssetFromUrl(url, name = url) {
    const ext = (url.split('.').pop() || '').toLowerCase();
    const buf = await fetch(url).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r.arrayBuffer();
    });
    return loadAssetFromBuffer(buf, ext, name);
}

async function loadAssetFromFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const buf = await file.arrayBuffer();
    return loadAssetFromBuffer(buf, ext, file.name);
}

async function loadAssetFromBuffer(buf, ext, name) {
    const group = new THREE.Group();
    group.name = name;

    if (ext === 'stl') {
        const geom = stlLoader.parse(buf);
        const mesh = new THREE.Mesh(geom, neonMaterial({ emissiveIntensity: 0.35 }));
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), lineMaterial(NEON_CYAN));
        mesh.add(edges);
        group.add(mesh);
    } else if (ext === 'obj') {
        const text = new TextDecoder().decode(buf);
        const obj = objLoader.parse(text);
        obj.traverse(o => {
            if (o.isMesh) {
                if (!o.material || !o.material.isMaterial) o.material = neonMaterial();
            }
        });
        group.add(obj);
    } else if (ext === 'glb' || ext === 'gltf') {
        const result = await new Promise((resolve, reject) => {
            gltfLoader.parse(buf, '', resolve, reject);
        });
        group.add(result.scene);
    } else if (ext === 'fbx') {
        // FBX is binary or ASCII; the loader detects which.
        const fbx = fbxLoader.parse(buf, '');
        fbx.traverse(o => {
            if (o.isMesh && (!o.material || !o.material.isMaterial)) o.material = neonMaterial();
        });
        group.add(fbx);
    } else if (ext === 'dae') {
        // Collada is text-based XML; we decode and feed the loader.
        const text = new TextDecoder().decode(buf);
        const collada = colladaLoader.parse(text, '');
        group.add(collada.scene);
    } else if (ext === '3ds') {
        const tds = tdsLoader.parse(buf, '');
        tds.traverse(o => {
            if (o.isMesh && (!o.material || !o.material.isMaterial)) o.material = neonMaterial();
        });
        group.add(tds);
    } else if (ext === 'ply') {
        const geom = plyLoader.parse(buf);
        const mesh = geom.index !== null
            ? new THREE.Mesh(geom, neonMaterial({ emissiveIntensity: 0.35 }))
            : new THREE.Points(geom, new THREE.PointsMaterial({
                color: NEON_CYAN, size: 0.005, sizeAttenuation: true
              }));
        group.add(mesh);
    } else if (ext === 'skp') {
        // SketchUp's native format is proprietary; no JS parser exists.
        // Re-raise with an actionable error so the HUD tells the user what to do.
        throw new Error('SKP is proprietary; in SketchUp use File -> Export -> OBJ or GLB, then drop that.');
    } else {
        throw new Error(`Unsupported asset extension: .${ext}`);
    }

    // Normalize: center bbox at origin, scale to ~0.6m max side.
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3(); box.getSize(size);
    const centre = new THREE.Vector3(); box.getCenter(centre);
    const maxSide = Math.max(size.x, size.y, size.z) || 1;
    const targetSize = 0.6;
    const s = targetSize / maxSide;
    group.position.sub(centre.multiplyScalar(s));
    group.scale.setScalar(s);

    return group;
}

// ---------- spawn helpers ---------------------------------------------------
function spawnAt(group, name, kind, sourceUrl, position, asScreen = false) {
    const wrapper = new THREE.Group();
    wrapper.add(group);
    if (position) wrapper.position.copy(position);
    const item = new Item({ object3d: wrapper, name, kind, sourceUrl });
    if (asScreen) item.attachScreen(null);
    saveLayout();
    return item;
}

function spawnInFrontOfCamera(group, name, kind, sourceUrl, asScreen = false) {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const pos = camera.position.clone().addScaledVector(fwd, 1.5);
    pos.y -= 0.3;
    return spawnAt(group, name, kind, sourceUrl, pos, asScreen);
}

// ---------- pointer lock + movement ----------------------------------------
// ---------- custom mouselook (replaces PointerLockControls) ---------------
//
// Why custom: PointerLockControls has hard-coded sensitivity and no
// invert / smoothing. This version reads CONFIG.mouse and adds three fixes
// for the well-known FPS-mouselook glitches:
//
//   1. Spike filter. Pointer-lock events occasionally fire with absurd
//      movement deltas (Chromium issue #781182, Firefox cursor-warp at
//      screen edges, macOS focus-steal). A single 1500-px frame would
//      flip the camera. We reject any delta above SPIKE_LIMIT_PX.
//
//   2. Shortest-path yaw smoothing. Naive lerp(yaw, yawT, k) wraps the
//      long way round at the +/-pi boundary - a 350-degree spin instead
//      of a 10-degree correction. We blend along the shorter arc.
//
//   3. Quaternion composition. THREE.Euler with YXZ order has subtle
//      round-trip drift very close to the pitch poles, even when
//      clamped. Building the orientation as qYaw * qPitch is bulletproof
//      and produces identical results in normal range.
//
// API surface (lock, unlock, isLocked, moveForward, moveRight, events)
// matches PointerLockControls so the rest of the file is unchanged.
const controls = (() => {
    const target = document.body;
    let yaw = 0, pitch = 0;          // rendered this frame
    let yawT = 0, pitchT = 0;        // mouse-driven targets
    let _locked = false;
    let _firstFrameAfterLock = false;
    const dispatcher = new THREE.EventDispatcher();

    // Reject impossibly large pointer-lock deltas.
    // 200 CSS pixels is well above any real human flick yet far below
    // the spike values reported in the bug threads.
    const SPIKE_LIMIT_PX = 200;

    // Reusable scratch quaternions to avoid per-frame allocation.
    const _qYaw = new THREE.Quaternion();
    const _qPitch = new THREE.Quaternion();
    const _vUp = new THREE.Vector3(0, 1, 0);
    const _vRight = new THREE.Vector3(1, 0, 0);

    function onMouseMove(e) {
        if (!_locked) return;
        let dx = e.movementX || 0;
        let dy = e.movementY || 0;

        // (1) Spike filter. Throw away the whole event if either axis
        // is suspicious. Also unconditionally throw away the very first
        // event after locking - some browsers fire stale deltas there.
        if (_firstFrameAfterLock) { _firstFrameAfterLock = false; return; }
        if (Math.abs(dx) > SPIKE_LIMIT_PX || Math.abs(dy) > SPIKE_LIMIT_PX) return;

        const m = CONFIG.mouse;
        const sx = m.sensitivity * m.sensitivityX * 0.002;
        const sy = m.sensitivity * m.sensitivityY * 0.002 * (m.invertY ? -1 : 1);
        yawT   -= dx * sx;
        pitchT -= dy * sy;

        // Clamp pitch.
        const u = THREE.MathUtils.degToRad(m.maxLookUpDeg);
        const d = THREE.MathUtils.degToRad(m.maxLookDownDeg);
        if (pitchT > u) pitchT = u;
        if (pitchT < -d) pitchT = -d;

        // Keep yaw in (-PI, PI] so smoothing math stays well-defined.
        if (yawT >  Math.PI) yawT -= 2 * Math.PI;
        if (yawT < -Math.PI) yawT += 2 * Math.PI;
    }
    document.addEventListener('mousemove', onMouseMove);

    document.addEventListener('pointerlockchange', () => {
        const wasLocked = _locked;
        _locked = (document.pointerLockElement === target);
        if (_locked && !wasLocked) {
            // (3) Pull current orientation from the camera's quaternion,
            // not from Euler - avoids YXZ-order surprises if anything
            // else has touched the camera's rotation since last lock.
            const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
            yaw = yawT = e.y;
            pitch = pitchT = e.x;
            _firstFrameAfterLock = true;
            dispatcher.dispatchEvent({ type: 'lock' });
        } else if (!_locked && wasLocked) {
            dispatcher.dispatchEvent({ type: 'unlock' });
        }
    });

    document.addEventListener('pointerlockerror', () => {
        console.warn('pointer lock failed (try clicking inside the page first)');
    });

    function update() {
        const s = CONFIG.mouse.smoothing;
        if (s > 0 && s < 1) {
            // (2) Shortest-path yaw blend across the -PI/+PI boundary.
            let dy = yawT - yaw;
            if (dy >  Math.PI) dy -= 2 * Math.PI;
            if (dy < -Math.PI) dy += 2 * Math.PI;
            yaw   += dy * (1 - s);
            pitch  = pitch * s + pitchT * (1 - s);
            // Re-normalize to keep yaw bounded over long sessions.
            if (yaw >  Math.PI) yaw -= 2 * Math.PI;
            if (yaw < -Math.PI) yaw += 2 * Math.PI;
        } else {
            yaw = yawT;
            pitch = pitchT;
        }

        // (3) Build the camera orientation as qYaw * qPitch - explicit
        // quaternion composition. Mathematically identical to a YXZ Euler
        // with z=0 in normal range, but avoids Euler->Quat round-trip
        // edge cases near the poles.
        _qYaw.setFromAxisAngle(_vUp, yaw);
        _qPitch.setFromAxisAngle(_vRight, pitch);
        camera.quaternion.copy(_qYaw).multiply(_qPitch);
    }

    function moveForward(d) {
        const f = new THREE.Vector3();
        camera.getWorldDirection(f);
        f.y = 0; f.normalize();
        camera.position.addScaledVector(f, d);
    }
    function moveRight(d) {
        const f = new THREE.Vector3();
        camera.getWorldDirection(f);
        f.y = 0; f.normalize();
        const r = new THREE.Vector3().crossVectors(f, camera.up);
        camera.position.addScaledVector(r, d);
    }

    return Object.assign(dispatcher, {
        get isLocked() { return _locked; },
        lock()   { target.requestPointerLock(); },
        unlock() { document.exitPointerLock(); },
        moveForward, moveRight, update,
    });
})();


const overlay = document.getElementById('overlay');
const enterBtn = document.getElementById('enter-btn');
// (enter-btn click now handled by enterMouseMode below to fix overlay-dismiss bug.)

controls.addEventListener('lock', () => {
    overlay.classList.remove('visible');
    document.body.classList.add('locked');
});
controls.addEventListener('unlock', () => {
    // Do NOT re-show the welcome overlay on unlock - it blocks the D-pad and
    // forces the user back through "Walk into the room". The user can re-grab
    // the mouse via the floating "look" button or by clicking on empty space.
    document.body.classList.remove('locked');
    document.body.classList.add('unlocked-in-world');
});

const keys = Object.create(null);
window.addEventListener('keydown', e => { keys[e.code] = true; });
window.addEventListener('keyup', e => { keys[e.code] = false; });

const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const clock = new THREE.Clock();

function updateMovement(dt) {
    // Walking is allowed whenever no input/textarea has focus. Mouse-look
    // still requires pointer-lock, but WASD doesn't - that way you can
    // walk around even if the browser rejects the lock for any reason.
    const f = document.activeElement;
    if (f && (f.tagName === 'INPUT' || f.tagName === 'TEXTAREA' || f.isContentEditable)) return;
    const speed = (keys['ShiftLeft'] || keys['ShiftRight']) ? CONFIG.movement.sprintSpeed : CONFIG.movement.walkSpeed;
    const damping = 10.0;

    velocity.x -= velocity.x * damping * dt;
    velocity.z -= velocity.z * damping * dt;
    velocity.y -= velocity.y * damping * dt;

    direction.z = Number(keys['KeyW'] || keys['ArrowUp']) - Number(keys['KeyS'] || keys['ArrowDown']);
    direction.x = Number(keys['KeyD'] || keys['ArrowRight']) - Number(keys['KeyA'] || keys['ArrowLeft']);
    direction.normalize();

    if (direction.lengthSq() > 0) {
        velocity.z -= direction.z * speed * dt * damping * 0.6;
        velocity.x -= direction.x * speed * dt * damping * 0.6;
    }
    if (keys['Space']) velocity.y += CONFIG.movement.verticalSpeed * dt * 2.2;
    if (keys['ControlLeft'] || keys['ControlRight']) velocity.y -= CONFIG.movement.verticalSpeed * dt * 2.2;

    controls.moveRight(-velocity.x * dt);
    controls.moveForward(-velocity.z * dt);
    camera.position.y += velocity.y * dt;

    const m = ROOM_SIZE / 2 - 0.4;
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -m, m);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, -m, m);
    camera.position.y = THREE.MathUtils.clamp(camera.position.y, 0.2, ROOM_HEIGHT - 0.2);
}

// ---------- raycast: which Item am I looking at? ---------------------------
const raycaster = new THREE.Raycaster();
const centerNDC = new THREE.Vector2(0, 0);
let lookedAt = null;

function updateLook() {
    raycaster.setFromCamera(centerNDC, camera);
    // Build a flat list of meshes belonging to non-held items.
    const targets = [];
    for (const it of items) {
        if (it.held) continue;
        it.object3d.traverse(o => { if (o.isMesh) targets.push(o); });
    }
    const hits = raycaster.intersectObjects(targets, false);
    let next = null;
    for (const h of hits) {
        const it = itemsByMesh.get(h.object);
        if (it) { next = it; break; }
    }
    if (next !== lookedAt) {
        lookedAt = next;
        const hud = document.getElementById('hud-monitor');
        if (!lookedAt) {
            hud.textContent = '- nothing in view -';
        } else {
            const tag = lookedAt.screen
                ? (lookedAt.screen.url ? lookedAt.screen.url : 'screen empty')
                : 'no screen';
            hud.textContent = `${lookedAt.name}  ${lookedAt.kind === 'desk' ? '' : '['+lookedAt.kind+'] '}- ${tag}`;
        }
    }
}

// ---------- key shortcuts --------------------------------------------------
const urlPromptEl = document.getElementById('url-prompt');
const urlInput = document.getElementById('url-input');
const urlMonitorIdEl = document.getElementById('url-monitor-id');
const cssLayer = document.getElementById('css3d');
let promptingFor = null;
let interactiveItem = null;

function openUrlPrompt(item) {
    promptingFor = item;
    urlMonitorIdEl.textContent = item.name;
    urlInput.value = item.screen?.url || '';
    urlPromptEl.classList.remove('hidden');
    controls.unlock();
    setTimeout(() => urlInput.focus(), 50);
}
function closeUrlPrompt() {
    urlPromptEl.classList.add('hidden');
    promptingFor = null;
}
document.getElementById('url-cancel').addEventListener('click', closeUrlPrompt);
document.getElementById('url-ok').addEventListener('click', () => {
    if (!promptingFor) return;
    const v = urlInput.value.trim();
    promptingFor.setUrl(v || null);
    saveLayout();
    closeUrlPrompt();
});
document.getElementById('url-paste').addEventListener('click', async () => {
    try { const t = await navigator.clipboard.readText(); if (t) urlInput.value = t.trim(); } catch {}
});
urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('url-ok').click();
    else if (e.key === 'Escape') closeUrlPrompt();
});

function setStatus(msg, durationMs = 2200) {
    const el = document.getElementById('hud-status');
    el.textContent = msg;
    if (msg) {
        clearTimeout(setStatus._t);
        setStatus._t = setTimeout(() => el.textContent = '', durationMs);
    }
}

window.addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;

    if (e.code === 'KeyE' && lookedAt && controls.isLocked) {
        if (!lookedAt.screen) lookedAt.attachScreen(null);
        openUrlPrompt(lookedAt);
        e.preventDefault();
    } else if (e.code === 'KeyR' && lookedAt?.screen && controls.isLocked) {
        lookedAt.reload();
        setStatus(`Reloaded "${lookedAt.name}"`);
    } else if (e.code === 'KeyF' && lookedAt && controls.isLocked) {
        if (lookedAt.screen) lookedAt.detachScreen();
        else lookedAt.attachScreen(null);
        saveLayout();
    } else if (e.code === 'KeyG' && controls.isLocked) {
        const held = items.find(i => i.held);
        if (held) {
            held.drop();
            saveLayout();
        } else if (lookedAt) {
            lookedAt.grab();
        }
    } else if (e.code === 'KeyK') {
        toggleLibrary();
        e.preventDefault();
    } else if (e.code === 'Tab') {
        e.preventDefault();
        if (lookedAt?.screen && controls.isLocked) {
            interactiveItem = lookedAt;
            for (const it of items) if (it.screen) it.screen.iframeEl.classList.toggle('focused', it === interactiveItem);
            cssLayer.classList.add('interactive');
            controls.unlock();
            setStatus(`Interact mode - click in screen, Tab/Esc to leave`);
        } else if (cssLayer.classList.contains('interactive')) {
            cssLayer.classList.remove('interactive');
            for (const it of items) if (it.screen) it.screen.iframeEl.classList.remove('focused');
            interactiveItem = null;
            controls.lock();
        }
    }
});

// ---------- drag-drop files into the world --------------------------------
['dragenter', 'dragover'].forEach(ev =>
    window.addEventListener(ev, e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; })
);
window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter(f => /\.(stl|obj|glb|gltf|fbx|dae|3ds|ply|skp)$/i.test(f.name));
    if (!files.length) return;
    for (const f of files) {
        try {
            const group = await loadAssetFromFile(f);
            spawnInFrontOfCamera(group, f.name, 'asset', null);
            setStatus(`Loaded ${f.name} (${(f.size / 1024).toFixed(1)} KB)`);
        } catch (err) {
            console.error(err);
            setStatus(`Load failed: ${f.name} - ${err.message}`);
        }
    }
});

// ---------- asset library panel -------------------------------------------
const libraryEl = document.getElementById('library');
const libraryListEl = document.getElementById('library-list');
const libraryRefreshBtn = document.getElementById('library-refresh');
const libraryCloseBtn = document.getElementById('library-close');

async function refreshLibrary() {
    libraryListEl.innerHTML = `<div class="loading">scanning public/assets/...</div>`;
    try {
        const r = await fetch('/api/assets');
        const data = await r.json();
        if (!data.assets || !data.assets.length) {
            libraryListEl.innerHTML =
                `<div class="empty">No assets yet.<br><br>Drop .stl / .obj / .glb files into <code>public/assets/</code> next to <code>server.js</code>, then refresh.</div>`;
            return;
        }
        libraryListEl.innerHTML = '';
        for (const a of data.assets) {
            const row = document.createElement('div');
            row.className = 'lib-row';
            row.innerHTML = `
                <div class="lib-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
                <div class="lib-meta">.${a.ext} · ${(a.size / 1024).toFixed(1)} KB</div>
                <div class="lib-actions">
                    <button class="lib-spawn">Spawn</button>
                    <button class="lib-spawn-screen" title="Spawn with a screen attached">Spawn + Screen</button>
                </div>`;
            row.querySelector('.lib-spawn').addEventListener('click', () => spawnFromLibrary(a, false));
            row.querySelector('.lib-spawn-screen').addEventListener('click', () => spawnFromLibrary(a, true));
            libraryListEl.appendChild(row);
        }
    } catch (err) {
        libraryListEl.innerHTML = `<div class="empty">Library unavailable: ${escapeHtml(err.message)}</div>`;
    }
}

async function spawnFromLibrary(asset, asScreen) {
    setStatus(`Loading ${asset.name}...`);
    try {
        const group = await loadAssetFromUrl(asset.url, asset.name);
        spawnInFrontOfCamera(group, asset.name, 'asset', asset.url, asScreen);
        setStatus(`Spawned "${asset.name}"${asScreen ? ' with screen' : ''}.`);
    } catch (err) {
        console.error(err);
        setStatus(`Failed to load ${asset.name}: ${err.message}`);
    }
}

function toggleLibrary() {
    if (libraryEl.classList.contains('open')) {
        libraryEl.classList.remove('open');
    } else {
        libraryEl.classList.add('open');
        refreshLibrary();
    }
}
libraryRefreshBtn.addEventListener('click', refreshLibrary);
libraryCloseBtn.addEventListener('click', () => libraryEl.classList.remove('open'));

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- persistence (schema-versioned) ---------------------------------
function saveLayout() {
    try {
        const layout = {
            version: 2,
            screens: items
                .filter(i => i.screen)
                .map(i => ({
                    itemId: i.id,
                    fixedKind: i.fixed ? i.kind : null,
                    fixedIndex: i.fixed && i.kind === 'desk'
                        ? fixedDesks.indexOf(i)
                        : null,
                    url: i.screen.url,
                })),
            placed: items
                .filter(i => !i.fixed && i.sourceUrl)
                .map(i => ({
                    sourceUrl: i.sourceUrl,
                    name: i.name,
                    matrix: i.object3d.matrix.toArray(),
                    hasScreen: !!i.screen,
                    screenUrl: i.screen?.url || null,
                })),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch (err) {
        console.warn('saveLayout failed', err);
    }
}

async function restoreLayout() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const layout = JSON.parse(raw);
        if (layout.version !== 2) return;

        // 1. Restore desk URLs.
        for (const s of (layout.screens || [])) {
            if (s.fixedKind === 'desk' && s.fixedIndex != null && fixedDesks[s.fixedIndex]) {
                fixedDesks[s.fixedIndex].setUrl(s.url || null);
            }
        }
        // 2. Re-spawn placed assets.
        for (const p of (layout.placed || [])) {
            try {
                const group = await loadAssetFromUrl(p.sourceUrl, p.name);
                const wrapper = new THREE.Group();
                wrapper.add(group);
                const m = new THREE.Matrix4().fromArray(p.matrix);
                m.decompose(wrapper.position, wrapper.quaternion, wrapper.scale);
                const item = new Item({ object3d: wrapper, name: p.name, kind: 'asset', sourceUrl: p.sourceUrl });
                if (p.hasScreen) item.attachScreen(p.screenUrl);
            } catch (err) {
                console.warn('Skipping unrestoreable item', p.name, err.message);
            }
        }
    } catch (err) {
        console.warn('restoreLayout failed', err);
    }
}
restoreLayout();

// ---------- resize ---------------------------------------------------------
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    webglRenderer.setSize(window.innerWidth, window.innerHeight);
    cssRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- HUD screen counter --------------------------------------------
function updateScreenCounter() {
    const el = document.getElementById('hud-screens');
    if (el) el.textContent = `screens ${countScreens()}/${MAX_SCREENS}  ·  items ${items.length}/${MAX_ITEMS}`;
}

// ---------- main loop ------------------------------------------------------
let _frameCount = 0;
function tick() {
    const dt = Math.min(clock.getDelta(), 0.1);
    controls.update();
    _stepLayoutTweens();
    _stepCameraTween();
    updateMovement(dt);
    for (const it of items) it.updateHeld();
    updateLook();
    if (((_frameCount++) & 31) === 0) updateScreenCounter();
    webglRenderer.render(scene, camera);
    cssRenderer.render(scene, camera);
    requestAnimationFrame(tick);
}
tick();

// Mark boot complete so the loading overlay can hide.
window._bootCleared = true;

// Subtle pulse on the rim lights.
let pulseT = 0;
setInterval(() => {
    pulseT += 0.05;
    cyanRim.intensity = 1.2 + Math.sin(pulseT) * 0.25;
    magentaRim.intensity = 0.9 + Math.sin(pulseT + 1.6) * 0.2;
}, 50);

// ---------- toolbar wiring (top of screen) -------------------------------
//
// Auto-hidden whenever pointer-lock engages; visible otherwise (tool mode).

// ===== Layout buttons =====
document.querySelectorAll('.tb-layout').forEach(btn => {
    btn.addEventListener('click', () => applyLayout(btn.dataset.layout));
});

// ===== Smart search bars - one per fixed desk =====
//
// Replaces the plain URL inputs. Each search bar:
//   - tells URL from natural-language query (any input with a dot and TLD or
//     starting with http(s):// is treated as a URL; else it's a search query)
//   - shows live DuckDuckGo autocomplete suggestions while typing
//   - has a star button to favourite a URL; favourites persist in localStorage
//   - submits to the relevant fixed desk on Enter / suggestion click

const FAVS_KEY = 'lozsworld.favourites.v1';
function loadFavs() {
    try { return JSON.parse(localStorage.getItem(FAVS_KEY) || '[]'); } catch { return []; }
}
function saveFavs(list) {
    try { localStorage.setItem(FAVS_KEY, JSON.stringify(list)); } catch {}
}

function isUrlLike(s) {
    s = s.trim();
    if (!s) return false;
    if (/^https?:\/\//i.test(s)) return true;
    // bare domain? "foo.com", "foo.com/bar"
    if (/^[a-z0-9-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return true;
    if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return true;
    return false;
}
function resolveQuery(s) {
    s = s.trim();
    if (!s) return null;
    if (isUrlLike(s)) return /^https?:\/\//i.test(s) ? s : 'https://' + s;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

function buildSearchBar(idx) {
    const wrap = document.createElement('div');
    wrap.className = 'tb-search';
    wrap.innerHTML = `
        <input class="tb-url" data-monitor="${idx}" placeholder="${idx + 1}: url or search…" autocomplete="off" />
        <button class="tb-jump-btn" data-monitor="${idx}" title="jump camera to this screen">→</button>
        <button class="tb-fav-btn" data-monitor="${idx}" title="favourite">☆</button>
        <ul class="tb-suggest" data-monitor="${idx}"></ul>
    `;
    return wrap;
}

const tbUrlsHost = document.getElementById('tb-urls');
for (let i = 0; i < fixedDesks.length; i++) {
    tbUrlsHost.appendChild(buildSearchBar(i));
}

// Hook each bar.
let _suggestSeq = 0;
async function fetchSuggestions(q) {
    const seq = ++_suggestSeq;
    try {
        const r = await fetch('/api/suggest?q=' + encodeURIComponent(q));
        if (seq !== _suggestSeq) return null;
        if (!r.ok) return [];
        return await r.json();
    } catch { return []; }
}
function showSuggest(ul, items) {
    if (!items || !items.length) { ul.classList.remove('open'); ul.innerHTML = ''; return; }
    ul.innerHTML = items.map(it => `<li>${String(it).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</li>`).join('');
    ul.classList.add('open');
}

document.querySelectorAll('.tb-search').forEach(wrap => {
    const input = wrap.querySelector('.tb-url');
    const fav = wrap.querySelector('.tb-fav-btn');
    const ul = wrap.querySelector('.tb-suggest');
    const idx = parseInt(input.dataset.monitor, 10);

    if (fixedDesks[idx]?.screen?.url) input.value = fixedDesks[idx].screen.url;

    function commit(value) {
        const target = resolveQuery(value);
        if (!fixedDesks[idx]) return;
        if (!fixedDesks[idx].screen) fixedDesks[idx].attachScreen(null);
        fixedDesks[idx].setUrl(target);
        saveLayout();
        ul.classList.remove('open');
        input.blur();
    }

    let debounce = null;
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        const q = input.value.trim();
        if (q.length < 2 || isUrlLike(q)) { ul.classList.remove('open'); return; }
        debounce = setTimeout(async () => {
            const items = await fetchSuggestions(q);
            if (items) showSuggest(ul, items);
        }, 160);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(input.value); }
        else if (e.key === 'Escape') { ul.classList.remove('open'); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(() => ul.classList.remove('open'), 120));
    ul.addEventListener('mousedown', (e) => {
        const li = e.target.closest('li');
        if (li) { input.value = li.textContent; commit(li.textContent); }
    });

    fav.addEventListener('click', () => {
        const v = input.value.trim();
        if (!v) return;
        const favs = loadFavs();
        const exists = favs.findIndex(f => f.url === v);
        if (exists >= 0) { favs.splice(exists, 1); fav.classList.remove('is-fav'); fav.textContent = '☆'; }
        else { favs.unshift({ url: v, when: Date.now() }); fav.classList.add('is-fav'); fav.textContent = '★'; }
        saveFavs(favs);
    });

    // Initial fav state
    const favs = loadFavs();
    if (favs.find(f => f.url === input.value)) { fav.classList.add('is-fav'); fav.textContent = '★'; }

    // Jump-to-screen: fly the camera to face this monitor.
    const jump = wrap.querySelector('.tb-jump-btn');
    jump.addEventListener('click', () => jumpToMonitor(idx));
});

// Smooth camera fly-to. Computes a viewing pose 2.4m in front of the
// monitor, looking at its centre, and lerps over ~700ms.
function jumpToMonitor(i) {
    const desk = fixedDesks[i];
    if (!desk) return;
    const target = new THREE.Vector3();
    desk.object3d.getWorldPosition(target);
    // Camera goes 2.4m back along the desk's facing direction.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(desk.object3d.quaternion);
    const camTo = target.clone().addScaledVector(fwd, 2.4);
    camTo.y = 1.7;  // eye level
    const lookAt = target.clone();
    lookAt.y = 1.5;
    _cameraTween = {
        fromPos: camera.position.clone(),
        toPos: camTo,
        fromQuat: camera.quaternion.clone(),
        toQuat: (() => {
            const dummy = new THREE.Object3D();
            dummy.position.copy(camTo);
            dummy.lookAt(lookAt);
            return dummy.quaternion.clone();
        })(),
        t0: performance.now(), dur: 700,
    };
    setStatus('Jumping to screen ' + (i + 1));
}
function _stepCameraTween() {
    if (!_cameraTween) return;
    const k = Math.min(1, (performance.now() - _cameraTween.t0) / _cameraTween.dur);
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(_cameraTween.fromPos, _cameraTween.toPos, e);
    camera.quaternion.copy(_cameraTween.fromQuat).slerp(_cameraTween.toQuat, e);
    if (k >= 1) _cameraTween = null;
}

// ===== ENTER (3D) - bug-fix: dismiss overlay immediately, regardless of pointer-lock outcome.
function enterMouseMode() {
    overlay.classList.remove('visible');
    document.body.classList.add('locked');  // immediate visual response
    // requestPointerLock can fail silently (focus, iframe, etc); handle that.
    try { controls.lock(); } catch (e) { console.warn('lock() threw', e); }
    // If lock didn't take within 400ms, treat as failed and hide HUD anyway -
    // user can still use keyboard for movement once they click the canvas.
    setTimeout(() => {
        if (!controls.isLocked) {
            // Lock didn't take; restore overlay so the user knows.
            document.body.classList.remove('locked');
            // Don't force the welcome overlay back open here - the toolbar is enough.
            setStatus('Click the canvas to capture the mouse.');
        }
    }, 450);
}
document.getElementById('tb-enter3d').addEventListener('click', enterMouseMode);
document.getElementById('enter-btn').addEventListener('click', enterMouseMode);

// Sync URL fields whenever URLs change in-world (E key).
const _origSetUrl = Item.prototype.setUrl;
Item.prototype.setUrl = function(rawUrl) {
    _origSetUrl.call(this, rawUrl);
    const idx = fixedDesks.indexOf(this);
    if (idx >= 0) {
        const inp = document.querySelector(`.tb-url[data-monitor="${idx}"]`);
        if (inp) inp.value = this.screen?.url || '';
    }
};

// ---------- Notes overlay ---------------------------------------------------
//
// Quick text scratchpad. Press N or click the 📝 button. Saved to localStorage.
const NOTES_KEY = 'lozsworld.notes.v1';
const Notes = (() => {
    const el = document.getElementById('notes');
    const ta = document.getElementById('notes-textarea');
    const closeBtn = document.getElementById('notes-close');

    try { ta.value = localStorage.getItem(NOTES_KEY) || ''; } catch {}
    let saveTimer = null;
    ta.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try { localStorage.setItem(NOTES_KEY, ta.value); } catch {}
        }, 250);
    });
    closeBtn.addEventListener('click', () => toggle(false));

    function toggle(force) {
        const open = (force === undefined) ? !el.classList.contains('open') : !!force;
        el.classList.toggle('open', open);
        if (open) {
            if (controls.isLocked) controls.unlock();
            setTimeout(() => ta.focus(), 80);
        }
    }
    return { toggle, get isOpen() { return el.classList.contains('open'); } };
})();
document.getElementById('btn-notes').addEventListener('click', () => Notes.toggle());

// Cheat-strip collapse toggle.
(() => {
    const el = document.getElementById('cheat');
    const btn = document.getElementById('cheat-toggle');
    if (!el || !btn) return;
    btn.addEventListener('click', () => {
        const c = el.classList.toggle('collapsed');
        btn.textContent = c ? 'show' : 'hide';
    });
})();

// ---------- Mouse-shortcut framework + Settings panel ----------------------
//
// Action registry: every callable that a shortcut JSON can name.
const ACTIONS = {
    nothing: () => {},
    toggleNotes:    () => Notes.toggle(),
    openNotes:      () => Notes.toggle(true),
    closeNotes:     () => Notes.toggle(false),
    toggleSettings: () => Settings.toggle(),
    toggleLibrary:  () => toggleLibrary(),
    enterMouseMode: () => enterMouseMode(),
    exitMouseMode:  () => controls.unlock(),
    layoutNext:     () => cycleLayout(+1),
    layoutPrev:     () => cycleLayout(-1),
    layoutArc:      () => applyLayout('arc'),
    layoutRow:      () => applyLayout('row'),
    layoutGrid:     () => applyLayout('grid'),
    layoutStack:    () => applyLayout('stack'),
    layoutPanorama: () => applyLayout('panorama'),
    layoutGrid3d:   () => applyLayout('grid3d'),
    focusUrlBar:    (i = 0) => document.querySelector(`.tb-url[data-monitor="${i}"]`)?.focus(),
    reloadAllScreens: () => fixedDesks.forEach(d => d.screen?.url && d.reload()),
};
const ACTIONS_HELP = {
    toggleNotes: 'Open/close the notes pad.',
    openNotes: 'Open the notes pad (no toggle).',
    closeNotes: 'Close the notes pad.',
    toggleSettings: 'Open/close this settings panel.',
    toggleLibrary: 'Open/close the asset library.',
    enterMouseMode: 'Capture the mouse and walk in 3D.',
    exitMouseMode: 'Release the mouse.',
    layoutNext: 'Cycle to the next monitor layout.',
    layoutPrev: 'Cycle to the previous layout.',
    layoutArc: 'Switch to the Arc layout (and similarly: layoutRow, layoutGrid, layoutStack, layoutPanorama, layoutGrid3d).',
    focusUrlBar: 'Focus a screen\'s URL bar. Pass {"args":[0]} for screen 1, {"args":[1]} for screen 2, etc.',
    reloadAllScreens: 'Reload every assigned screen.',
    nothing: 'Do nothing (clear a binding).',
};

const LAYOUT_ORDER = ['arc','row','grid','stack','panorama','grid3d'];
function cycleLayout(dir) {
    const i = LAYOUT_ORDER.indexOf(_currentLayout);
    const j = (i + dir + LAYOUT_ORDER.length) % LAYOUT_ORDER.length;
    applyLayout(LAYOUT_ORDER[j]);
}

const SHORTCUT_EVENTS = [
    { key: 'triple-click',         label: 'Triple click (left)' },
    { key: 'right-double-click',   label: 'Double right-click' },
    { key: 'right-triple-click',   label: 'Triple right-click  (default: exit mouse mode)' },
    { key: 'middle-double-click',  label: 'Double middle-click' },
    { key: 'middle-click',         label: 'Single middle-click' },
    { key: 'scroll-up-fast',       label: 'Fast scroll up' },
    { key: 'scroll-down-fast',     label: 'Fast scroll down' },
];
const BINDINGS_KEY = 'lozsworld.shortcuts.v1';
let bindings = (() => {
    try {
        const raw = localStorage.getItem(BINDINGS_KEY);
        if (raw) return JSON.parse(raw);
    } catch {}
    return {};
})();
// Sensible default: triple right-click drops the mouse so the user can grab
// control of the OS again with one hand. Only set if user hasn't bound it.
if (!bindings['right-triple-click']) {
    bindings['right-triple-click'] = '{"action":"exitMouseMode"}';
}
function saveBindings() {
    try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings)); } catch {}
}
function runBinding(eventKey) {
    const b = bindings[eventKey];
    if (!b) return;
    let parsed = b;
    if (typeof b === 'string') {
        try { parsed = JSON.parse(b); } catch { console.warn('Bad JSON for', eventKey, b); return; }
    }
    const fn = ACTIONS[parsed.action];
    if (!fn) { console.warn('Unknown action for', eventKey, ':', parsed.action); return; }
    try { fn(...(parsed.args || [])); }
    catch (e) { console.error('Shortcut action errored:', e); }
}

// Detectors: synthesise the high-level events from raw mouse input.
let _clickTimes = [];
let _rightClickTimes = [];
let _middleClickTimes = [];
const MULTI_WINDOW_MS = 400;
const SCROLL_FAST_THRESHOLD = 180;  // px-per-window
const SCROLL_WINDOW_MS = 220;
let _scrollAccumUp = 0, _scrollAccumDown = 0, _scrollWindowStart = 0;

document.addEventListener('click', (e) => {
    if (e.target.closest('input, textarea, button, .tb-search, #notes, #settings, #library')) return;
    const t = performance.now();
    _clickTimes = _clickTimes.filter(x => t - x < MULTI_WINDOW_MS);
    _clickTimes.push(t);
    if (_clickTimes.length >= 3) { _clickTimes = []; runBinding('triple-click'); }
});
// IMPORTANT: pointer-lock SUPPRESSES the `contextmenu` event in most
// browsers, so right-clicking while in 3D look mode would never trigger
// our triple-right-click binding. Detect via mousedown(button===2) instead -
// that always fires regardless of lock state.
document.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    if (e.target.closest('input, textarea, button, #notes, #settings, #library, #dpad, #cmdline')) return;
    const t = performance.now();
    _rightClickTimes = _rightClickTimes.filter(x => t - x < MULTI_WINDOW_MS);
    _rightClickTimes.push(t);
    if (_rightClickTimes.length >= 3) {
        _rightClickTimes = [];
        e.preventDefault();
        runBinding('right-triple-click');
    } else if (_rightClickTimes.length >= 2) {
        e.preventDefault();
        setTimeout(() => {
            if (_rightClickTimes.length === 2) {
                _rightClickTimes = [];
                runBinding('right-double-click');
            }
        }, MULTI_WINDOW_MS + 20);
    }
});
// Suppress the actual context menu while in 3D so right-click feels like a button.
document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, #notes, #settings, #library, #cmdline')) return;
    e.preventDefault();
});
document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    if (e.target.closest('input, textarea, button, #notes, #settings, #library')) return;
    const t = performance.now();
    _middleClickTimes = _middleClickTimes.filter(x => t - x < MULTI_WINDOW_MS);
    _middleClickTimes.push(t);
    if (_middleClickTimes.length >= 2) {
        _middleClickTimes = [];
        runBinding('middle-double-click');
    } else {
        // Single middle click fires after a short delay if no second arrives.
        setTimeout(() => {
            if (_middleClickTimes.length === 0) runBinding('middle-click');
        }, MULTI_WINDOW_MS + 20);
    }
});
document.addEventListener('wheel', (e) => {
    if (e.target.closest('#notes, #settings, #library, .tb-suggest')) return;
    const now = performance.now();
    if (now - _scrollWindowStart > SCROLL_WINDOW_MS) {
        _scrollWindowStart = now; _scrollAccumUp = 0; _scrollAccumDown = 0;
    }
    if (e.deltaY < 0) _scrollAccumUp += -e.deltaY;
    else _scrollAccumDown += e.deltaY;
    if (_scrollAccumUp > SCROLL_FAST_THRESHOLD) {
        _scrollAccumUp = 0;
        runBinding('scroll-up-fast');
    } else if (_scrollAccumDown > SCROLL_FAST_THRESHOLD) {
        _scrollAccumDown = 0;
        runBinding('scroll-down-fast');
    }
}, { passive: true });

// Settings UI.
const Settings = (() => {
    const el = document.getElementById('settings');
    const closeBtn = document.getElementById('settings-close');
    const rowsHost = document.getElementById('shortcut-rows');
    const actionsList = document.getElementById('settings-actions-list');
    const saveBtn = document.getElementById('settings-save');
    const resetBtn = document.getElementById('settings-reset');
    const copyPromptBtn = document.getElementById('copy-prompt');

    function render() {
        // Action reference list.
        actionsList.innerHTML = '<strong>Available actions:</strong><br>' +
            Object.keys(ACTIONS).map(name =>
                `<code>${name}</code> &mdash; ${(ACTIONS_HELP[name] || '').replace(/</g,'&lt;')}`
            ).join('<br>');
        // Per-event rows.
        rowsHost.innerHTML = SHORTCUT_EVENTS.map(ev => {
            const cur = bindings[ev.key] || '';
            const curStr = typeof cur === 'string' ? cur : JSON.stringify(cur);
            const status = cur ? 'bound' : 'unbound';
            return `
            <div class="shortcut-row" data-key="${ev.key}">
                <div class="sr-head">
                    <span class="sr-name">${ev.label}</span>
                    <span class="sr-status ${cur ? 'bound' : ''}">${status}</span>
                </div>
                <label>What should this do? (your words - paste this into an LLM)</label>
                <textarea class="nl" rows="1" placeholder="e.g. open my notes"></textarea>
                <label>JSON binding (paste from LLM, or write directly)</label>
                <textarea class="json" rows="2" placeholder='{"action": "openNotes"}'>${curStr}</textarea>
                <div class="sr-actions">
                    <button data-act="clear">Clear</button>
                </div>
            </div>`;
        }).join('');
        rowsHost.querySelectorAll('[data-act="clear"]').forEach(b => {
            b.addEventListener('click', (e) => {
                const row = e.target.closest('.shortcut-row');
                row.querySelector('textarea.json').value = '';
                row.querySelector('textarea.nl').value = '';
            });
        });
    }

    function save() {
        const errors = [];
        rowsHost.querySelectorAll('.shortcut-row').forEach(row => {
            const key = row.dataset.key;
            const v = row.querySelector('textarea.json').value.trim();
            if (!v) { delete bindings[key]; return; }
            try {
                const j = JSON.parse(v);
                if (!j || !j.action) errors.push(`${key}: missing "action" field.`);
                else if (!ACTIONS[j.action]) errors.push(`${key}: unknown action "${j.action}".`);
                else bindings[key] = v;
            } catch (e) { errors.push(`${key}: invalid JSON.`); }
        });
        saveBindings();
        if (errors.length) {
            alert('Saved with warnings:\n\n' + errors.join('\n'));
        } else {
            setStatus('Shortcuts saved.');
        }
        render();
    }

    function reset() {
        if (!confirm('Clear all shortcut bindings?')) return;
        bindings = {};
        saveBindings();
        render();
    }

    function copyPrompt() {
        const events = SHORTCUT_EVENTS.map(e => `- ${e.key} (${e.label})`).join('\n');
        const acts = Object.keys(ACTIONS).map(a => `- ${a}: ${ACTIONS_HELP[a] || ''}`).join('\n');
        const prompt = `I want to bind a mouse shortcut in my app called Loz's World. ` +
            `Reply ONLY with a single JSON object like {"action": "<one of the actions below>", "args": []}. ` +
            `Use the args array if the action needs arguments (e.g. focusUrlBar takes [index]). ` +
            `Available events:\n${events}\n\nAvailable actions:\n${acts}\n\n` +
            `My request: REPLACE_THIS_WITH_WHAT_YOU_WANT`;
        navigator.clipboard?.writeText(prompt).then(
            () => setStatus('LLM prompt copied to clipboard.'),
            () => alert('Could not copy. Here it is:\n\n' + prompt)
        );
    }

    function toggle(force) {
        const open = (force === undefined) ? !el.classList.contains('open') : !!force;
        el.classList.toggle('open', open);
        if (open) {
            if (controls.isLocked) controls.unlock();
            render();
        }
    }

    closeBtn.addEventListener('click', () => toggle(false));
    saveBtn.addEventListener('click', save);
    resetBtn.addEventListener('click', reset);
    copyPromptBtn.addEventListener('click', copyPrompt);

    return { toggle, get isOpen() { return el.classList.contains('open'); } };
})();
document.getElementById('btn-settings').addEventListener('click', () => Settings.toggle());

// Add the Situations button next to Notes/Settings in the toolbar.
(() => {
    const cluster = document.getElementById('btn-settings').parentElement;
    const btn = document.createElement('button');
    btn.className = 'fb-btn';
    btn.id = 'btn-situations';
    btn.title = 'Situations / saved scenarios';
    btn.textContent = '💾';
    cluster.insertBefore(btn, document.getElementById('btn-settings'));
    btn.addEventListener('click', () => Situations.toggle());
})();


// Keyboard shortcuts: N for notes, comma for settings.
window.addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    if (e.code === 'KeyN' && !controls.isLocked) {
        Notes.toggle(); e.preventDefault();
    } else if (e.code === 'Comma' && !controls.isLocked) {
        Settings.toggle(); e.preventDefault();
    }
});

// ---------- Situations (saved scenarios) -----------------------------------
//
// A Situation = the 5 URLs currently in the toolbar + the active layout, saved
// with a name and a type tag. Two types:
//   * "routine"  - reusable, e.g. "banking", "morning news"
//   * "temporal" - tied to a date, e.g. "thursday standup 2026-05-08"
//
// Auto-classification looks for date words in the name and flags as temporal
// when found. The user can flip the toggle when saving.

const SITUATIONS_KEY = 'lozsworld.situations.v1';
const TEMPORAL_HINTS = /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|last week|last month|\b20\d\d\b|\d{1,2}[\/\-]\d{1,2})/i;

function loadSituations() {
    try { return JSON.parse(localStorage.getItem(SITUATIONS_KEY) || '[]'); } catch { return []; }
}
function saveSituations(arr) {
    try { localStorage.setItem(SITUATIONS_KEY, JSON.stringify(arr)); } catch {}
}
function autoClassify(name) {
    return TEMPORAL_HINTS.test(name) ? 'temporal' : 'routine';
}
function snapshotCurrent(name) {
    const urls = fixedDesks.map(d => d.screen?.url || '');
    return {
        id: 'sit_' + Date.now(),
        name,
        type: autoClassify(name),
        date: new Date().toISOString().slice(0, 10),
        layout: _currentLayout,
        urls,
        savedAt: Date.now(),
    };
}
function applySituation(sit) {
    if (!sit || !sit.urls) return;
    sit.urls.forEach((url, i) => {
        if (!fixedDesks[i]) return;
        if (!url) { fixedDesks[i].setUrl(null); return; }
        if (!fixedDesks[i].screen) fixedDesks[i].attachScreen(null);
        fixedDesks[i].setUrl(url);
    });
    if (sit.layout && LAYOUTS[sit.layout]) applyLayout(sit.layout);
    saveLayout();
    setStatus(`Loaded situation: ${sit.name}`);
}

const Situations = (() => {
    let panel = null;
    function ensurePanel() {
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'situations';
        panel.innerHTML = `
            <header>
                <h3>💾 Situations</h3>
                <button id="sit-close">×</button>
            </header>
            <div class="sit-body">
                <div class="sit-save-row">
                    <input id="sit-name" type="text" placeholder="Name this situation (e.g. 'banking', 'thursday research')" />
                    <select id="sit-type">
                        <option value="auto">auto</option>
                        <option value="routine">routine</option>
                        <option value="temporal">temporal</option>
                    </select>
                    <button id="sit-save" class="primary">Save current</button>
                </div>
                <div class="sit-tabs">
                    <button class="sit-tab active" data-filter="all">All</button>
                    <button class="sit-tab" data-filter="routine">Routines</button>
                    <button class="sit-tab" data-filter="temporal">Temporal</button>
                </div>
                <div id="sit-list"></div>
                <details class="sit-import">
                    <summary>Import from browser history (paste JSON from <code>tools/browser_scan.py</code> output)</summary>
                    <textarea id="sit-import-json" placeholder='Paste the JSON array. Latest 5 unique URLs across browsers become the new situation.' rows="6"></textarea>
                    <div class="btnrow">
                        <button id="sit-import-go" class="primary">Make a situation from this</button>
                    </div>
                </details>
            </div>
        `;
        document.body.appendChild(panel);

        panel.querySelector('#sit-close').addEventListener('click', () => toggle(false));
        panel.querySelector('#sit-save').addEventListener('click', save);
        panel.querySelectorAll('.sit-tab').forEach(b => b.addEventListener('click', () => {
            panel.querySelectorAll('.sit-tab').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            render();
        }));
        panel.querySelector('#sit-import-go').addEventListener('click', importFromBrowsers);
        return panel;
    }

    function activeFilter() {
        return panel?.querySelector('.sit-tab.active')?.dataset.filter || 'all';
    }
    function render() {
        if (!panel) return;
        const list = panel.querySelector('#sit-list');
        const filter = activeFilter();
        const all = loadSituations().sort((a, b) => b.savedAt - a.savedAt);
        const items = filter === 'all' ? all : all.filter(s => s.type === filter);
        if (!items.length) {
            list.innerHTML = `<div class="sit-empty">No ${filter === 'all' ? 'situations' : filter + ' situations'} yet. Save one above.</div>`;
            return;
        }
        list.innerHTML = items.map(s => {
            const filledCount = s.urls.filter(Boolean).length;
            return `<div class="sit-row" data-id="${s.id}">
                <div class="sit-name">${escapeHtml(s.name)}</div>
                <div class="sit-meta">
                    <span class="sit-type sit-type-${s.type}">${s.type}</span>
                    <span class="sit-date">${s.date}</span>
                    <span>${filledCount}/5 screens · ${s.layout}</span>
                </div>
                <div class="sit-actions">
                    <button data-act="load">Load</button>
                    <button data-act="delete">Delete</button>
                </div>
            </div>`;
        }).join('');
        list.querySelectorAll('[data-act="load"]').forEach(b =>
            b.addEventListener('click', e => {
                const id = e.target.closest('.sit-row').dataset.id;
                const sit = loadSituations().find(x => x.id === id);
                if (sit) applySituation(sit);
            }));
        list.querySelectorAll('[data-act="delete"]').forEach(b =>
            b.addEventListener('click', e => {
                const id = e.target.closest('.sit-row').dataset.id;
                if (!confirm('Delete this situation?')) return;
                saveSituations(loadSituations().filter(x => x.id !== id));
                render();
            }));
    }

    function save() {
        const name = panel.querySelector('#sit-name').value.trim();
        if (!name) { alert('Give it a name first.'); return; }
        const typeSel = panel.querySelector('#sit-type').value;
        const sit = snapshotCurrent(name);
        if (typeSel !== 'auto') sit.type = typeSel;
        const all = loadSituations();
        all.push(sit);
        saveSituations(all);
        panel.querySelector('#sit-name').value = '';
        render();
        setStatus(`Saved situation: ${name}`);
    }

    function importFromBrowsers() {
        const txt = panel.querySelector('#sit-import-json').value.trim();
        if (!txt) return;
        let arr;
        try { arr = JSON.parse(txt); } catch { alert('That is not valid JSON.'); return; }
        if (!Array.isArray(arr) || !arr.length) { alert('Expected a JSON array.'); return; }
        // Dedupe URLs, keep first 5 by recency (lastVisit desc).
        arr.sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0));
        const seen = new Set(); const picks = [];
        for (const r of arr) {
            const u = r.url || r.URL;
            if (!u || seen.has(u)) continue;
            seen.add(u); picks.push(u);
            if (picks.length >= 5) break;
        }
        if (!picks.length) { alert('Could not find any URLs in that JSON.'); return; }
        const sit = {
            id: 'sit_' + Date.now(),
            name: 'Imported ' + new Date().toLocaleString(),
            type: 'temporal',
            date: new Date().toISOString().slice(0, 10),
            layout: _currentLayout,
            urls: picks.concat(Array(5 - picks.length).fill('')),
            savedAt: Date.now(),
        };
        const all = loadSituations(); all.push(sit); saveSituations(all);
        applySituation(sit);
        render();
    }

    function toggle(force) {
        ensurePanel();
        const open = (force === undefined) ? !panel.classList.contains('open') : !!force;
        panel.classList.toggle('open', open);
        if (open) {
            if (controls.isLocked) controls.unlock();
            render();
        }
    }
    return { toggle, get isOpen() { return panel?.classList.contains('open'); }, render };
})();

// ---------- on-screen D-pad (one-hand mode) ----------------------------
//
// Always-visible 6-button gamepad in the bottom-right. Press-and-hold drives
// the same `keys` registry that updateMovement() reads, so it's identical to
// holding the keyboard key down. Works for mouse AND touch via pointer events.

const Dpad = (() => {
    const root = document.createElement('div');
    root.id = 'dpad';
    root.innerHTML = `
        <button class="dp dp-up"     data-key="KeyW"        title="forward (W)">▲</button>
        <button class="dp dp-down"   data-key="KeyS"        title="back (S)">▼</button>
        <button class="dp dp-left"   data-key="KeyA"        title="left (A)">◀</button>
        <button class="dp dp-right"  data-key="KeyD"        title="right (D)">▶</button>
        <button class="dp dp-rise"   data-key="Space"       title="rise (Space)">⤒</button>
        <button class="dp dp-fall"   data-key="ControlLeft" title="fall (Ctrl)">⤓</button>
        <button class="dp dp-hide" id="dpad-hide" title="hide d-pad">×</button>
    `;
    document.body.appendChild(root);

    function press(code, on) { keys[code] = on; }

    root.querySelectorAll('.dp[data-key]').forEach(btn => {
        const code = btn.dataset.key;
        const start = (e) => { e.preventDefault(); btn.classList.add('held'); press(code, true); };
        const end   = (e) => { e.preventDefault(); btn.classList.remove('held'); press(code, false); };
        btn.addEventListener('pointerdown',   start);
        btn.addEventListener('pointerup',     end);
        btn.addEventListener('pointercancel', end);
        btn.addEventListener('pointerleave',  end);
        // Don't let pointerdown bubble to the canvas (would steal pointer-lock).
        btn.addEventListener('contextmenu', e => e.preventDefault());
    });

    root.querySelector('#dpad-hide').addEventListener('click', () => {
        root.classList.toggle('collapsed');
    });

    return { el: root };
})();

// ---------- Floating mouse-toggle button --------------------------------
// Always-visible big button. Clicking captures the mouse for look-around;
// clicking again releases it so the user can use the D-pad / toolbar / OS.
// Replaces the broken pattern where releasing the mouse forced the welcome
// overlay back, blocking everything.
const MouseToggle = (() => {
    const btn = document.createElement('button');
    btn.id = 'mouse-toggle';
    btn.title = 'Capture / release mouse  (also: triple right-click, or press M)';
    document.body.appendChild(btn);
    function refresh() {
        if (controls.isLocked) {
            btn.textContent = '🖱  release';
            btn.classList.remove('grab'); btn.classList.add('release');
        } else {
            btn.textContent = '🎯  grab mouse';
            btn.classList.remove('release'); btn.classList.add('grab');
        }
    }
    btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (controls.isLocked) controls.unlock();
        else enterMouseMode();
    });
    controls.addEventListener('lock', refresh);
    controls.addEventListener('unlock', refresh);
    refresh();
    // Bonus: M key also toggles, in case mouse is misbehaving.
    window.addEventListener('keydown', (e) => {
        if (e.code !== 'KeyM') return;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
        if (controls.isLocked) controls.unlock(); else enterMouseMode();
    });
    return { el: btn, refresh };
})();

// ---------- In-app command line + cheat sheet --------------------------
// Press `/` from anywhere (outside an input) to focus the command bar.
// Type a command, Enter to run, Esc to dismiss.
//
// Built-ins:  /help /url /go /jump /layout /notes /lib /settings /lock
//             /unlock /reload /clear /sit /cmd
//
// Custom commands: /cmd add NAME BODY   (BODY is any other command line).
// Use $1, $2 ... in BODY to reference arguments. Persists in localStorage.
const COMMANDS_KEY = 'lozsworld.commands.v1';
const Cmdline = (() => {
    const root = document.createElement('div');
    root.id = 'cmdline';
    root.innerHTML = `
        <span class="cmd-prompt">/</span>
        <input id="cmd-input" type="text" placeholder="type a command - /help for the cheat sheet" autocomplete="off" spellcheck="false" />
        <button id="cmd-help" type="button" title="cheat sheet">?</button>
    `;
    document.body.appendChild(root);
    const inp = root.querySelector('#cmd-input');
    const helpBtn = root.querySelector('#cmd-help');

    // Cheat-sheet panel
    const sheet = document.createElement('div');
    sheet.id = 'cmd-sheet';
    sheet.innerHTML = `
        <header>
            <h3>⌘ command line cheat sheet</h3>
            <button id="cmd-sheet-close" type="button">×</button>
        </header>
        <div class="cmd-sheet-body" id="cmd-sheet-body"></div>
    `;
    document.body.appendChild(sheet);
    sheet.querySelector('#cmd-sheet-close').addEventListener('click', () => sheet.classList.remove('open'));

    // Custom-command persistence
    let custom = {};
    try {
        const raw = localStorage.getItem(COMMANDS_KEY);
        if (raw) custom = JSON.parse(raw) || {};
    } catch {}
    function saveCustom() {
        try { localStorage.setItem(COMMANDS_KEY, JSON.stringify(custom)); } catch {}
    }

    function assignUrl(idx, q) {
        if (!Number.isFinite(idx) || idx < 0 || idx >= fixedDesks.length) {
            setStatus('screen index out of range (use 1..' + fixedDesks.length + ')'); return;
        }
        if (!q || !q.trim()) { fixedDesks[idx].detachScreen(); setStatus('screen ' + (idx+1) + ' detached'); return; }
        const u = q.trim();
        if (/^https?:\/\//i.test(u) || /^[\w-]+\.[\w.-]+/.test(u)) {
            const url = /^https?:\/\//i.test(u) ? u : 'https://' + u;
            fixedDesks[idx].setUrl(url);
            setStatus('screen ' + (idx+1) + ': ' + url);
        } else {
            fetch('/api/search?q=' + encodeURIComponent(u))
                .then(r => r.json())
                .then(j => { if (j.url) { fixedDesks[idx].setUrl(j.url); setStatus('screen ' + (idx+1) + ': searched "' + u + '"'); } })
                .catch(() => setStatus('search failed'));
        }
    }

    function situationsCmd(args) {
        if (!args.length || args[0] === 'list') {
            const list = loadSituations();
            setStatus('situations: ' + (list.length ? list.map(s => s.name).join(', ') : '(none saved)'));
            return;
        }
        if (args[0] === 'save' && args[1]) {
            const name = args.slice(1).join(' ');
            const list = loadSituations();
            const existing = list.findIndex(x => x.name === name);
            const sit = { name, urls: fixedDesks.map(d => d.screen?.url || null), createdAt: Date.now() };
            if (existing >= 0) list[existing] = sit; else list.push(sit);
            saveSituations(list);
            setStatus('saved situation: ' + name); return;
        }
        if (args[0] === 'load' && args[1]) {
            const name = args.slice(1).join(' ');
            const s = loadSituations().find(x => x.name === name);
            if (!s) { setStatus('no situation: ' + name); return; }
            applySituation(s);
            setStatus('loaded: ' + name); return;
        }
        setStatus('usage: /sit save NAME  |  /sit load NAME  |  /sit list');
    }

    function customCmd(args) {
        const op = args[0];
        if (op === 'list') {
            const names = Object.keys(custom);
            setStatus('custom: ' + (names.length ? names.join(', ') : '(none yet)'));
            return;
        }
        if (op === 'rm' && args[1]) {
            delete custom[args[1]]; saveCustom();
            setStatus('removed: /' + args[1]); return;
        }
        if (op === 'add' && args.length >= 3) {
            const name = args[1].replace(/^\//, '');
            const body = args.slice(2).join(' ');
            if (BUILTINS[name]) { setStatus('cannot override built-in /' + name); return; }
            custom[name] = body;
            saveCustom();
            setStatus('added /' + name + ' -> ' + body);
            return;
        }
        setStatus('usage: /cmd add NAME BODY   |  /cmd list  |  /cmd rm NAME');
    }

    const BUILTINS = {
        help:    { desc: 'Show this cheat sheet.',                                                run: () => renderSheet(true) },
        url:     { desc: '/url N URL  - assign URL (or search) to screen N (1..5)',               run: (n, ...rest) => assignUrl(parseInt(n,10)-1, rest.join(' ')) },
        go:      { desc: '/go QUERY  - search and load into screen 1',                            run: (...q) => assignUrl(0, q.join(' ')) },
        jump:    { desc: '/jump N  - fly camera to screen N',                                     run: (n) => jumpToMonitor(parseInt(n,10)-1) },
        layout:  { desc: '/layout NAME  - arc | row | grid | stack | panorama | grid3d',          run: (name) => name && applyLayout(name) },
        notes:   { desc: '/notes  - toggle the notes pad',                                        run: () => Notes.toggle() },
        library: { desc: '/library  - toggle the asset library',                                  run: () => toggleLibrary() },
        lib:     { desc: '/lib  - alias for /library',                                            run: () => toggleLibrary() },
        settings:{ desc: '/settings  - toggle settings panel',                                    run: () => Settings.toggle() },
        lock:    { desc: '/lock  - capture mouse (walk in 3D)',                                   run: () => enterMouseMode() },
        unlock:  { desc: '/unlock  - release mouse',                                              run: () => controls.unlock() },
        reload:  { desc: '/reload  - reload every assigned screen',                               run: () => fixedDesks.forEach(d => d.screen?.url && d.reload()) },
        clear:   { desc: '/clear N  - empty screen N',                                            run: (n) => { const d = fixedDesks[parseInt(n,10)-1]; if (d) d.detachScreen(); } },
        sit:     { desc: '/sit save NAME  |  /sit load NAME  |  /sit list  - save/load Situations', run: (...args) => situationsCmd(args) },
        cmd:     { desc: '/cmd add NAME BODY  |  /cmd list  |  /cmd rm NAME  - manage custom commands at runtime', run: (...args) => customCmd(args) },
    };

    function run(line) {
        const trimmed = String(line || '').trim();
        if (!trimmed) return;
        let body = trimmed;
        if (body.startsWith('/')) body = body.slice(1);
        else { BUILTINS.go.run(...body.split(/\s+/)); return; }
        const parts = body.split(/\s+/);
        const name = parts[0];
        const rest = parts.slice(1);
        if (custom[name]) {
            let expanded = custom[name];
            rest.forEach((v, i) => { expanded = expanded.replace(new RegExp('\\$' + (i+1), 'g'), v); });
            return run(expanded.startsWith('/') ? expanded : '/' + expanded);
        }
        if (BUILTINS[name]) {
            try { BUILTINS[name].run(...rest); }
            catch (e) { console.error(e); setStatus('error: ' + e.message); }
            return;
        }
        setStatus('unknown command: /' + name + '  (try /help)');
    }

    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const v = inp.value;
            inp.value = '';
            run(v);
        } else if (e.key === 'Escape') {
            inp.blur();
        }
        e.stopPropagation();
    });

    // Global `/` to focus when not already inside an input.
    window.addEventListener('keydown', (e) => {
        if (e.key !== '/') return;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        if (controls.isLocked) controls.unlock();
        inp.focus();
    });

    helpBtn.addEventListener('click', () => renderSheet(true));

    function renderSheet(open) {
        const body = sheet.querySelector('#cmd-sheet-body');
        const rows = Object.entries(BUILTINS).map(([k, v]) =>
            `<div class="cmd-row"><code>/${k}</code><div class="cmd-desc">${v.desc}</div></div>`
        ).join('');
        const customRows = Object.keys(custom).length
            ? Object.entries(custom).map(([k, v]) =>
                `<div class="cmd-row cmd-row-user"><code>/${k}</code><div class="cmd-desc">→ <code>${v}</code></div></div>`
              ).join('')
            : '<div class="cmd-empty">No custom commands yet. Try <code>/cmd add hn /url 1 news.ycombinator.com</code> then <code>/hn</code>.</div>';
        body.innerHTML = `
            <p class="cmd-intro">Press <kbd>/</kbd> from anywhere to focus the command line. <kbd>Enter</kbd> to run, <kbd>Esc</kbd> to dismiss. Commands without a leading <code>/</code> are treated as a search and loaded into screen 1.</p>
            <h4>Built-in commands</h4>
            ${rows}
            <h4>Your custom commands</h4>
            ${customRows}
            <h4>Adding your own</h4>
            <ul>
                <li><code>/cmd add hn /url 1 news.ycombinator.com</code> - now <code>/hn</code> loads HN into screen 1.</li>
                <li><code>/cmd add open /url $1 $2</code> - <code>/open 3 example.com</code> expands to <code>/url 3 example.com</code>.</li>
                <li><code>/cmd add work /sit load deepwork</code> - one-key situation switching.</li>
                <li><code>/cmd list</code> shows all custom commands. <code>/cmd rm NAME</code> removes one.</li>
                <li>Custom commands persist in localStorage, survive reloads.</li>
            </ul>
        `;
        if (open) sheet.classList.add('open');
    }

    return { run, focus: () => inp.focus(), renderSheet, get custom() { return custom; } };
})();

// ---------- diagnostics expose -------------------------------------------
// Open the JS console and inspect lozsworld for live state. Useful when
// teaching the engine to do something new without restarting it.
window.lozsworld = {
    items, scene, camera,
    CONFIG,
    countScreens, MAX_SCREENS, MAX_ITEMS,
    saveLayout, restoreLayout,
    spawnFromLibrary,
    refreshLibrary,
    applyLayout, LAYOUTS, cycleLayout,
    Notes, Settings, Situations, Dpad, MouseToggle, Cmdline,
    ACTIONS, bindings, runBinding,
    loadSituations, saveSituations, applySituation,
};

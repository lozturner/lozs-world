// =============================================================================
//  Loz's World - fast block generation
//
//  The room shell (walls, floors, ceilings, ramps, pillars, doorways) gets
//  treated differently from "trickle" objects (chairs, screens, dropped GLBs).
//  Shell pieces snap to a 1m grid, place in one keystroke, extrude in rows,
//  and survive the item-cap recycler. The point is: building a memory-palace
//  street should feel like Lego, not like wrestling with a 3D modeller.
//
//  Design decisions
//  ----------------
//  * Block items reuse the existing Item class so disposal, grabbing, and
//    persistence stay uniform. They get kind: 'shell' so the cap-recycler
//    skips them (a half-built room must never disappear because you spawned
//    a 65th decorative chair).
//  * Geometry is procedural and dimensionally exact - 1m floor tiles, 2m
//    walls, 0.15m wall thickness. No asset round-trips.
//  * MotherSort is a deterministic placement oracle: given a block kind and
//    the camera pose, it picks the most likely snap target by walking the
//    existing block topology (nearest floor edge for floors, nearest floor
//    edge for walls, top of nearest wall stack for ceilings, etc.). Cheap,
//    no AI calls, predictable.
//  * Hotkeys are 1..6 to place straight-ahead and Shift+1..6 to invoke
//    MotherSort. Bracket keys [ ] ; ' extrude the last placed block by one
//    grid unit on x/z so a wall becomes a row of walls in two keystrokes.
//  * Persistence: blocks serialize to a flat array with kind + matrix; the
//    layout schema bumps to v3 but v2 still loads.
// =============================================================================

import * as THREE from 'three';

const GRID = 1.0;                  // grid step (m) for floors/walls in the x/z plane
const WALL_H = 2.0;                // wall height (m); also the y-step for stacking
const WALL_T = 0.15;               // wall thickness (m)
const FLOOR_T = 0.08;              // floor / ceiling slab thickness (m)
const PILLAR_W = 0.4;

const PALETTE = {
    floor:   { fill: 0xd9d2bf, edge: 0x6a7a4a, label: 'Floor'   },
    wall:    { fill: 0xeae3d2, edge: 0x2f5fb8, label: 'Wall'    },
    ceiling: { fill: 0xefe8d4, edge: 0x9b8556, label: 'Ceiling' },
    pillar:  { fill: 0xd4ccb6, edge: 0x1c1814, label: 'Pillar'  },
    doorway: { fill: 0xeae3d2, edge: 0xc2682c, label: 'Doorway' },
    ramp:    { fill: 0xd9d2bf, edge: 0x2f5fb8, label: 'Ramp'    },
};

const KIND_ORDER = ['floor', 'wall', 'ceiling', 'pillar', 'doorway', 'ramp'];

function snap(v, step) { return Math.round(v / step) * step; }
function snapXZ(v, step = GRID) { return snap(v, step); }

// ----- procedural geometry ---------------------------------------------------
function buildBlockMesh(kind) {
    const p = PALETTE[kind];
    const fillMat = new THREE.MeshStandardMaterial({
        color: p.fill, roughness: 0.92, metalness: 0.0,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: p.edge });

    const group = new THREE.Group();
    group.name = p.label;

    const addBox = (w, h, d, x = 0, y = h / 2, z = 0) => {
        const geom = new THREE.BoxGeometry(w, h, d);
        const mesh = new THREE.Mesh(geom, fillMat);
        mesh.position.set(x, y, z);
        group.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), edgeMat);
        edges.position.set(x, y, z);
        group.add(edges);
        return mesh;
    };

    if (kind === 'floor') {
        addBox(GRID, FLOOR_T, GRID, 0, FLOOR_T / 2, 0);
    } else if (kind === 'ceiling') {
        addBox(GRID, FLOOR_T, GRID, 0, WALL_H - FLOOR_T / 2, 0);
    } else if (kind === 'wall') {
        addBox(GRID, WALL_H, WALL_T, 0, WALL_H / 2, 0);
    } else if (kind === 'pillar') {
        addBox(PILLAR_W, WALL_H, PILLAR_W, 0, WALL_H / 2, 0);
    } else if (kind === 'doorway') {
        // Two side jambs + a lintel, leaving a 0.6m x 1.6m hole in the middle.
        const openingW = 0.6;
        const openingH = 1.6;
        const jambW = (GRID - openingW) / 2;
        const jambX = (GRID - jambW) / 2;
        addBox(jambW, WALL_H, WALL_T, -jambX, WALL_H / 2, 0);
        addBox(jambW, WALL_H, WALL_T,  jambX, WALL_H / 2, 0);
        const lintelH = WALL_H - openingH;
        if (lintelH > 0.05) {
            addBox(openingW, lintelH, WALL_T, 0, openingH + lintelH / 2, 0);
        }
    } else if (kind === 'ramp') {
        // Right-angle prism (triangular cross-section in y/z) using a custom geometry.
        // Hypotenuse goes from front-floor to back-top.
        const w = GRID, h = WALL_H * 0.6, d = GRID;
        const verts = new Float32Array([
            // -X face (triangle)
            -w/2, 0,  d/2,   -w/2, 0, -d/2,   -w/2, h, -d/2,
            // +X face (triangle)
             w/2, 0,  d/2,    w/2, h, -d/2,    w/2, 0, -d/2,
            // bottom (quad as 2 tris)
            -w/2, 0,  d/2,    w/2, 0, -d/2,   -w/2, 0, -d/2,
            -w/2, 0,  d/2,    w/2, 0,  d/2,    w/2, 0, -d/2,
            // back wall (quad)
            -w/2, 0, -d/2,    w/2, 0, -d/2,    w/2, h, -d/2,
            -w/2, 0, -d/2,    w/2, h, -d/2,   -w/2, h, -d/2,
            // sloped top (quad)
            -w/2, 0,  d/2,   -w/2, h, -d/2,    w/2, h, -d/2,
            -w/2, 0,  d/2,    w/2, h, -d/2,    w/2, 0,  d/2,
        ]);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        geom.computeVertexNormals();
        const mesh = new THREE.Mesh(geom, fillMat);
        group.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), edgeMat);
        group.add(edges);
    }

    return group;
}

// ----- runtime ---------------------------------------------------------------
//
// The runtime is created once world.js has built its Item class, items list,
// scene, camera, and saveLayout/setStatus helpers. We pass them in rather
// than re-importing them so this file stays a pure module without circular
// imports.

export function createBlocksRuntime({ Item, items, camera, setStatus, saveLayout }) {
    let lastPlaced = null;

    function makeBlock(kind, position, rotationY = 0) {
        if (!PALETTE[kind]) {
            setStatus(`Unknown block kind: ${kind}`);
            return null;
        }
        const wrapper = new THREE.Group();
        wrapper.add(buildBlockMesh(kind));
        wrapper.position.copy(position);
        wrapper.rotation.y = rotationY;
        const item = new Item({
            object3d: wrapper,
            name: PALETTE[kind].label,
            kind: 'shell',
            sourceUrl: null,
        });
        item.blockKind = kind;
        lastPlaced = item;
        return item;
    }

    // Floor blocks anchor at y=0; walls anchor with their base at y=0; ceilings
    // anchor at WALL_H (top of a wall). Returns the position the block's
    // wrapper Group should be placed at to land on the grid.
    function snapPosition(kind, x, y, z) {
        const sx = snapXZ(x);
        const sz = snapXZ(z);
        let sy;
        if (kind === 'ceiling') {
            // Snap to nearest wall-top in increments of WALL_H, default 0.
            sy = Math.max(0, Math.round(y / WALL_H) * WALL_H);
        } else if (kind === 'floor') {
            sy = Math.round(y / WALL_H) * WALL_H;
            if (sy < 0) sy = 0;
        } else {
            sy = Math.max(0, Math.round(y / WALL_H) * WALL_H);
        }
        return new THREE.Vector3(sx, sy, sz);
    }

    // Where is the camera looking right now, on the floor plane?
    function cameraFootprint(distance = 2.0) {
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        fwd.y = 0; fwd.normalize();
        const out = camera.position.clone().addScaledVector(fwd, distance);
        out.y = 0;
        return { pos: out, fwd };
    }

    function yawFromDirection(dir) {
        // Round camera yaw to nearest 90-degree facing so walls align to grid.
        const yaw = Math.atan2(dir.x, dir.z); // 0 = +Z, increases CW
        return Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
    }

    // Place a block straight in front of the camera, snapped to the grid.
    function placeAtCamera(kind) {
        const { pos, fwd } = cameraFootprint(GRID * 1.5);
        const snapped = snapPosition(kind, pos.x, pos.y, pos.z);
        const rotY = (kind === 'wall' || kind === 'doorway') ? yawFromDirection(fwd) : 0;
        const item = makeBlock(kind, snapped, rotY);
        if (item) {
            setStatus(`Placed ${PALETTE[kind].label} at (${snapped.x.toFixed(0)}, ${snapped.z.toFixed(0)})`);
            saveLayout();
        }
        return item;
    }

    // ----- MotherSort: deterministic-but-clever placement ------------------
    //
    // Instead of "spawn at the camera footprint", MotherSort looks at the
    // existing shell items and picks the most contextually appropriate snap
    // target near the player's gaze. Rules:
    //   floor   -> extend the nearest floor in the direction the camera faces
    //   wall    -> snap to the perimeter of the nearest floor, choosing the
    //              edge facing the player; otherwise drop where the camera looks
    //   ceiling -> stack on top of the nearest wall column (y = WALL_H)
    //   pillar  -> snap to a corner of the nearest floor tile
    //   doorway -> same logic as wall, but biased to the side facing player
    //   ramp    -> in front of the nearest wall, pointing toward camera
    function shellsOfKind(kind) {
        return items.filter(it => it.kind === 'shell' && it.blockKind === kind);
    }

    function nearestShell(kind, p) {
        let best = null, bestD = Infinity;
        for (const it of shellsOfKind(kind)) {
            const d = it.object3d.position.distanceToSquared(p);
            if (d < bestD) { bestD = d; best = it; }
        }
        return best;
    }

    function motherSort(kind) {
        const { pos, fwd } = cameraFootprint(GRID * 1.0);
        let target = pos.clone();
        let rotY = 0;

        if (kind === 'floor') {
            const near = nearestShell('floor', pos);
            if (near) {
                target.copy(near.object3d.position);
                target.x += Math.sign(fwd.x || 0) * GRID || (fwd.z !== 0 ? 0 : GRID);
                target.z += Math.sign(fwd.z || 0) * GRID;
            }
        } else if (kind === 'wall' || kind === 'doorway') {
            const near = nearestShell('floor', pos);
            if (near) {
                target.copy(near.object3d.position);
                // Push half a tile + half wall-thickness toward the player gaze.
                const offset = GRID / 2 + WALL_T / 2;
                if (Math.abs(fwd.x) > Math.abs(fwd.z)) {
                    target.x += Math.sign(fwd.x) * offset;
                    rotY = Math.PI / 2;
                } else {
                    target.z += Math.sign(fwd.z) * offset;
                    rotY = 0;
                }
            } else {
                rotY = yawFromDirection(fwd);
            }
        } else if (kind === 'ceiling') {
            const nearWall = nearestShell('wall', pos);
            const nearFloor = nearestShell('floor', pos);
            const near = nearWall || nearFloor;
            if (near) target.copy(near.object3d.position);
            // ceiling slab is offset to y=WALL_H by its mesh; wrapper stays at y=0
            target.y = 0;
        } else if (kind === 'pillar') {
            const near = nearestShell('floor', pos);
            if (near) {
                target.copy(near.object3d.position);
                target.x += Math.sign(fwd.x || 1) * GRID / 2;
                target.z += Math.sign(fwd.z || 1) * GRID / 2;
            }
        } else if (kind === 'ramp') {
            rotY = yawFromDirection(fwd);
        }

        const snapped = snapPosition(kind, target.x, target.y, target.z);
        const item = makeBlock(kind, snapped, rotY);
        if (item) {
            setStatus(`MotherSort: ${PALETTE[kind].label} -> (${snapped.x.toFixed(0)}, ${snapped.z.toFixed(0)})`);
            saveLayout();
        }
        return item;
    }

    // ----- Extrude (fast row-fill) -----------------------------------------
    function extrude(axis, dir) {
        if (!lastPlaced || lastPlaced.kind !== 'shell') {
            setStatus('extrude: no last block; place one first (1..6)');
            return null;
        }
        const kind = lastPlaced.blockKind;
        const p = lastPlaced.object3d.position.clone();
        const r = lastPlaced.object3d.rotation.y;
        if (axis === 'x') p.x += dir * GRID;
        if (axis === 'z') p.z += dir * GRID;
        if (axis === 'y') p.y = Math.max(0, p.y + dir * WALL_H);
        const item = makeBlock(kind, p, r);
        if (item) {
            setStatus(`Extruded ${PALETTE[kind].label} ${axis}${dir > 0 ? '+' : '-'}`);
            saveLayout();
        }
        return item;
    }

    // ----- Persistence ----------------------------------------------------
    function serialize() {
        return items
            .filter(it => it.kind === 'shell' && it.blockKind)
            .map(it => ({
                blockKind: it.blockKind,
                matrix: it.object3d.matrix.toArray(),
            }));
    }
    function deserialize(arr) {
        if (!Array.isArray(arr)) return;
        for (const b of arr) {
            try {
                const wrapper = new THREE.Group();
                wrapper.add(buildBlockMesh(b.blockKind));
                const m = new THREE.Matrix4().fromArray(b.matrix);
                m.decompose(wrapper.position, wrapper.quaternion, wrapper.scale);
                const item = new Item({
                    object3d: wrapper,
                    name: PALETTE[b.blockKind]?.label || 'Block',
                    kind: 'shell',
                    sourceUrl: null,
                });
                item.blockKind = b.blockKind;
                lastPlaced = item;
            } catch (e) {
                console.warn('block restore failed', b, e.message);
            }
        }
    }

    // ----- Hotkey registration -------------------------------------------
    function registerHotkeys() {
        window.addEventListener('keydown', (e) => {
            if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
            // Number row 1..6 places palette items at camera; Shift uses MotherSort.
            const digit = e.code.startsWith('Digit') ? parseInt(e.code.slice(5), 10) : null;
            if (digit && digit >= 1 && digit <= KIND_ORDER.length) {
                const kind = KIND_ORDER[digit - 1];
                if (e.shiftKey) motherSort(kind);
                else placeAtCamera(kind);
                e.preventDefault();
                return;
            }
            // Bracket extrusion. [ ] step x; ; ' step z; - = step y.
            if (e.code === 'BracketLeft')   { extrude('x', -1); e.preventDefault(); }
            else if (e.code === 'BracketRight')  { extrude('x', +1); e.preventDefault(); }
            else if (e.code === 'Semicolon')     { extrude('z', -1); e.preventDefault(); }
            else if (e.code === 'Quote')         { extrude('z', +1); e.preventDefault(); }
            else if (e.code === 'Minus')         { extrude('y', -1); e.preventDefault(); }
            else if (e.code === 'Equal')         { extrude('y', +1); e.preventDefault(); }
        });
    }

    return {
        PALETTE, KIND_ORDER, GRID, WALL_H, WALL_T,
        placeAtCamera, motherSort, extrude,
        serialize, deserialize, registerHotkeys,
        get lastPlaced() { return lastPlaced; },
    };
}

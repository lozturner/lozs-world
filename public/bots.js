// =============================================================================
//  Loz's World - bots
//
//  A bot is a small function that composes Blocks.placeAt / Blocks.extrude
//  into a recognisable structure: a 3x3 room, a corridor, a row of walls, a
//  tower, a staircase. Bots take parameters, run synchronously, save the
//  layout once at the end, and report what they built via setStatus.
//
//  The point: "I want a memory-palace street" should be one slash command,
//  not 200 keystrokes. Bots are also the substrate for the AI prompt
//  layer the user wants - the bot signature is small enough that a future
//  LLM call can pick the right one and fill in the parameters.
//
//  Origin convention: bots build relative to where the player is gazing,
//  using Blocks.cameraOrigin() for a snapped footprint and a 90-degree
//  rounded yaw. That way structures land cleanly aligned to the grid no
//  matter which direction the player is facing.
// =============================================================================

import * as THREE from 'three';

export function createBots({ Blocks, items, setStatus, saveLayout }) {
    const GRID = Blocks.GRID;
    const WALL_T = Blocks.WALL_T;
    const WALL_H = Blocks.WALL_H;

    // Rotate a local (dx, dz) offset by the bot's yaw so structures align
    // to whichever way the player was looking when the bot ran. Yaw is in
    // radians, snapped to multiples of pi/2 by Blocks.cameraOrigin().
    function rotateXZ(dx, dz, yaw) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        return { x: dx * c + dz * s, z: -dx * s + dz * c };
    }

    function place(kind, ox, oy, oz, originVec, yaw, rotOffset = 0) {
        const r = rotateXZ(ox, oz, yaw);
        const pos = new THREE.Vector3(originVec.x + r.x, oy, originVec.z + r.z);
        return Blocks.placeAt(kind, pos, yaw + rotOffset);
    }

    // ---- room ------------------------------------------------------------
    // w x d floor tiles centred on the snapped camera origin, walls around
    // the perimeter, optional ceiling, optional doorway in the wall facing
    // the player.
    function room({ w = 3, d = 3, withCeiling = false, withDoor = true } = {}) {
        const { origin, yaw } = Blocks.cameraOrigin();
        let count = 0;

        const xMin = -Math.floor((w - 1) / 2), xMax = xMin + w - 1;
        const zMin = -Math.floor((d - 1) / 2), zMax = zMin + d - 1;
        for (let ix = xMin; ix <= xMax; ix++) {
            for (let iz = zMin; iz <= zMax; iz++) {
                place('floor', ix * GRID, 0, iz * GRID, origin, yaw);
                count++;
            }
        }

        // Walls sit just outside the floor perimeter by GRID/2 + WALL_T/2,
        // and rotate +pi/2 for the east/west sides so they face inwards.
        const wallOffset = GRID / 2 + WALL_T / 2;
        const doorIxNorth = withDoor ? Math.floor((xMax + xMin) / 2) : null;
        // North edge (player-facing when yaw=0).
        for (let ix = xMin; ix <= xMax; ix++) {
            const kind = (ix === doorIxNorth) ? 'doorway' : 'wall';
            place(kind, ix * GRID, 0, zMin * GRID - wallOffset, origin, yaw, 0);
            count++;
        }
        for (let ix = xMin; ix <= xMax; ix++) {
            place('wall', ix * GRID, 0, zMax * GRID + wallOffset, origin, yaw, 0);
            count++;
        }
        for (let iz = zMin; iz <= zMax; iz++) {
            place('wall', xMin * GRID - wallOffset, 0, iz * GRID, origin, yaw, Math.PI / 2);
            count++;
        }
        for (let iz = zMin; iz <= zMax; iz++) {
            place('wall', xMax * GRID + wallOffset, 0, iz * GRID, origin, yaw, Math.PI / 2);
            count++;
        }

        if (withCeiling) {
            for (let ix = xMin; ix <= xMax; ix++) {
                for (let iz = zMin; iz <= zMax; iz++) {
                    place('ceiling', ix * GRID, 0, iz * GRID, origin, yaw);
                    count++;
                }
            }
        }

        saveLayout();
        setStatus(`Bot: built ${w}x${d} room (${count} blocks).`);
        return count;
    }

    // ---- corridor --------------------------------------------------------
    function corridor({ length = 5 } = {}) {
        const { origin, yaw } = Blocks.cameraOrigin();
        const wallOffset = GRID / 2 + WALL_T / 2;
        let count = 0;
        for (let i = 0; i < length; i++) {
            const localZ = -i * GRID;
            place('floor', 0, 0, localZ, origin, yaw);
            place('wall', -wallOffset, 0, localZ, origin, yaw, Math.PI / 2);
            place('wall',  wallOffset, 0, localZ, origin, yaw, Math.PI / 2);
            count += 3;
        }
        saveLayout();
        setStatus(`Bot: built ${length}-tile corridor (${count} blocks).`);
        return count;
    }

    // ---- wallrow --------------------------------------------------------
    function wallrow({ n = 5 } = {}) {
        const { origin, yaw } = Blocks.cameraOrigin();
        for (let i = 0; i < n; i++) {
            place('wall', i * GRID, 0, 0, origin, yaw, 0);
        }
        saveLayout();
        setStatus(`Bot: ${n} walls in a row.`);
        return n;
    }

    // ---- tower ----------------------------------------------------------
    function tower({ h = 3 } = {}) {
        const { origin, yaw } = Blocks.cameraOrigin();
        for (let i = 0; i < h; i++) {
            place('pillar', 0, i * WALL_H, 0, origin, yaw);
        }
        saveLayout();
        setStatus(`Bot: ${h}-storey pillar tower.`);
        return h;
    }

    // ---- staircase ------------------------------------------------------
    function staircase({ steps = 4 } = {}) {
        const { origin, yaw } = Blocks.cameraOrigin();
        for (let i = 0; i < steps; i++) {
            place('floor', 0, i * WALL_H, -i * GRID, origin, yaw);
        }
        saveLayout();
        setStatus(`Bot: ${steps}-step staircase.`);
        return steps;
    }

    // ---- clear ----------------------------------------------------------
    // Remove every shell block from the world. Loose objects untouched.
    function clearShells() {
        const shells = items.filter(it => it.kind === 'shell');
        for (const it of shells) it.dispose();
        saveLayout();
        setStatus(`Bot: cleared ${shells.length} shell blocks.`);
        return shells.length;
    }

    // ---- prompt-style command parser -----------------------------------
    const REGISTRY = {
        room: ([w, d, ceil, door]) => room({
            w: parseInt(w, 10) || 3,
            d: parseInt(d, 10) || 3,
            withCeiling: ceil === 'ceiling' || ceil === 'roof',
            withDoor:    door !== 'nodoor',
        }),
        corridor:  ([length]) => corridor({ length: parseInt(length, 10) || 5 }),
        wallrow:   ([n]) => wallrow({ n: parseInt(n, 10) || 5 }),
        tower:     ([h]) => tower({ h: parseInt(h, 10) || 3 }),
        staircase: ([steps]) => staircase({ steps: parseInt(steps, 10) || 4 }),
        clear:     () => clearShells(),
    };

    function run(name, args = []) {
        const fn = REGISTRY[name];
        if (!fn) {
            setStatus(`bot: unknown "${name}". try: ${Object.keys(REGISTRY).join(' | ')}`);
            return null;
        }
        try { return fn(args); }
        catch (err) {
            console.error(err);
            setStatus(`bot ${name} failed: ${err.message}`);
            return null;
        }
    }

    function help() {
        return [
            '/bot room [w] [d] [ceiling] [nodoor]   - room around the player',
            '/bot corridor [length]                 - corridor forward',
            '/bot wallrow [n]                       - n walls to the right',
            '/bot tower [h]                         - h pillars stacked',
            '/bot staircase [steps]                 - cheap stepped staircase',
            '/bot clear                             - remove every shell block',
        ].join('\n');
    }

    return {
        room, corridor, wallrow, tower, staircase, clearShells,
        run, help, REGISTRY,
    };
}

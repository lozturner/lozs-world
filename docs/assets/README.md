# Drop model files here

Loz's World accepts these formats out of the box:

| Format     | Where you'll find it                                  |
| ---------- | ----------------------------------------------------- |
| `.stl`     | Thingiverse, Printables, MakerWorld - 3D-print sites |
| `.obj`     | Free3D, TurboSquid free tier, anywhere old           |
| `.glb`     | Sketchfab download default, Poly Haven               |
| `.gltf`    | Modern web/game pipeline                             |
| `.fbx`     | Mixamo, ArtStation, free game-asset packs            |
| `.dae`     | Older Blender / SketchUp exports (Collada)           |
| `.3ds`     | Legacy 3D Studio                                     |
| `.ply`     | Photogrammetry scans, point clouds                   |

## SketchUp users

`.skp` is SketchUp's proprietary format and there is **no working browser
parser** for it. Inside SketchUp:

  **File -> Export -> 3D Model -> save as .obj or .gltf**

then drop the exported file in here. Same applies to anything from
software using closed binary formats (Solidworks `.sldprt`, Fusion 360
`.f3d`, etc).

## What the loader does to your file

When you drag or spawn an asset, the loader:
1. Decodes it with the right Three.js loader by extension.
2. Computes the world-space bounding box.
3. Centres the bbox at the origin.
4. Uniformly scales it so the largest dimension is ~0.6 metres in world units.

So a 200mm Thingiverse part and a 50m architectural model both spawn at the
same comfortable size. Press `G` while looking at it to grab and reposition,
`F` to attach a live web screen to its front face.

Files in this folder never leave your machine.

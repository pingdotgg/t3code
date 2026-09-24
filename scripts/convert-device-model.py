# Run with Blender 4.5.9:
# blender --background --python scripts/convert-device-model.py -- <model-id> <source.usdz> <output.glb>
# Then optimize using @gltf-transform/cli 4.2.1 with --compress false --simplify false
# --join false --palette false --flatten false --texture-size 1024 --texture-compress webp.
import hashlib
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

model_id, source, output = sys.argv[sys.argv.index("--") + 1 :]
manifest_path = (
    Path(__file__).resolve().parents[1]
    / "apps/web/src/components/device/models/sources.json"
)
manifest = json.loads(manifest_path.read_text())
model = next(m for m in manifest["models"] if m["id"] == model_id)
if hashlib.sha256(Path(source).read_bytes()).hexdigest() != model["sourceSha256"]:
    raise ValueError("Source checksum differs from the recorded Apple asset")
body_name, screen_name = model["bodyNode"], model["screenNode"]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.usd_import(filepath=source, import_materials=True)
body = bpy.data.objects[model.get("accessoryNode", body_name)]
screen = bpy.data.objects[screen_name]
objects = [o for o in body.children_recursive if o.type == "MESH"]
if body.type == "MESH":
    objects.append(body)
uv = screen.data.uv_layers.active
points = []
coords = []
for loop in screen.data.loops:
    points.append(
        tuple(screen.matrix_world @ screen.data.vertices[loop.vertex_index].co)
    )
    coords.append((*uv.data[loop.index].uv, 1))
coef = np.linalg.lstsq(np.array(coords), np.array(points), rcond=None)[0]
right = Vector(coef[0]).normalized()
up = Vector(coef[1]).normalized()
normal = right.cross(up).normalized()
# The authored UVs establish the device's front and its physical portrait axes.
# No body proportions are changed. The runtime uses a standard planar framebuffer UV.
rot = Matrix((right, up, normal)).to_4x4()
world = [rot @ Vector(p) for p in points]
lo = Vector(tuple(min(p[i] for p in world) for i in range(3)))
hi = Vector(tuple(max(p[i] for p in world) for i in range(3)))
center = (lo + hi) / 2
scale = 2.2 / (hi.y - lo.y)
transform = (
    Matrix.Translation(Vector((0, 0, 0.043)))
    @ Matrix.Diagonal(Vector((scale, scale, scale, 1)))
    @ Matrix.Translation(-center)
    @ rot
)
for o in objects:
    matrix = transform @ o.matrix_world
    o.parent = None
    o.matrix_world = Matrix.Identity(4)
    o.data.transform(matrix)
    # Blender is Z-up; glTF export converts to Y-up. Store canonical Y-up geometry as Blender Z-up.
    o.data.transform(Matrix.Rotation(np.pi / 2, 4, "X"))
    if o == screen:
        o.name = "device-screen"
        o.data.name = "device-screen"
        for loop in o.data.loops:
            p = o.data.vertices[loop.vertex_index].co
            uv.data[loop.index].uv = (
                (p.x / ((hi.x - lo.x) * scale)) + 0.5,
                p.z / 2.2 + 0.5,
            )
        # This material is replaced by the viewer and must not retain the marketing screenshot.
        mat = bpy.data.materials.new("device-screen")
        mat.diffuse_color = (0, 0, 0, 1)
        o.data.materials.clear()
        o.data.materials.append(mat)
for o in list(bpy.data.objects):
    if o not in objects:
        bpy.data.objects.remove(o, do_unlink=True)
for image in bpy.data.images:
    if image.size[0] > 1024 or image.size[1] > 1024:
        k = 1024 / max(image.size)
        image.scale(max(1, round(image.size[0] * k)), max(1, round(image.size[1] * k)))
for o in objects:
    o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=output,
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_animations=False,
    export_extras=False,
    export_image_format="AUTO",
    export_copyright="Apple Inc. Original device assets; see models/sources.json for provenance.",
)
print(
    "MODEL_METRICS",
    json.dumps(
        {
            "width": (hi.x - lo.x) * scale,
            "height": 2.2,
            "bodyMeshes": len(objects),
            "screen": screen.name,
            "source": source,
        }
    ),
)

import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const BLENDER_TIMEOUT = "60 seconds";

// Exports the visible geometry for the 3D view, skipped past the triangle limit, then renders a
// picture framed from the front right, 30 degrees up, like the mesh renderer. Exit 3: nothing to draw.
const SCRIPT = `
import math, sys
import bpy
import numpy as np
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1 :]
geometry_out, png_out, limit, size = args[0], args[1], int(args[2]), int(args[3])
depsgraph = bpy.context.evaluated_depsgraph_get()
kinds = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
parts, vertex_total, triangle_total = [], 0, 0
for instance in depsgraph.object_instances:
    source = instance.object
    if source.type not in kinds:
        continue
    owner = instance.parent if instance.is_instance else source
    if not owner.original.visible_get():
        continue
    mesh = source.to_mesh()
    try:
        if mesh is None:
            continue
        mesh.calc_loop_triangles()
        count = len(mesh.loop_triangles)
        if count == 0:
            continue
        triangle_total += count
        if triangle_total > limit:
            break
        points = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", points)
        matrix = np.array(instance.matrix_world, dtype=np.float32)
        points = points.reshape(-1, 3) @ matrix[:3, :3].T + matrix[:3, 3]
        triangles = np.empty(count * 3, dtype=np.uint32)
        mesh.loop_triangles.foreach_get("vertices", triangles)
        parts.append((points.astype("<f4"), triangles.reshape(-1, 3) + vertex_total))
        vertex_total += len(points)
    finally:
        source.to_mesh_clear()
if triangle_total == 0:
    sys.exit(3)
if triangle_total <= limit:
    face = np.dtype([("count", "u1"), ("corners", "<u4", 3)])
    with open(geometry_out, "wb") as file:
        file.write((
            "ply\\nformat binary_little_endian 1.0\\n"
            f"element vertex {vertex_total}\\n"
            "property float x\\nproperty float y\\nproperty float z\\n"
            f"element face {triangle_total}\\n"
            "property list uchar uint vertex_indices\\nend_header\\n"
        ).encode("ascii"))
        for points, _ in parts:
            file.write(points.tobytes())
        for _, triangles in parts:
            rows = np.empty(len(triangles), dtype=face)
            rows["count"] = 3
            rows["corners"] = triangles
            file.write(rows.tobytes())

scene = bpy.context.scene
if triangle_total <= limit:
    every = np.concatenate([points for points, _ in parts])
    low, high = Vector(every.min(axis=0).tolist()), Vector(every.max(axis=0).tolist())
else:
    objects = [o for o in scene.objects if o.type in kinds and o.visible_get()]
    corners = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box] or [Vector()]
    low = Vector([min(c[axis] for c in corners) for axis in range(3)])
    high = Vector([max(c[axis] for c in corners) for axis in range(3)])
center = (low + high) / 2
radius = max((high - low).length / 2, 1e-6)
azimuth, elevation = math.radians(45), math.radians(30)
toward = Vector((
    math.cos(elevation) * math.sin(azimuth),
    -math.cos(elevation) * math.cos(azimuth),
    math.sin(elevation),
))
data = bpy.data.cameras.new("t3-preview")
data.type = "ORTHO"
data.ortho_scale = radius * 2.1
data.clip_start = radius * 0.01
data.clip_end = radius * 10
camera = bpy.data.objects.new("t3-preview", data)
scene.collection.objects.link(camera)
camera.location = center + toward * radius * 4
camera.rotation_euler = (-toward).to_track_quat("-Z", "Y").to_euler()
scene.camera = camera
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.render.resolution_x = size
scene.render.resolution_y = size
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.filepath = png_out
bpy.ops.render.render(write_still=True)
`;

// Factory settings and --disable-autoexec keep scripts stored in the file from running; the file
// is opened but never saved.
const runBlenderScript = Effect.fn("ModelPreviews.runBlender")(function* (
  blender: string,
  source: string,
  script: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .exitCode(
      ChildProcess.make(
        blender,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          source,
          "--python-exit-code",
          "1",
          "--python-expr",
          script,
          "--",
          ...args,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      ),
    )
    .pipe(Effect.timeout(BLENDER_TIMEOUT));
});

/**
 * Writes the visible geometry of `source` to `geometry` as binary PLY for the 3D view, unless it has
 * over `maxTriangles`, and a PNG render to `png`; returns Blender's exit code.
 */
export const exportBlendWithBlender = (input: {
  readonly blender: string;
  readonly source: string;
  readonly geometry: string;
  readonly png: string;
  readonly maxTriangles: number;
  readonly size: number;
}) =>
  runBlenderScript(input.blender, input.source, SCRIPT, [
    input.geometry,
    input.png,
    String(input.maxTriangles),
    String(input.size),
  ]);

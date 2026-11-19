"""Continuum's Blender operations, run in Blender's background mode:

    blender --background [scene.blend] --factory-startup --python continuum_blender.py -- request.json response.json

The request is {"operation": ..., "args": {...}, "blend": "<path to save>"}. Every operation that
changes the scene saves the .blend, so it stays the editable source next to any exports.
"""

import json
import math
import os
import sys
import traceback

import bpy
import bmesh
from mathutils import Vector

METERS_PER_STUD = 0.28
PRIMITIVES = {
    "cube": lambda size: bpy.ops.mesh.primitive_cube_add(size=size),
    "plane": lambda size: bpy.ops.mesh.primitive_plane_add(size=size),
    "uv_sphere": lambda size: bpy.ops.mesh.primitive_uv_sphere_add(radius=size / 2),
    "ico_sphere": lambda size: bpy.ops.mesh.primitive_ico_sphere_add(radius=size / 2),
    "cylinder": lambda size: bpy.ops.mesh.primitive_cylinder_add(radius=size / 2, depth=size),
    "cone": lambda size: bpy.ops.mesh.primitive_cone_add(radius1=size / 2, depth=size),
    "torus": lambda size: bpy.ops.mesh.primitive_torus_add(major_radius=size / 2, minor_radius=size / 8),
}


def mesh_objects(names=None):
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if names:
        objects = [obj for obj in objects if obj.name in names]
    return objects


def triangle_count(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        return sum(len(poly.vertices) - 2 for poly in mesh.polygons)
    finally:
        evaluated.to_mesh_clear()


def world_bounds(objects):
    corners = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    if not corners:
        return None
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return low, high


def dimensions(objects):
    bounds = world_bounds(objects)
    if bounds is None:
        return None
    low, high = bounds
    size = high - low
    return {"x": round(size.x, 4), "y": round(size.y, 4), "z": round(size.z, 4), "units": "m"}


def material_report(material):
    images, missing = [], []
    tree = getattr(material, "node_tree", None)
    if tree is not None:
        for node in tree.nodes:
            if node.type == "TEX_IMAGE":
                image = node.image
                if image is None:
                    missing.append("(empty image node)")
                    continue
                path = bpy.path.abspath(image.filepath) if image.filepath else ""
                exists = image.packed_file is not None or (path != "" and os.path.exists(path))
                images.append({"name": image.name, "path": path, "size": list(image.size), "packed": image.packed_file is not None})
                if not exists:
                    missing.append(image.name)
    return {"name": material.name, "images": images, "missingImages": missing}


def describe(obj):
    node = {
        "name": obj.name,
        "type": obj.type,
        "parent": obj.parent.name if obj.parent else None,
        "location": list(obj.location),
        "rotationDegrees": [math.degrees(value) for value in obj.rotation_euler],
        "scale": list(obj.scale),
        "dimensions": list(obj.dimensions),
    }
    if obj.type == "MESH":
        node["vertices"] = len(obj.data.vertices)
        node["triangles"] = triangle_count(obj)
        node["materials"] = [slot.material.name for slot in obj.material_slots if slot.material]
        node["modifiers"] = [{"name": modifier.name, "type": modifier.type} for modifier in obj.modifiers]
        node["unappliedScale"] = any(abs(value - 1.0) > 1e-4 for value in obj.scale)
    return node


def op_inspect(args):
    scene = bpy.context.scene
    meshes = mesh_objects()
    return {
        "objects": [describe(obj) for obj in scene.objects],
        "materials": [material_report(material) for material in bpy.data.materials if material.users > 0],
        "units": {"system": scene.unit_settings.system, "scaleLength": scene.unit_settings.scale_length},
        "dimensions": dimensions(meshes),
        "triangles": sum(triangle_count(obj) for obj in meshes),
    }


def get_object(name):
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise ValueError("No object named {}".format(name))
    return obj


def apply_transform(obj, args):
    if "location" in args:
        obj.location = args["location"]
    if "rotationDegrees" in args:
        obj.rotation_euler = [math.radians(value) for value in args["rotationDegrees"]]
    if "scale" in args:
        obj.scale = args["scale"]
    if "dimensions" in args:
        obj.dimensions = args["dimensions"]


def select_only(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def op_create_mesh(args):
    name = args.get("name", "Mesh")
    if "vertices" in args and "faces" in args:
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v) for v in args["vertices"]], [], [tuple(f) for f in args["faces"]])
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
    else:
        primitive = args.get("primitive", "cube")
        if primitive not in PRIMITIVES:
            raise ValueError("Unknown primitive {}".format(primitive))
        PRIMITIVES[primitive](float(args.get("size", 1.0)))
        obj = bpy.context.active_object
        obj.name = name
        obj.data.name = name
    apply_transform(obj, args)
    if args.get("shadeSmooth"):
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return describe(obj)


def op_modify(args):
    obj = get_object(args["object"])
    apply_transform(obj, args)
    for spec in args.get("modifiers", []):
        modifier = obj.modifiers.new(spec.get("name", spec["type"].title()), spec["type"])
        for key, value in spec.items():
            if key not in ("type", "name") and hasattr(modifier, key):
                setattr(modifier, key, value)
    if args.get("applyModifiers"):
        select_only([obj])
        for modifier in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    if args.get("applyTransforms"):
        select_only([obj])
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if "shadeSmooth" in args:
        for polygon in obj.data.polygons:
            polygon.use_smooth = bool(args["shadeSmooth"])
    if args.get("bevel"):
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        bmesh.ops.bevel(mesh, geom=mesh.edges[:], offset=float(args["bevel"]), segments=2, affect="EDGES")
        mesh.to_mesh(obj.data)
        mesh.free()
    return describe(obj)


def principled(material):
    if hasattr(material, "use_nodes") and not material.use_nodes:
        material.use_nodes = True
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    return material.node_tree.nodes.new("ShaderNodeBsdfPrincipled")


def set_input(node, names, value):
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def op_material(args):
    obj = get_object(args["object"])
    material = bpy.data.materials.get(args.get("name", "")) or bpy.data.materials.new(args.get("name", obj.name + "Material"))
    shader = principled(material)
    if "baseColor" in args:
        color = list(args["baseColor"]) + [1.0] * (4 - len(args["baseColor"]))
        set_input(shader, ["Base Color"], color)
    if "metallic" in args:
        set_input(shader, ["Metallic"], float(args["metallic"]))
    if "roughness" in args:
        set_input(shader, ["Roughness"], float(args["roughness"]))
    if "emission" in args:
        color = list(args["emission"]) + [1.0] * (4 - len(args["emission"]))
        set_input(shader, ["Emission Color", "Emission"], color)
        set_input(shader, ["Emission Strength"], float(args.get("emissionStrength", 1.0)))
    if args.get("imageTexture"):
        image = bpy.data.images.load(args["imageTexture"], check_existing=True)
        texture = material.node_tree.nodes.new("ShaderNodeTexImage")
        texture.image = image
        material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
        if args.get("uvUnwrap", True):
            select_only([obj])
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project()
            bpy.ops.object.mode_set(mode="OBJECT")
    if args.get("replace", True):
        obj.data.materials.clear()
    obj.data.materials.append(material)
    return {"object": obj.name, "material": material_report(material)}


def op_delete(args):
    removed = []
    for name in args.get("objects", []):
        obj = bpy.data.objects.get(name)
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)
            removed.append(name)
    return {"removed": removed}


def op_import(args):
    path = args["path"]
    before = set(bpy.data.objects.keys())
    lower = path.lower()
    if lower.endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=path)
    elif lower.endswith((".glb", ".gltf")):
        bpy.ops.import_scene.gltf(filepath=path)
    elif lower.endswith(".obj"):
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise ValueError("Blender cannot import {}".format(os.path.basename(path)))
    added = [bpy.data.objects[name] for name in bpy.data.objects.keys() if name not in before]
    meshes = [obj for obj in added if obj.type == "MESH"]
    return {"imported": [obj.name for obj in added], "dimensions": dimensions(meshes), "triangles": sum(triangle_count(obj) for obj in meshes)}


def frame_camera(objects, width, height):
    bounds = world_bounds(objects)
    center = (bounds[0] + bounds[1]) / 2 if bounds else Vector((0, 0, 0))
    radius = max((bounds[1] - bounds[0]).length / 2, 0.1) if bounds else 1.0
    camera_data = bpy.data.cameras.new("ContinuumPreviewCamera")
    camera = bpy.data.objects.new("ContinuumPreviewCamera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    direction = Vector((1.0, -1.2, 0.8)).normalized()
    distance = radius / math.tan(camera_data.angle / 2) * 1.25
    camera.location = center + direction * distance
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.clip_end = distance * 10
    light_data = bpy.data.lights.new("ContinuumPreviewLight", "SUN")
    light_data.energy = 3.0
    light = bpy.data.objects.new("ContinuumPreviewLight", light_data)
    light.rotation_euler = (math.radians(50), math.radians(10), math.radians(30))
    bpy.context.scene.collection.objects.link(light)
    return camera, light


def op_render_preview(args):
    scene = bpy.context.scene
    width = int(args.get("width", 768))
    height = int(args.get("height", 768))
    objects = mesh_objects(args.get("objects"))
    if not objects:
        raise ValueError("The scene has no meshes to render.")
    previous_camera = scene.camera
    camera, light = frame_camera(objects, width, height)
    scene.camera = camera
    scene.render.engine = args.get("engine", "CYCLES")
    if scene.render.engine == "CYCLES":
        scene.cycles.device = "CPU"
        scene.cycles.samples = int(args.get("samples", 24))
        if hasattr(scene.cycles, "use_denoising"):
            scene.cycles.use_denoising = False
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = bool(args.get("transparent", True))
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = args["output"]
    try:
        bpy.ops.render.render(write_still=True)
    finally:
        scene.camera = previous_camera
        bpy.data.objects.remove(camera, do_unlink=True)
        bpy.data.objects.remove(light, do_unlink=True)
    return {"output": args["output"], "width": width, "height": height, "engine": scene.render.engine}


EXPORT_TARGETS = {
    # Unity: meters, Y up, -Z forward, scale baked so Transform scale stays 1.
    "unity": {"format": "fbx", "fbx": {"axis_forward": "-Z", "axis_up": "Y", "apply_scale_options": "FBX_SCALE_ALL", "bake_space_transform": True}, "unit": "m", "factor": 1.0},
    # Unreal: centimeters, Z up, X forward; Unreal converts the FBX unit scale on import.
    "unreal": {"format": "fbx", "fbx": {"axis_forward": "X", "axis_up": "Z", "apply_scale_options": "FBX_SCALE_UNITS"}, "unit": "cm", "factor": 100.0},
    # Roblox: studs (0.28 m), Y up; Studio's importer reads FBX in its file units.
    "roblox": {"format": "fbx", "fbx": {"axis_forward": "-Z", "axis_up": "Y", "apply_scale_options": "FBX_SCALE_ALL", "global_scale": 1.0 / METERS_PER_STUD}, "unit": "studs", "factor": 1.0 / METERS_PER_STUD},
    "generic": {"format": "glb", "unit": "m", "factor": 1.0},
}


def op_export(args):
    target = EXPORT_TARGETS.get(args.get("target", "generic"))
    if target is None:
        raise ValueError("Unknown export target {}".format(args.get("target")))
    fmt = args.get("format", target["format"])
    path = args["path"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    objects = mesh_objects(args.get("objects"))
    if not objects:
        raise ValueError("Nothing to export: the scene has no meshes.")
    select_only(objects)
    if fmt == "fbx":
        options = {"filepath": path, "use_selection": True, "object_types": {"MESH", "ARMATURE", "EMPTY"}, "use_mesh_modifiers": True, "mesh_smooth_type": "FACE", "path_mode": "COPY", "embed_textures": True, "add_leaf_bones": False}
        options.update(target.get("fbx", {}))
        bpy.ops.export_scene.fbx(**options)
    elif fmt in ("glb", "gltf"):
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB" if fmt == "glb" else "GLTF_SEPARATE", use_selection=True, export_apply=True, export_yup=True)
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True, apply_modifiers=True, export_materials=True)
    else:
        raise ValueError("Unsupported export format {}".format(fmt))
    size = dimensions(objects)
    expected = None
    if size is not None:
        factor = target["factor"]
        expected = {"x": round(size["x"] * factor, 4), "y": round(size["y"] * factor, 4), "z": round(size["z"] * factor, 4), "units": target["unit"]}
    return {
        "path": path,
        "format": fmt,
        "bytes": os.path.getsize(path),
        "triangles": sum(triangle_count(obj) for obj in objects),
        "materials": sorted({slot.material.name for obj in objects for slot in obj.material_slots if slot.material}),
        "missingImages": sorted({name for material in bpy.data.materials if material.users > 0 for name in material_report(material)["missingImages"]}),
        "blenderDimensions": size,
        "expectedEngineDimensions": expected,
        "unappliedScale": [obj.name for obj in objects if any(abs(value - 1.0) > 1e-4 for value in obj.scale)],
    }


def op_check(args):
    report = op_inspect({})
    checks = []
    budget = args.get("polygonBudget")
    if budget:
        status = "pass" if report["triangles"] <= budget else "fail"
        checks.append({"name": "Polygon budget", "status": status, "detail": "{} triangles, budget {}".format(report["triangles"], budget)})
    resolution = args.get("textureResolution")
    if resolution:
        too_big = [image["name"] for material in report["materials"] for image in material["images"] if max(image["size"] or [0]) > resolution]
        checks.append({"name": "Texture resolution", "status": "fail" if too_big else "pass", "detail": "Over {} px: {}".format(resolution, ", ".join(too_big)) if too_big else "All textures within {} px".format(resolution)})
    missing = [name for material in report["materials"] for name in material["missingImages"]]
    checks.append({"name": "Material textures", "status": "fail" if missing else "pass", "detail": "Missing: {}".format(", ".join(missing)) if missing else "Every image texture resolves"})
    target = args.get("dimensions")
    if target and report["dimensions"]:
        actual = report["dimensions"]
        factor = {"m": 1.0, "cm": 0.01, "studs": METERS_PER_STUD}.get(target.get("units", "m"), 1.0)
        wanted = [target["x"] * factor, target["y"] * factor, target["z"] * factor]
        got = [actual["x"], actual["y"], actual["z"]]
        off = max(abs(g - w) / max(w, 1e-6) for g, w in zip(got, wanted) if w > 0) if any(w > 0 for w in wanted) else 0
        checks.append({"name": "Dimensions", "status": "pass" if off <= 0.05 else "fail", "detail": "Model {:.3f} × {:.3f} × {:.3f} m, brief {:.3f} × {:.3f} × {:.3f} m".format(*(got + wanted))})
    unapplied = [obj["name"] for obj in report["objects"] if obj.get("unappliedScale")]
    checks.append({"name": "Applied scale", "status": "warn" if unapplied else "pass", "detail": "Unapplied scale on: {}".format(", ".join(unapplied)) if unapplied else "All mesh scales are 1"})
    return {"checks": checks, "triangles": report["triangles"], "dimensions": report["dimensions"]}


OPERATIONS = {
    "inspect": (op_inspect, False),
    "create_mesh": (op_create_mesh, True),
    "modify": (op_modify, True),
    "material": (op_material, True),
    "delete": (op_delete, True),
    "import": (op_import, True),
    "render_preview": (op_render_preview, False),
    "export": (op_export, False),
    "check": (op_check, False),
}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    request_path, response_path = argv[0], argv[1]
    with open(request_path, "r", encoding="utf-8") as handle:
        request = json.load(handle)
    # Keep only the .blend itself next to exports, without Blender's .blend1 backups.
    bpy.context.preferences.filepaths.save_version = 0
    try:
        if request.get("reset"):
            bpy.ops.wm.read_factory_settings(use_empty=True)
        handler, writes = OPERATIONS[request["operation"]]
        value = handler(request.get("args") or {})
        if writes and request.get("blend"):
            os.makedirs(os.path.dirname(request["blend"]), exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=request["blend"])
        response = {"ok": True, "value": value, "blenderVersion": bpy.app.version_string}
    except Exception as error:
        response = {"ok": False, "error": str(error), "trace": traceback.format_exc(limit=4), "blenderVersion": bpy.app.version_string}
    with open(response_path, "w", encoding="utf-8") as handle:
        json.dump(response, handle)


main()

/**
 * The Python program every Blender process T3 starts runs: `blender --python <this> -- <spec>`.
 * It runs the requested script, writes the requested outputs, and reports through the spec's
 * `resultPath`, so results never depend on Blender's (truncated) console output.
 */
export const BLENDER_JOB_SCRIPT = String.raw`
import json
import os
import runpy
import sys
import traceback

spec_path = sys.argv[sys.argv.index("--") + 1]
with open(spec_path, encoding="utf-8") as spec_file:
    spec = json.load(spec_file)


def report(result):
    staging = spec["resultPath"] + ".partial"
    with open(staging, "w", encoding="utf-8") as result_file:
        json.dump(result, result_file)
    os.replace(staging, spec["resultPath"])


def publish(write, final):
    root, extension = os.path.splitext(final)
    staging = root + ".partial" + extension
    write(staging)
    os.replace(staging, final)


def scene_summary(limit):
    import bpy

    selected = set(obj.name for obj in bpy.context.selected_objects)
    objects = sorted(bpy.context.scene.objects, key=lambda obj: obj.name not in selected)
    return {
        "objectCount": len(objects),
        "objects": [
            {
                "name": obj.name,
                "type": obj.type,
                "dimensions": [round(value, 6) for value in obj.dimensions],
                "selected": obj.name in selected,
            }
            for obj in objects[:limit]
        ],
    }


outputs = spec.get("outputs", [])
preview_revision = 0


def publish_preview():
    import bpy
    global preview_revision
    if "preview" not in outputs or preview_revision >= 256:
        raise ValueError("Request a preview output and publish at most 256 revisions per job.")
    revision = preview_revision + 1
    directory = spec["outputDir"]
    publish(
        lambda path: bpy.ops.export_scene.gltf(filepath=path, export_format="GLB"),
        os.path.join(directory, "preview-%s.glb" % revision),
    )
    preview_revision = revision
    if revision > 2:
        os.remove(os.path.join(directory, "preview-%s.glb" % (revision - 2)))
    print("T3_BLENDER_PREVIEW %s" % revision, flush=True)


script = spec.get("script")
try:
    import bpy

    if script:
        sys.argv = [script]
        try:
            runpy.run_path(script, init_globals={"publish_preview": publish_preview}, run_name="__main__")
        except SystemExit as exit:
            if exit.code not in (None, 0):
                raise
    result = {"ok": True}
    if "inspectLimit" in spec:
        result["scene"] = scene_summary(spec["inspectLimit"])
    if "preview" in outputs:
        publish_preview()
        result["previewRevision"] = preview_revision
    if "render" in outputs:
        def render(path):
            bpy.context.scene.render.image_settings.file_format = "PNG"
            bpy.context.scene.render.filepath = path
            bpy.ops.render.render(write_still=True)

        publish(render, os.path.join(spec["outputDir"], "render.png"))
    if spec.get("savePath"):
        publish(
            lambda path: bpy.ops.wm.save_as_mainfile(filepath=path, check_existing=False, copy=True),
            spec["savePath"],
        )
    report(result)
except BaseException as error:
    message = "".join(traceback.format_exception_only(type(error), error)).strip()
    frames = [
        frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename == script
    ]
    if frames:
        message += " (%s line %d)" % (os.path.basename(script), frames[-1].lineno)
    report({"ok": False, "message": message[-1000:]})
    raise
`;

"""A stand-in for Unreal's `unreal` Python module, enough to run the real ContinuumBridge plugin
outside the editor. It keeps a small level in memory, writes the editor log the plugin tails, and
pumps Slate ticks on the main thread like the editor does.

    python3 fake_unreal.py <project_dir> <seconds>

This is simulation, not Unreal: it proves the plugin's protocol, threading, and command handling,
not that Unreal's API behaves the same way.
"""

import base64
import importlib.util
import os
import sys
import time
import types

PROJECT = os.path.abspath(sys.argv[1])
SECONDS = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
LOG_DIR = os.path.join(PROJECT, "Saved", "Logs")
SAVED = os.path.join(PROJECT, "Saved")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_PATH = os.path.join(LOG_DIR, "Shooter.log")
open(LOG_PATH, "a").close()
PNG = base64.b64decode("iVBORw0KGgoAAAANSUHEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def write_log(line):
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write("[2026.11.19-12.00.00:000][  0]" + line + "\n")


ue = types.ModuleType("unreal")


class Vector(object):
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)


class Rotator(object):
    def __init__(self, roll=0.0, pitch=0.0, yaw=0.0):
        self.roll, self.pitch, self.yaw = float(roll), float(pitch), float(yaw)


class LinearColor(object):
    def __init__(self, r=0.0, g=0.0, b=0.0, a=1.0):
        self.r, self.g, self.b, self.a = r, g, b, a


class Class(object):
    def __init__(self, name):
        self._name = name

    def get_name(self):
        return self._name


class Object(object):
    def __init__(self, name, cls="Object"):
        self._name = name
        self._class = Class(cls)
        self._props = {}

    def get_name(self):
        return self._name

    def get_path_name(self):
        return "/Game/Maps/Main.Main:PersistentLevel." + self._name

    def get_class(self):
        return self._class

    def get_editor_property(self, name):
        if name not in self._props:
            raise AttributeError(name)
        return self._props[name]

    def set_editor_property(self, name, value):
        self._props[name] = value

    def modify(self):
        return True


class ActorComponent(Object):
    pass


class StaticMesh(Object):
    pass


class Actor(Object):
    def __init__(self, label, cls="StaticMeshActor", location=None):
        Object.__init__(self, label.replace(" ", "_"), cls)
        self.label = label
        self.location = location or Vector()
        self.rotation = Rotator()
        self.scale = Vector(1, 1, 1)
        self.tags = []
        self._props = {"bHidden": False}

    def get_actor_label(self):
        return self.label

    def set_actor_label(self, label):
        self.label = label

    def get_actor_location(self):
        return self.location

    def set_actor_location(self, location, sweep, teleport):
        self.location = location

    def get_actor_rotation(self):
        return self.rotation

    def set_actor_rotation(self, rotation, teleport):
        self.rotation = rotation

    def get_actor_scale3d(self):
        return self.scale

    def set_actor_scale3d(self, scale):
        self.scale = scale

    def get_attach_parent_actor(self):
        return None

    def get_actor_bounds(self, only_colliding):
        return self.location, Vector(50 * self.scale.x, 50 * self.scale.y, 50 * self.scale.z)

    def get_components_by_class(self, cls):
        return [ActorComponent("StaticMeshComponent0", "StaticMeshComponent")]


LEVEL = [Actor("Floor", location=Vector(0, 0, 0)), Actor("PlayerStart", "PlayerStart", Vector(0, 0, 100))]
STATE = {"playing": False, "transactions": []}


class EditorActorSubsystem(object):
    def get_all_level_actors(self):
        return list(LEVEL)

    def get_selected_level_actors(self):
        return LEVEL[:1]

    def spawn_actor_from_class(self, cls, location, rotation):
        actor = Actor(cls.get_name() if isinstance(cls, Class) else "Actor", cls.get_name() if isinstance(cls, Class) else "Actor", location)
        LEVEL.append(actor)
        return actor

    def spawn_actor_from_object(self, obj, location, rotation):
        actor = Actor(obj.get_name(), "StaticMeshActor", location)
        LEVEL.append(actor)
        return actor

    def destroy_actor(self, actor):
        LEVEL.remove(actor)
        return True


class LevelEditorSubsystem(object):
    def editor_request_begin_play(self):
        STATE["playing"] = True
        write_log("LogPlayLevel: Display: Starting PIE")

    def editor_request_end_play(self):
        STATE["playing"] = False

    def is_in_play_in_editor(self):
        return STATE["playing"]


class World(Object):
    pass


class UnrealEditorSubsystem(object):
    camera = None

    def get_editor_world(self):
        return World("Main", "World")

    def set_level_viewport_camera_info(self, location, rotation):
        UnrealEditorSubsystem.camera = (location, rotation)


SUBSYSTEMS = {EditorActorSubsystem: EditorActorSubsystem(), LevelEditorSubsystem: LevelEditorSubsystem(), UnrealEditorSubsystem: UnrealEditorSubsystem()}


class ScopedEditorTransaction(object):
    def __init__(self, description):
        self.description = description

    def __enter__(self):
        STATE["transactions"].append(self.description)
        return self

    def __exit__(self, *args):
        return False


class SystemLibrary(object):
    @staticmethod
    def execute_console_command(world, command):
        if command.startswith("Automation RunTests"):
            test_filter = command.split(" ", 2)[2]
            write_log("LogAutomationController: Display: Test Completed. Result={Success} Name={Add} Path={%s.Add}" % test_filter)
            write_log("LogAutomationController: Display: Test Completed. Result={Fail} Name={Stack} Path={%s.Stack}" % test_filter)
            write_log("LogAutomationController: Error: Expected 3 items, got 2")
            write_log("LogAutomationController: Display: ...Automation Test Queue Empty 2 tests performed.")
        elif command == "TRANSACTION UNDO":
            STATE["transactions"].append("undo")

    @staticmethod
    def get_engine_version():
        return "5.6.1-0+UE5 (simulated)"


class Paths(object):
    @staticmethod
    def project_dir():
        return PROJECT + "/"

    @staticmethod
    def project_saved_dir():
        return SAVED

    @staticmethod
    def project_log_dir():
        return LOG_DIR

    @staticmethod
    def get_project_file_path():
        return os.path.join(PROJECT, "Shooter.uproject")


class AutomationLibrary(object):
    @staticmethod
    def take_high_res_screenshot(width, height, name):
        folder = os.path.join(SAVED, "Screenshots", "Linux")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, name), "wb") as handle:
            handle.write(PNG)


BLUEPRINT_DEFAULTS = Object("Default__BP_Player_C", "BP_Player_C")
BLUEPRINT_DEFAULTS.set_editor_property("MaxWalkSpeed", 600.0)


class EditorAssetLibrary(object):
    @staticmethod
    def load_asset(path):
        if path in IMPORTED:
            return IMPORTED[path]
        if path.endswith("BP_Player"):
            return Object("BP_Player", "Blueprint")
        if "Crate" in path:
            return StaticMesh("SM_Crate", "StaticMesh")
        return None

    @staticmethod
    def load_blueprint_class(path):
        return Class("BP_Player_C")

    @staticmethod
    def save_asset(path):
        return True

    @staticmethod
    def list_assets(path, recursive, include_folder):
        return ["/Game/Maps/Main", "/Game/BP_Player"]


class BlueprintEditorLibrary(object):
    compiled = []

    @staticmethod
    def compile_blueprint(blueprint):
        BlueprintEditorLibrary.compiled.append(blueprint.get_name())


class MathLibrary(object):
    @staticmethod
    def find_look_at_rotation(start, target):
        return Rotator(0, -30, 45)


class EditorLoadingAndSavingUtils(object):
    @staticmethod
    def save_dirty_packages(maps, content):
        return True


class StaticMeshImportData(Object):
    pass


class FbxImportUI(Object):
    def __init__(self):
        Object.__init__(self, "FbxImportUI", "FbxImportUI")
        self.static_mesh_import_data = StaticMeshImportData("ImportData", "FbxStaticMeshImportData")


class AssetImportTask(Object):
    def __init__(self):
        Object.__init__(self, "AssetImportTask", "AssetImportTask")
        self._props["imported_object_paths"] = []


class Box(object):
    def __init__(self, low, high):
        self.min, self.max = low, high


class ImportedMesh(StaticMesh):
    """What Unreal reports for the 1 x 1 x 0.5 m crate the Blender test exports (in centimeters)."""

    def get_bounding_box(self):
        return Box(Vector(-50, -50, 0), Vector(50, 50, 50))


IMPORTED = {}


class AssetTools(object):
    def import_asset_tasks(self, tasks):
        for task in tasks:
            source = task.get_editor_property("filename")
            if not os.path.exists(source):
                continue
            path = "{}/{}".format(task.get_editor_property("destination_path"), task._props.get("destination_name", "Imported"))
            mesh = ImportedMesh(task._props.get("destination_name", "Imported"), "StaticMesh")
            mesh.set_editor_property("static_materials", [Object("Wood", "StaticMaterial")])
            IMPORTED[path] = mesh
            task.set_editor_property("imported_object_paths", [path])


class AssetToolsHelpers(object):
    @staticmethod
    def get_asset_tools():
        return AssetTools()


TICKS = []
ue.Vector, ue.Rotator, ue.LinearColor, ue.Object, ue.StaticMesh, ue.ActorComponent = Vector, Rotator, LinearColor, Object, StaticMesh, ActorComponent
ue.EditorActorSubsystem, ue.LevelEditorSubsystem, ue.UnrealEditorSubsystem = EditorActorSubsystem, LevelEditorSubsystem, UnrealEditorSubsystem
ue.get_editor_subsystem = lambda cls: SUBSYSTEMS[cls]
ue.ScopedEditorTransaction = ScopedEditorTransaction
ue.SystemLibrary, ue.Paths, ue.AutomationLibrary = SystemLibrary, Paths, AutomationLibrary
ue.EditorAssetLibrary, ue.BlueprintEditorLibrary, ue.MathLibrary = EditorAssetLibrary, BlueprintEditorLibrary, MathLibrary
ue.EditorLoadingAndSavingUtils = EditorLoadingAndSavingUtils
ue.AssetImportTask, ue.AssetToolsHelpers, ue.FbxImportUI = AssetImportTask, AssetToolsHelpers, FbxImportUI
ue.StaticMeshActor = Class("StaticMeshActor")
ue.PointLight = Class("PointLight")
ue.load_class = lambda outer, name: Class(name)
ue.get_default_object = lambda cls: BLUEPRINT_DEFAULTS
ue.log = lambda message: sys.stderr.write("LOG " + str(message) + "\n")
ue.log_warning = lambda message: sys.stderr.write("WARN " + str(message) + "\n")
ue.register_slate_post_tick_callback = TICKS.append
sys.modules["unreal"] = ue

# Load the plugin exactly as Unreal would, from the project's Plugins folder.
python_dir = os.path.join(PROJECT, "Plugins", "ContinuumBridge", "Content", "Python")
sys.path.insert(0, python_dir)
spec = importlib.util.spec_from_file_location("init_unreal", os.path.join(python_dir, "init_unreal.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

write_log("LogTemp: Display: Simulated editor ready")
deadline = time.time() + SECONDS
while time.time() < deadline:
    for callback in TICKS:
        callback(0.016)
    time.sleep(0.02)

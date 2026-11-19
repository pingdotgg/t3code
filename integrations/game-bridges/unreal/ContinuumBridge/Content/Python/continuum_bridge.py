"""Continuum Bridge for Unreal Engine.

A background thread long-polls the Continuum bridge on 127.0.0.1 for commands. Unreal's Python API
only works on the game thread, so commands run from a Slate post-tick callback. Everything here
uses the editor's supported scripting API (Python Editor Script Plugin and Editor Scripting
Utilities); no C++ module is compiled.
"""

import json
import os
import queue
import re
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid

PLUGIN_VERSION = "1.0.0"
PROTOCOL = 1

TEST_RESULT = re.compile(r"Test Completed\. Result=\{(?P<result>[^}]*)\}.*?Name=\{(?P<name>[^}]*)\}.*?Path=\{(?P<path>[^}]*)\}")
LOG_LEVEL = re.compile(r"^\[[^\]]*\]\[\s*\d+\](?P<category>\w+): (?P<verbosity>Error|Warning|Display|Log)?:?\s*(?P<message>.*)$")


def _vector(value):
    return {"x": value.x, "y": value.y, "z": value.z}


def _rotator(value):
    return {"pitch": value.pitch, "yaw": value.yaw, "roll": value.roll}


class Deferred(object):
    """Returned by an operation that finishes on a later tick."""

    def __init__(self, poll, timeout):
        self.poll = poll
        self.deadline = time.time() + timeout


class Bridge(object):
    def __init__(self, ue, config, project_root, project_name, log_path):
        self.ue = ue
        self.url = config["url"].rstrip("/")
        self.token = config["token"]
        self.project_root = project_root.replace("\\", "/")
        self.project_name = project_name
        self.log_path = log_path
        self.instance_id = "unreal-" + uuid.uuid4().hex
        self.session = None
        self.inbox = queue.Queue()
        self.outbox = queue.Queue()
        self.events = queue.Queue()
        self.deferred = {}
        self.running = False
        self.play_state = "edit"
        self.log_offset = None
        self.test_capture = None
        self.operations = {
            "scene.tree": self.scene_tree,
            "selection.get": self.selection_get,
            "object.get": self.object_get,
            "object.create": self.object_create,
            "object.update": self.object_update,
            "object.delete": self.object_delete,
            "script.read": self.script_read,
            "script.write": self.script_write,
            "asset.list": self.asset_list,
            "asset.update": self.asset_update,
            "asset.import": self.asset_import,
            "blueprint.set_defaults": self.blueprint_set_defaults,
            "build.status": self.build_status,
            "playtest.start": self.playtest_start,
            "playtest.stop": self.playtest_stop,
            "playtest.status": self.playtest_status,
            "tests.run": self.tests_run,
            "viewport.capture": self.viewport_capture,
            "viewport.focus": self.viewport_focus,
            "editor.undo": self.editor_undo,
            "project.save": self.project_save,
        }
        self.compile_messages = []

    # Editor subsystems -------------------------------------------------------------------

    def _actors(self):
        return self.ue.get_editor_subsystem(self.ue.EditorActorSubsystem)

    def _level(self):
        return self.ue.get_editor_subsystem(self.ue.LevelEditorSubsystem)

    def _editor(self):
        return self.ue.get_editor_subsystem(self.ue.UnrealEditorSubsystem)

    def _world(self):
        return self._editor().get_editor_world()

    def _console(self, command):
        self.ue.SystemLibrary.execute_console_command(self._world(), command)

    # Actors ------------------------------------------------------------------------------

    def _describe(self, actor, detail=False):
        node = {
            "label": actor.get_actor_label(),
            "path": actor.get_path_name(),
            "class": actor.get_class().get_name(),
            "location": _vector(actor.get_actor_location()),
        }
        parent = actor.get_attach_parent_actor()
        if parent is not None:
            node["parent"] = parent.get_actor_label()
        if detail:
            origin, extent = actor.get_actor_bounds(False)
            node["rotation"] = _rotator(actor.get_actor_rotation())
            node["scale"] = _vector(actor.get_actor_scale3d())
            node["bounds"] = {"center": _vector(origin), "size": {"x": extent.x * 2, "y": extent.y * 2, "z": extent.z * 2}}
            node["tags"] = [str(tag) for tag in actor.tags]
            node["components"] = [
                {"name": component.get_name(), "class": component.get_class().get_name()}
                for component in actor.get_components_by_class(self.ue.ActorComponent)
            ]
        return node

    def _find_actor(self, key):
        if not key:
            raise ValueError("Missing actor label or path")
        for actor in self._actors().get_all_level_actors():
            if actor.get_actor_label() == key or actor.get_path_name() == key or actor.get_name() == key:
                return actor
        raise ValueError("No actor {} in the open level".format(key))

    def scene_tree(self, args):
        actors = self._actors().get_all_level_actors()
        limit = int(args.get("limit", 500))
        world = self._world()
        return {
            "level": world.get_name() if world else None,
            "actorCount": len(actors),
            "actors": [self._describe(actor) for actor in actors[:limit]],
            "truncated": len(actors) > limit,
        }

    def selection_get(self, args):
        return {"selection": [self._describe(actor) for actor in self._actors().get_selected_level_actors()]}

    def object_get(self, args):
        actor = self._find_actor(args.get("path") or args.get("label"))
        result = self._describe(actor, detail=True)
        properties = {}
        for name in args.get("properties", []):
            try:
                properties[name] = self._encode(actor.get_editor_property(name))
            except Exception as error:
                properties[name] = "unreadable: {}".format(error)
        result["properties"] = properties
        return result

    def _encode(self, value):
        ue = self.ue
        if isinstance(value, (bool, int, float, str)) or value is None:
            return value
        if isinstance(value, ue.Vector):
            return _vector(value)
        if isinstance(value, ue.Rotator):
            return _rotator(value)
        if isinstance(value, ue.LinearColor):
            return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
        if isinstance(value, ue.Object):
            return {"path": value.get_path_name(), "class": value.get_class().get_name()}
        if isinstance(value, (list, tuple)):
            return [self._encode(item) for item in value]
        return str(value)

    def _decode(self, current, value):
        ue = self.ue
        if isinstance(current, ue.Vector) and isinstance(value, dict):
            return ue.Vector(value.get("x", 0), value.get("y", 0), value.get("z", 0))
        if isinstance(current, ue.Rotator) and isinstance(value, dict):
            return ue.Rotator(roll=value.get("roll", 0), pitch=value.get("pitch", 0), yaw=value.get("yaw", 0))
        if isinstance(current, ue.LinearColor) and isinstance(value, dict):
            return ue.LinearColor(value.get("r", 0), value.get("g", 0), value.get("b", 0), value.get("a", 1))
        if isinstance(value, dict) and "asset" in value:
            return ue.EditorAssetLibrary.load_asset(value["asset"])
        return value

    def _apply(self, target, args):
        ue = self.ue
        if "location" in args:
            target.set_actor_location(ue.Vector(**{k: args["location"].get(k, 0) for k in ("x", "y", "z")}), False, True)
        if "rotation" in args:
            rotation = args["rotation"]
            target.set_actor_rotation(ue.Rotator(roll=rotation.get("roll", 0), pitch=rotation.get("pitch", 0), yaw=rotation.get("yaw", 0)), True)
        if "scale" in args:
            target.set_actor_scale3d(ue.Vector(**{k: args["scale"].get(k, 1) for k in ("x", "y", "z")}))
        if "label" in args:
            target.set_actor_label(args["label"])
        for name, value in (args.get("properties") or {}).items():
            target.set_editor_property(name, self._decode(target.get_editor_property(name), value))

    def object_create(self, args):
        ue = self.ue
        location = args.get("location") or {}
        spawn_at = ue.Vector(location.get("x", 0), location.get("y", 0), location.get("z", 0))
        with ue.ScopedEditorTransaction("Continuum: create actor"):
            if args.get("asset"):
                asset = ue.EditorAssetLibrary.load_asset(args["asset"])
                if asset is None:
                    raise ValueError("No asset at {}".format(args["asset"]))
                actor = self._actors().spawn_actor_from_object(asset, spawn_at, ue.Rotator())
            else:
                class_name = args.get("class", "StaticMeshActor")
                actor_class = getattr(ue, class_name, None) or ue.load_class(None, class_name)
                if actor_class is None:
                    raise ValueError("No actor class {}".format(class_name))
                actor = self._actors().spawn_actor_from_class(actor_class, spawn_at, ue.Rotator())
            self._apply(actor, {key: value for key, value in args.items() if key != "location"})
        return self._describe(actor, detail=True)

    def object_update(self, args):
        actor = self._find_actor(args.get("path") or args.get("label"))
        with self.ue.ScopedEditorTransaction("Continuum: update actor"):
            actor.modify()
            self._apply(actor, args)
        return self._describe(actor, detail=True)

    def object_delete(self, args):
        actor = self._find_actor(args.get("path") or args.get("label"))
        label = actor.get_actor_label()
        with self.ue.ScopedEditorTransaction("Continuum: delete actor"):
            self._actors().destroy_actor(actor)
        return {"deleted": label}

    # Files, assets, Blueprints ------------------------------------------------------------

    def _project_file(self, relative):
        full = os.path.normpath(os.path.join(self.project_root, relative)).replace("\\", "/")
        allowed = [self.project_root + "/Source/", self.project_root + "/Content/Python/", self.project_root + "/Config/"]
        if not any(full.startswith(prefix) for prefix in allowed):
            raise ValueError("Scripts must be under Source/, Content/Python/, or Config/")
        return full

    def script_read(self, args):
        with open(self._project_file(args["path"]), "r", encoding="utf-8") as handle:
            return {"path": args["path"], "source": handle.read()}

    def script_write(self, args):
        full = self._project_file(args["path"])
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as handle:
            handle.write(args["source"])
        note = "C++ changes need build.compile." if full.endswith((".cpp", ".h")) else "Saved."
        return {"path": args["path"], "bytes": len(args["source"]), "note": note}

    def asset_list(self, args):
        ue = self.ue
        paths = ue.EditorAssetLibrary.list_assets(args.get("path", "/Game"), True, False)
        wanted = args.get("class")
        assets = []
        for path in paths[: int(args.get("limit", 300))]:
            data = ue.EditorAssetLibrary.find_asset_data(path)
            class_name = str(data.asset_class_path.asset_name) if hasattr(data, "asset_class_path") else str(data.asset_class)
            if wanted and class_name != wanted:
                continue
            assets.append({"path": str(path), "class": class_name})
        return {"assets": assets, "total": len(paths)}

    def asset_update(self, args):
        ue = self.ue
        asset = ue.EditorAssetLibrary.load_asset(args["path"])
        if asset is None:
            raise ValueError("No asset at {}".format(args["path"]))
        with ue.ScopedEditorTransaction("Continuum: update asset"):
            asset.modify()
            for name, value in (args.get("properties") or {}).items():
                asset.set_editor_property(name, self._decode(asset.get_editor_property(name), value))
        ue.EditorAssetLibrary.save_loaded_asset(asset)
        return {"path": args["path"], "properties": {name: self._encode(asset.get_editor_property(name)) for name in (args.get("properties") or {})}}

    def asset_import(self, args):
        ue = self.ue
        source = args["source"]
        task = ue.AssetImportTask()
        task.set_editor_property("filename", source)
        task.set_editor_property("destination_path", args.get("destination", "/Game/Continuum"))
        if args.get("name"):
            task.set_editor_property("destination_name", args["name"])
        task.set_editor_property("automated", True)
        task.set_editor_property("replace_existing", True)
        task.set_editor_property("save", True)
        if source.lower().endswith(".fbx"):
            options = ue.FbxImportUI()
            options.set_editor_property("import_mesh", True)
            options.set_editor_property("import_materials", True)
            options.set_editor_property("import_textures", True)
            options.set_editor_property("import_as_skeletal", bool(args.get("skeletal", False)))
            options.static_mesh_import_data.set_editor_property("import_uniform_scale", float(args.get("scaleFactor", 1.0)))
            options.static_mesh_import_data.set_editor_property("combine_meshes", True)
            task.set_editor_property("options", options)
        ue.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
        imported = [str(path) for path in task.get_editor_property("imported_object_paths")]
        if not imported:
            raise RuntimeError("Unreal imported nothing from {}; check the Output Log.".format(source))
        result = {"imported": imported}
        mesh = next((ue.EditorAssetLibrary.load_asset(path) for path in imported if isinstance(ue.EditorAssetLibrary.load_asset(path), ue.StaticMesh)), None)
        if mesh is not None:
            result["materials"] = len(mesh.get_editor_property("static_materials"))
            subsystem = getattr(ue, "StaticMeshEditorSubsystem", None)
            if subsystem is not None:
                result["triangles"] = ue.get_editor_subsystem(subsystem).get_number_triangles(mesh, 0)
            bounds = mesh.get_bounding_box()
            result["bounds"] = {"x": bounds.max.x - bounds.min.x, "y": bounds.max.y - bounds.min.y, "z": bounds.max.z - bounds.min.z}
            place = args.get("place")
            if place is not None:
                location = place.get("location") or {}
                with ue.ScopedEditorTransaction("Continuum: place asset"):
                    actor = self._actors().spawn_actor_from_object(mesh, ue.Vector(location.get("x", 0), location.get("y", 0), location.get("z", 0)), ue.Rotator())
                    if place.get("label"):
                        actor.set_actor_label(place["label"])
                result["placed"] = actor.get_actor_label()
        return result

    def blueprint_set_defaults(self, args):
        """Sets class defaults on a Blueprint, compiles it, and reads the values back to verify."""
        ue = self.ue
        path = args["path"]
        blueprint = ue.EditorAssetLibrary.load_asset(path)
        if blueprint is None:
            raise ValueError("No Blueprint at {}".format(path))
        generated = ue.EditorAssetLibrary.load_blueprint_class(path)
        defaults = ue.get_default_object(generated)
        with ue.ScopedEditorTransaction("Continuum: set Blueprint defaults"):
            defaults.modify()
            for name, value in (args.get("properties") or {}).items():
                defaults.set_editor_property(name, self._decode(defaults.get_editor_property(name), value))
        ue.BlueprintEditorLibrary.compile_blueprint(blueprint)
        ue.EditorAssetLibrary.save_asset(path)
        verified = ue.get_default_object(ue.EditorAssetLibrary.load_blueprint_class(path))
        return {"path": path, "properties": {name: self._encode(verified.get_editor_property(name)) for name in (args.get("properties") or {})}}

    def build_status(self, args):
        return {"messages": self.compile_messages[-200:]}

    # Play In Editor and tests -------------------------------------------------------------

    def _is_playing(self):
        level = self._level()
        for name in ("is_in_play_in_editor", "editor_is_in_play_mode"):
            method = getattr(level, name, None)
            if method is not None:
                return bool(method())
        return False

    def playtest_start(self, args):
        if self._is_playing():
            return {"playState": "playing", "alreadyRunning": True}
        self._level().editor_request_begin_play()
        return {"playState": "playing"}

    def playtest_stop(self, args):
        self._level().editor_request_end_play()
        return {"playState": "edit"}

    def playtest_status(self, args):
        return {"playState": "playing" if self._is_playing() else "edit"}

    def tests_run(self, args):
        test_filter = args.get("filter") or "Project."
        self.test_capture = {"cases": [], "done": False, "last": time.time()}
        self._console("Automation RunTests {}".format(test_filter))
        capture = self.test_capture

        def poll():
            idle = time.time() - capture["last"]
            if capture["done"] or (capture["cases"] and idle > 8):
                self.test_capture = None
                passed = sum(1 for case in capture["cases"] if case["ok"])
                return {"passed": passed, "failed": len(capture["cases"]) - passed, "cases": capture["cases"], "filter": test_filter}
            return None

        return Deferred(poll, float(args.get("timeoutSeconds", 300)))

    # Viewport -----------------------------------------------------------------------------

    def viewport_capture(self, args):
        ue = self.ue
        width = int(args.get("width", 1280))
        height = int(args.get("height", 720))
        name = "continuum-{}.png".format(uuid.uuid4().hex[:8])
        ue.AutomationLibrary.take_high_res_screenshot(width, height, name)
        folder = os.path.join(ue.Paths.project_saved_dir(), "Screenshots")

        def poll():
            for root, _dirs, files in os.walk(folder):
                if name in files:
                    path = os.path.join(root, name)
                    if os.path.getsize(path) == 0:
                        return None
                    with open(path, "rb") as handle:
                        data = handle.read()
                    os.remove(path)
                    import base64

                    return {"capture": {"mimeType": "image/png", "dataBase64": base64.b64encode(data).decode("ascii"), "width": width, "height": height}}
            return None

        return Deferred(poll, 30)

    def viewport_focus(self, args):
        ue = self.ue
        actor = self._find_actor(args.get("path") or args.get("label"))
        origin, extent = actor.get_actor_bounds(False)
        distance = max((extent.x ** 2 + extent.y ** 2 + extent.z ** 2) ** 0.5 * 2.5, 300.0)
        camera = ue.Vector(origin.x - distance, origin.y - distance * 0.6, origin.z + distance * 0.5)
        rotation = ue.MathLibrary.find_look_at_rotation(camera, origin)
        self._editor().set_level_viewport_camera_info(camera, rotation)
        return {"framed": actor.get_actor_label()}

    def editor_undo(self, args):
        self._console("TRANSACTION UNDO")
        return {"undone": True}

    def project_save(self, args):
        saved = self.ue.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
        return {"saved": bool(saved)}

    # Main thread ---------------------------------------------------------------------------

    def tick(self, _delta=0.0):
        playing = "playing" if self._is_playing() else "edit"
        if playing != self.play_state:
            self.play_state = playing
            self.events.put({"type": "play_state", "state": playing})
        for command_id, deferred in list(self.deferred.items()):
            try:
                value = deferred.poll()
            except Exception as error:
                del self.deferred[command_id]
                self.outbox.put({"id": command_id, "ok": False, "error": str(error)})
                continue
            if value is not None:
                del self.deferred[command_id]
                self.outbox.put({"id": command_id, "ok": True, "value": value})
            elif time.time() > deferred.deadline:
                del self.deferred[command_id]
                self.outbox.put({"id": command_id, "ok": False, "error": "Timed out waiting for the editor."})
        for _ in range(8):
            try:
                command = self.inbox.get_nowait()
            except queue.Empty:
                break
            self.run_command(command)

    def run_command(self, command):
        handler = self.operations.get(command.get("operation"))
        if handler is None:
            self.outbox.put({"id": command["id"], "ok": False, "error": "Unsupported operation {}".format(command.get("operation"))})
            return
        try:
            value = handler(command.get("args") or {})
        except Exception as error:
            self.ue.log_warning("[Continuum] {} failed: {}".format(command.get("operation"), traceback.format_exc(limit=3)))
            self.outbox.put({"id": command["id"], "ok": False, "error": str(error)})
            return
        if isinstance(value, Deferred):
            self.deferred[command["id"]] = value
        else:
            self.outbox.put({"id": command["id"], "ok": True, "value": value})

    # Log tail -----------------------------------------------------------------------------

    def read_log(self):
        if not self.log_path or not os.path.exists(self.log_path):
            return
        size = os.path.getsize(self.log_path)
        if self.log_offset is None or size < self.log_offset:
            self.log_offset = size
            return
        with open(self.log_path, "r", encoding="utf-8", errors="replace") as handle:
            handle.seek(self.log_offset)
            chunk = handle.read()
            self.log_offset = handle.tell()
        for line in chunk.splitlines():
            self.ingest_log_line(line)

    def ingest_log_line(self, line):
        if "[Continuum]" in line:
            return
        capture = self.test_capture
        if capture is not None:
            match = TEST_RESULT.search(line)
            if match:
                capture["cases"].append({"name": match.group("path"), "ok": match.group("result") == "Success", "status": match.group("result")})
                capture["last"] = time.time()
            elif "TEST COMPLETE" in line or "Automation Test Queue Empty" in line:
                capture["done"] = True
        parsed = LOG_LEVEL.match(line)
        verbosity = parsed.group("verbosity") if parsed else None
        if parsed and parsed.group("category") in ("LogCompile", "LogLiveCoding") and verbosity in ("Error", "Warning"):
            self.compile_messages.append({"severity": verbosity.lower(), "message": parsed.group("message"), "file": None, "line": None})
            self.events.put({"type": "compile", "messages": self.compile_messages[-200:]})
        level = "error" if verbosity == "Error" else "warning" if verbosity == "Warning" else "info"
        if verbosity in ("Error", "Warning") or (parsed and parsed.group("category") in ("LogBlueprintUserMessages", "LogTemp")):
            self.events.put({"type": "log", "level": level, "message": line})

    # Transport -----------------------------------------------------------------------------

    def _request(self, method, path, body=None, timeout=10):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method)
        request.add_header("Authorization", "Bearer " + self.token)
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8") or "{}")
            except ValueError:
                payload = {}
            return error.code, payload

    def hello(self):
        status, body = self._request(
            "POST",
            "/v1/hello",
            {
                "protocol": PROTOCOL,
                "engine": "unreal",
                "editorVersion": self.ue.SystemLibrary.get_engine_version(),
                "pluginVersion": PLUGIN_VERSION,
                "instanceId": self.instance_id,
                "projectRoot": self.project_root,
                "projectName": self.project_name,
                "operations": sorted(self.operations.keys()),
                "playState": self.play_state,
                "inflight": list(self.deferred.keys()),
            },
        )
        if status != 200 or "sessionId" not in body:
            raise RuntimeError(body.get("error", "hello failed with {}".format(status)))
        self.session = body["sessionId"]

    def flush(self):
        results = []
        while not self.outbox.empty():
            results.append(self.outbox.get_nowait())
        if results:
            self._request("POST", "/v1/results", {"session": self.session, "results": results}, timeout=30)
        events = []
        while not self.events.empty() and len(events) < 300:
            events.append(self.events.get_nowait())
        if events:
            self._request("POST", "/v1/events", {"session": self.session, "events": events})

    def loop(self):
        backoff = 1.0
        while self.running:
            try:
                if self.session is None:
                    self.hello()
                self.read_log()
                self.flush()
                status, body = self._request("GET", "/v1/poll?session=" + self.session, timeout=35)
                if status in (401, 404):
                    self.session = None
                    continue
                for command in body.get("commands", []):
                    self.inbox.put(command)
                for _ in range(50):
                    if self.inbox.empty() and not self.deferred:
                        break
                    if not self.outbox.empty():
                        break
                    time.sleep(0.02)
                self.flush()
                backoff = 1.0
            except Exception as error:
                self.session = None
                self.ue.log_warning("[Continuum] Waiting for Continuum: {}".format(error))
                time.sleep(backoff)
                backoff = min(backoff * 2, 15.0)

    def flush_loop(self):
        # The poll thread blocks on the long poll; results and logs go out from here meanwhile.
        while self.running:
            time.sleep(0.25)
            if self.session is None:
                continue
            try:
                self.read_log()
                self.flush()
            except Exception:
                pass

    def start(self):
        self.running = True
        thread = threading.Thread(target=self.loop, name="Continuum Bridge", daemon=True)
        thread.start()
        threading.Thread(target=self.flush_loop, name="Continuum Bridge Flush", daemon=True).start()
        return thread

    def stop(self):
        self.running = False
        if self.session:
            try:
                self._request("POST", "/v1/goodbye", {"session": self.session}, timeout=2)
            except Exception:
                pass


_bridge = None


def start(ue):
    """Reads <Project>/.continuum/bridge.json, which Continuum writes when it opens the project."""
    global _bridge
    if _bridge is not None:
        return _bridge
    project_dir = os.path.abspath(ue.Paths.project_dir())
    config_path = os.path.join(project_dir, ".continuum", "bridge.json")
    if not os.path.exists(config_path):
        ue.log("[Continuum] No .continuum/bridge.json; open this project from Continuum to connect.")
        return None
    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    project_file = ue.Paths.get_project_file_path()
    project_name = os.path.splitext(os.path.basename(project_file))[0]
    log_path = os.path.join(os.path.abspath(ue.Paths.project_log_dir()), project_name + ".log")
    _bridge = Bridge(ue, config, project_dir, project_name, log_path)
    ue.register_slate_post_tick_callback(_bridge.tick)
    _bridge.start()
    ue.log("[Continuum] Bridge connecting to {}".format(_bridge.url))
    return _bridge

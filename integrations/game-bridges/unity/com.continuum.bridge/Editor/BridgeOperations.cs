using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace Continuum.Bridge
{
    /// <summary>The operations this adapter implements, each on Unity's main thread.</summary>
    public static class BridgeOperations
    {
        /// <summary>Returned by an operation that replies later through ContinuumBridge.CompleteLater.</summary>
        public sealed class Deferred { }

        public static List<object> LastCompile = new List<object>();

        static readonly Dictionary<string, Func<string, Dictionary<string, object>, object>> Handlers =
            new Dictionary<string, Func<string, Dictionary<string, object>, object>>
            {
                ["scene.tree"] = (_, a) => SceneTree(a),
                ["selection.get"] = (_, a) => new Dictionary<string, object> { ["selection"] = Selection.gameObjects.Select(go => (object)PathOf(go)).ToList() },
                ["object.get"] = (_, a) => Describe(RequireObject(Str(a, "path"))),
                ["object.create"] = (_, a) => Create(a),
                ["object.update"] = (_, a) => Update(a),
                ["object.delete"] = (_, a) => Delete(a),
                ["script.read"] = (_, a) => new Dictionary<string, object> { ["path"] = Str(a, "path"), ["source"] = File.ReadAllText(ProjectFile(Str(a, "path"))) },
                ["script.write"] = (_, a) => WriteScript(a),
                ["asset.list"] = (_, a) => ListAssets(a),
                ["asset.update"] = (_, a) => UpdateAsset(a),
                ["asset.import"] = (_, a) => ImportAsset(a),
                ["build.status"] = (_, a) => new Dictionary<string, object> { ["compiling"] = EditorApplication.isCompiling, ["messages"] = LastCompile },
                ["build.compile"] = (_, a) => { CompilationPipeline.RequestScriptCompilation(); return new Dictionary<string, object> { ["requested"] = true }; },
                ["playtest.start"] = (_, a) => { EditorApplication.EnterPlaymode(); return new Dictionary<string, object> { ["playState"] = "playing" }; },
                ["playtest.stop"] = (_, a) => { EditorApplication.ExitPlaymode(); return new Dictionary<string, object> { ["playState"] = "edit" }; },
                ["playtest.status"] = (_, a) => new Dictionary<string, object> { ["playState"] = ContinuumBridge.PlayState() },
                ["tests.run"] = (id, a) => TestRuns.Start(id, a),
                ["viewport.capture"] = (_, a) => Capture(a),
                ["viewport.focus"] = (_, a) => Focus(a),
                ["editor.undo"] = (_, a) => { Undo.PerformUndo(); return new Dictionary<string, object> { ["undone"] = true }; },
                ["project.save"] = (_, a) =>
                {
                    var saved = EditorSceneManager.SaveOpenScenes();
                    AssetDatabase.SaveAssets();
                    return new Dictionary<string, object> { ["saved"] = saved };
                },
            };

        public static List<object> Advertised => Handlers.Keys.OrderBy(key => key).Cast<object>().ToList();

        public static object Run(string id, string operation, Dictionary<string, object> args)
        {
            if (!Handlers.TryGetValue(operation, out var handler)) throw new InvalidOperationException($"Unsupported operation {operation}");
            return handler(id, args);
        }

        // Arguments -----------------------------------------------------------------------------

        static string Str(Dictionary<string, object> args, string key, string fallback = null) =>
            args.TryGetValue(key, out var value) && value is string text ? text : fallback ?? throw new ArgumentException($"Missing {key}");

        static double Num(Dictionary<string, object> args, string key, double fallback) =>
            args.TryGetValue(key, out var value) && value is double number ? number : fallback;

        static Dictionary<string, object> Map(Dictionary<string, object> args, string key) =>
            args.TryGetValue(key, out var value) && value is Dictionary<string, object> map ? map : new Dictionary<string, object>();

        static string ProjectFile(string relative)
        {
            var full = Path.GetFullPath(Path.Combine(ContinuumBridge.ProjectRoot, relative)).Replace('\\', '/');
            if (!full.StartsWith(ContinuumBridge.ProjectRoot + "/Assets/") && !full.StartsWith(ContinuumBridge.ProjectRoot + "/Packages/"))
                throw new UnauthorizedAccessException("Scripts must be under Assets/ or Packages/.");
            return full;
        }

        // Objects -------------------------------------------------------------------------------

        public static string PathOf(GameObject go)
        {
            var names = new List<string>();
            for (var current = go.transform; current != null; current = current.parent) names.Insert(0, current.name);
            return go.scene.name + "/" + string.Join("/", names);
        }

        static GameObject FindObject(string path)
        {
            var parts = path.Split('/');
            for (var index = 0; index < SceneManager.sceneCount; index++)
            {
                var scene = SceneManager.GetSceneAt(index);
                if (!scene.isLoaded) continue;
                var offset = parts.Length > 1 && parts[0] == scene.name ? 1 : 0;
                foreach (var root in scene.GetRootGameObjects())
                {
                    if (root.name != parts[offset]) continue;
                    var current = root.transform;
                    for (var depth = offset + 1; depth < parts.Length && current != null; depth++) current = current.Find(parts[depth]);
                    if (current != null) return current.gameObject;
                }
            }
            return null;
        }

        static GameObject RequireObject(string path) => FindObject(path) ?? throw new ArgumentException($"No GameObject at {path}");

        static object SceneTree(Dictionary<string, object> args)
        {
            var depth = (int)Num(args, "depth", 3);
            var budget = new[] { 800 };
            var scenes = new List<object>();
            for (var index = 0; index < SceneManager.sceneCount; index++)
            {
                var scene = SceneManager.GetSceneAt(index);
                if (!scene.isLoaded) continue;
                scenes.Add(new Dictionary<string, object>
                {
                    ["scene"] = scene.name,
                    ["path"] = scene.path,
                    ["dirty"] = scene.isDirty,
                    ["roots"] = scene.GetRootGameObjects().Select(go => Node(go, depth, budget)).ToList(),
                });
            }
            return new Dictionary<string, object> { ["scenes"] = scenes };
        }

        static object Node(GameObject go, int depth, int[] budget)
        {
            budget[0]--;
            var node = new Dictionary<string, object>
            {
                ["name"] = go.name,
                ["path"] = PathOf(go),
                ["active"] = go.activeSelf,
                ["components"] = go.GetComponents<Component>().Where(c => c != null).Select(c => (object)c.GetType().Name).ToList(),
                ["childCount"] = go.transform.childCount,
            };
            if (depth > 0 && budget[0] > 0)
            {
                var children = new List<object>();
                foreach (Transform child in go.transform)
                {
                    if (budget[0] <= 0) { node["truncated"] = true; break; }
                    children.Add(Node(child.gameObject, depth - 1, budget));
                }
                node["children"] = children;
            }
            return node;
        }

        static object Describe(GameObject go)
        {
            var components = new List<object>();
            foreach (var component in go.GetComponents<Component>())
            {
                if (component == null) { components.Add(new Dictionary<string, object> { ["type"] = "(missing script)" }); continue; }
                components.Add(new Dictionary<string, object> { ["type"] = component.GetType().Name, ["properties"] = BridgeValues.Read(new SerializedObject(component)) });
            }
            var bounds = WorldBounds(go);
            return new Dictionary<string, object>
            {
                ["path"] = PathOf(go),
                ["active"] = go.activeSelf,
                ["tag"] = go.tag,
                ["layer"] = LayerMask.LayerToName(go.layer),
                ["position"] = BridgeValues.Vector(go.transform.position),
                ["rotation"] = BridgeValues.Vector(go.transform.eulerAngles),
                ["scale"] = BridgeValues.Vector(go.transform.localScale),
                ["bounds"] = bounds.HasValue ? new Dictionary<string, object> { ["center"] = BridgeValues.Vector(bounds.Value.center), ["size"] = BridgeValues.Vector(bounds.Value.size) } : null,
                ["components"] = components,
            };
        }

        static Bounds? WorldBounds(GameObject go)
        {
            Bounds? bounds = null;
            foreach (var renderer in go.GetComponentsInChildren<Renderer>())
            {
                if (bounds.HasValue) { var b = bounds.Value; b.Encapsulate(renderer.bounds); bounds = b; }
                else bounds = renderer.bounds;
            }
            return bounds;
        }

        static Type FindType(string name)
        {
            var match = TypeCache.GetTypesDerivedFrom<Component>().FirstOrDefault(type => type.Name == name || type.FullName == name);
            return match ?? throw new ArgumentException($"No component type {name}");
        }

        static object Create(Dictionary<string, object> args)
        {
            var name = Str(args, "name", "GameObject");
            GameObject go;
            if (args.TryGetValue("primitive", out var primitive) && primitive is string kind)
            {
                go = GameObject.CreatePrimitive((PrimitiveType)Enum.Parse(typeof(PrimitiveType), kind, true));
                go.name = name;
            }
            else go = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(go, "Continuum: create " + name);
            if (args.TryGetValue("parent", out var parent) && parent is string parentPath) go.transform.SetParent(RequireObject(parentPath).transform, false);
            if (args.TryGetValue("components", out var list) && list is List<object> components)
                foreach (var component in components) Undo.AddComponent(go, FindType((string)component));
            Apply(go, args);
            EditorSceneManager.MarkSceneDirty(go.scene);
            return Describe(go);
        }

        static object Update(Dictionary<string, object> args)
        {
            var go = RequireObject(Str(args, "path"));
            Undo.RecordObject(go, "Continuum: update");
            Undo.RecordObject(go.transform, "Continuum: update");
            if (args.TryGetValue("name", out var name) && name is string text) go.name = text;
            if (args.TryGetValue("active", out var active) && active is bool flag) go.SetActive(flag);
            if (args.TryGetValue("addComponents", out var add) && add is List<object> additions)
                foreach (var component in additions) Undo.AddComponent(go, FindType((string)component));
            if (args.TryGetValue("removeComponents", out var remove) && remove is List<object> removals)
                foreach (var component in removals) { var existing = go.GetComponent(FindType((string)component)); if (existing != null) Undo.DestroyObjectImmediate(existing); }
            Apply(go, args);
            EditorSceneManager.MarkSceneDirty(go.scene);
            return Describe(go);
        }

        /// <summary>`position`/`rotation`/`scale` shortcuts, then `properties` as `Component.propertyPath`.</summary>
        static void Apply(GameObject go, Dictionary<string, object> args)
        {
            if (args.TryGetValue("position", out var position)) go.transform.position = BridgeValues.ToVector3(position);
            if (args.TryGetValue("rotation", out var rotation)) go.transform.eulerAngles = BridgeValues.ToVector3(rotation);
            if (args.TryGetValue("scale", out var scale)) go.transform.localScale = BridgeValues.ToVector3(scale);
            foreach (var pair in Map(args, "properties"))
            {
                var dot = pair.Key.IndexOf('.');
                if (dot <= 0) throw new ArgumentException($"Property {pair.Key} must be Component.propertyPath, such as Rigidbody.m_Mass");
                var component = go.GetComponent(FindType(pair.Key.Substring(0, dot))) ?? throw new ArgumentException($"{go.name} has no {pair.Key.Substring(0, dot)}");
                var serialized = new SerializedObject(component);
                BridgeValues.Set(serialized, pair.Key.Substring(dot + 1), pair.Value);
                serialized.ApplyModifiedProperties();
            }
        }

        static object Delete(Dictionary<string, object> args)
        {
            var go = RequireObject(Str(args, "path"));
            var path = PathOf(go);
            var scene = go.scene;
            Undo.DestroyObjectImmediate(go);
            EditorSceneManager.MarkSceneDirty(scene);
            return new Dictionary<string, object> { ["deleted"] = path };
        }

        // Scripts and assets -------------------------------------------------------------------

        static object WriteScript(Dictionary<string, object> args)
        {
            var relative = Str(args, "path");
            var full = ProjectFile(relative);
            Directory.CreateDirectory(Path.GetDirectoryName(full));
            File.WriteAllText(full, Str(args, "source"));
            AssetDatabase.ImportAsset(relative, ImportAssetOptions.ForceUpdate);
            return new Dictionary<string, object> { ["path"] = relative, ["compiling"] = EditorApplication.isCompiling, ["note"] = "Compiler results arrive as compile events; read them with build.status." };
        }

        static object ListAssets(Dictionary<string, object> args)
        {
            var folder = Str(args, "folder", "Assets");
            var guids = AssetDatabase.FindAssets(Str(args, "filter", ""), new[] { folder });
            return new Dictionary<string, object>
            {
                ["assets"] = guids.Take((int)Num(args, "limit", 200)).Select(guid =>
                {
                    var path = AssetDatabase.GUIDToAssetPath(guid);
                    return (object)new Dictionary<string, object> { ["path"] = path, ["type"] = AssetDatabase.GetMainAssetTypeAtPath(path)?.Name };
                }).ToList(),
                ["total"] = guids.Length,
            };
        }

        static object UpdateAsset(Dictionary<string, object> args)
        {
            var path = Str(args, "path");
            var asset = AssetDatabase.LoadMainAssetAtPath(path) ?? throw new ArgumentException($"No asset at {path}");
            Undo.RecordObject(asset, "Continuum: update asset");
            var serialized = new SerializedObject(asset);
            foreach (var pair in Map(args, "properties")) BridgeValues.Set(serialized, pair.Key, pair.Value);
            serialized.ApplyModifiedProperties();
            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssets();
            return new Dictionary<string, object> { ["path"] = path, ["properties"] = BridgeValues.Read(new SerializedObject(asset)) };
        }

        /// <summary>Copies a file into Assets, imports it with the scale the exporter chose, and can place it.</summary>
        static object ImportAsset(Dictionary<string, object> args)
        {
            var source = Str(args, "source");
            var destination = Str(args, "destination");
            var full = ProjectFile(destination);
            Directory.CreateDirectory(Path.GetDirectoryName(full));
            File.Copy(source, full, true);
            AssetDatabase.ImportAsset(destination, ImportAssetOptions.ForceUpdate);
            var importer = AssetImporter.GetAtPath(destination);
            if (importer is ModelImporter model)
            {
                model.globalScale = (float)Num(args, "scaleFactor", 1);
                model.useFileScale = true;
                model.bakeAxisConversion = true;
                model.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
                model.SaveAndReimport();
            }
            else if (importer is TextureImporter texture && Str(args, "kind", "texture") == "ui")
            {
                texture.textureType = TextureImporterType.Sprite;
                texture.alphaIsTransparency = true;
                texture.SaveAndReimport();
            }
            var result = new Dictionary<string, object> { ["path"] = destination, ["importer"] = importer?.GetType().Name };
            var asset = AssetDatabase.LoadMainAssetAtPath(destination);
            if (asset is GameObject prefab && args.TryGetValue("place", out var placeRaw) && placeRaw is Dictionary<string, object> place)
            {
                var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                Undo.RegisterCreatedObjectUndo(instance, "Continuum: place asset");
                instance.name = Str(place, "name", prefab.name);
                if (place.TryGetValue("parent", out var parent) && parent is string parentPath) instance.transform.SetParent(RequireObject(parentPath).transform, false);
                if (place.TryGetValue("position", out var position)) instance.transform.position = BridgeValues.ToVector3(position);
                EditorSceneManager.MarkSceneDirty(instance.scene);
                var renderers = instance.GetComponentsInChildren<Renderer>();
                var materials = renderers.SelectMany(renderer => renderer.sharedMaterials).ToList();
                var triangles = instance.GetComponentsInChildren<MeshFilter>().Where(filter => filter.sharedMesh != null).Sum(filter => (long)filter.sharedMesh.triangles.Length / 3);
                var bounds = WorldBounds(instance);
                result["placed"] = PathOf(instance);
                result["bounds"] = bounds.HasValue ? BridgeValues.Vector(bounds.Value.size) : null;
                result["materials"] = materials.Count(material => material != null);
                result["missingMaterials"] = materials.Count(material => material == null);
                result["missingTextures"] = materials.Count(material => material != null && material.HasProperty("_MainTex") && material.mainTexture == null && material.name.IndexOf("Default", StringComparison.OrdinalIgnoreCase) < 0);
                result["triangles"] = triangles;
            }
            else if (asset is Texture2D texture2D)
            {
                result["width"] = texture2D.width;
                result["height"] = texture2D.height;
            }
            return result;
        }

        // Viewport ------------------------------------------------------------------------------

        static object Capture(Dictionary<string, object> args)
        {
            var view = Str(args, "view", EditorApplication.isPlaying ? "game" : "scene");
            var width = Mathf.Clamp((int)Num(args, "width", 1280), 64, 3840);
            var height = Mathf.Clamp((int)Num(args, "height", 720), 64, 2160);
            var camera = view == "game" ? (Camera.main ?? Object.FindObjectsOfType<Camera>().FirstOrDefault()) : SceneView.lastActiveSceneView?.camera;
            if (camera == null) throw new InvalidOperationException(view == "game" ? "The scene has no camera." : "Open a Scene view first.");
            var target = RenderTexture.GetTemporary(width, height, 24);
            var previous = camera.targetTexture;
            var previousActive = RenderTexture.active;
            try
            {
                camera.targetTexture = target;
                camera.Render();
                RenderTexture.active = target;
                var texture = new Texture2D(width, height, TextureFormat.RGB24, false);
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply();
                var png = texture.EncodeToPNG();
                Object.DestroyImmediate(texture);
                return new Dictionary<string, object>
                {
                    ["view"] = view,
                    ["camera"] = camera.name,
                    ["capture"] = new Dictionary<string, object> { ["mimeType"] = "image/png", ["dataBase64"] = Convert.ToBase64String(png), ["width"] = width, ["height"] = height },
                };
            }
            finally
            {
                camera.targetTexture = previous;
                RenderTexture.active = previousActive;
                RenderTexture.ReleaseTemporary(target);
            }
        }

        static object Focus(Dictionary<string, object> args)
        {
            var go = RequireObject(Str(args, "path"));
            Selection.activeGameObject = go;
            var view = SceneView.lastActiveSceneView ?? throw new InvalidOperationException("Open a Scene view first.");
            view.FrameSelected();
            return new Dictionary<string, object> { ["framed"] = PathOf(go) };
        }
    }

    /// <summary>Edit Mode and Play Mode runs through the Test Framework; results survive the reload Play Mode causes.</summary>
    public static class TestRuns
    {
        const string PendingKey = "Continuum.Bridge.PendingTest";
        static TestRunnerApi api;

        public static void Register()
        {
            api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.RegisterCallbacks(new Callbacks());
        }

        public static object Start(string commandId, Dictionary<string, object> args)
        {
            var mode = args.TryGetValue("mode", out var raw) && raw is string text && text.Equals("PlayMode", StringComparison.OrdinalIgnoreCase) ? TestMode.PlayMode : TestMode.EditMode;
            var filter = new Filter { testMode = mode };
            if (args.TryGetValue("filter", out var value) && value is string pattern && pattern != "") filter.groupNames = new[] { pattern };
            SessionState.SetString(PendingKey, commandId);
            ContinuumBridge.MarkInflight(commandId);
            api.Execute(new ExecutionSettings(filter));
            return new BridgeOperations.Deferred();
        }

        sealed class Callbacks : ICallbacks
        {
            public void RunStarted(ITestAdaptor testsToRun) { }
            public void TestStarted(ITestAdaptor test) { }
            public void TestFinished(ITestResultAdaptor result) { }

            public void RunFinished(ITestResultAdaptor result)
            {
                var commandId = SessionState.GetString(PendingKey, "");
                if (commandId == "") return;
                SessionState.EraseString(PendingKey);
                var cases = new List<object>();
                Collect(result, cases);
                var summary = new Dictionary<string, object>
                {
                    ["passed"] = result.PassCount,
                    ["failed"] = result.FailCount,
                    ["skipped"] = result.SkipCount,
                    ["durationSeconds"] = result.Duration,
                    ["cases"] = cases.Take(200).ToList(),
                };
                ContinuumBridge.QueueEvent(new Dictionary<string, object>
                {
                    ["type"] = "test_result",
                    ["summary"] = $"{result.PassCount} passed, {result.FailCount} failed, {result.SkipCount} skipped",
                    ["passed"] = result.FailCount == 0,
                });
                ContinuumBridge.CompleteLater(commandId, true, summary, null);
            }

            static void Collect(ITestResultAdaptor result, List<object> cases)
            {
                if (!result.HasChildren)
                {
                    cases.Add(new Dictionary<string, object>
                    {
                        ["name"] = result.Test.FullName,
                        ["ok"] = result.TestStatus == TestStatus.Passed,
                        ["status"] = result.TestStatus.ToString(),
                        ["error"] = string.IsNullOrEmpty(result.Message) ? null : result.Message,
                    });
                    return;
                }
                foreach (var child in result.Children) Collect(child, cases);
            }
        }
    }
}

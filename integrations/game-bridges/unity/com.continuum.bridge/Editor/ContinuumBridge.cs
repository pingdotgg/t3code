using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace Continuum.Bridge
{
    /// <summary>
    /// Connects this Unity Editor to the Continuum bridge on 127.0.0.1. A background thread long-polls
    /// for commands; the editor's main thread runs them. Survives domain reloads (script changes and
    /// entering Play Mode) by keeping its instance id and in-flight commands in SessionState.
    /// </summary>
    [InitializeOnLoad]
    public static class ContinuumBridge
    {
        public const string PluginVersion = "1.0.0";
        const int Protocol = 1;
        const string InstanceKey = "Continuum.Bridge.Instance";
        const string InflightKey = "Continuum.Bridge.Inflight";
        const string CompileKey = "Continuum.Bridge.Compile";

        static readonly ConcurrentQueue<Dictionary<string, object>> Inbox = new ConcurrentQueue<Dictionary<string, object>>();
        static readonly ConcurrentQueue<object> Outbox = new ConcurrentQueue<object>();
        static readonly ConcurrentQueue<object> Events = new ConcurrentQueue<object>();
        static readonly List<CompilerMessage> CompileMessages = new List<CompilerMessage>();

        static Thread worker;
        static volatile bool running;
        static string sessionId;
        static string url;
        static string token;
        public static string ProjectRoot { get; private set; }
        public static string Status { get; private set; } = "Starting";

        static ContinuumBridge()
        {
            ProjectRoot = Directory.GetParent(Application.dataPath).FullName.Replace('\\', '/');
            if (!ReadConfig()) { Status = "Not configured: open this project from Continuum."; return; }
            if (string.IsNullOrEmpty(SessionState.GetString(InstanceKey, "")))
                SessionState.SetString(InstanceKey, Guid.NewGuid().ToString("N"));

            Application.logMessageReceivedThreaded += OnLog;
            EditorApplication.update += Pump;
            EditorApplication.playModeStateChanged += change =>
                QueueEvent(new Dictionary<string, object> { ["type"] = "play_state", ["state"] = PlayState() });
            AssemblyReloadEvents.beforeAssemblyReload += BeforeReload;
            CompilationPipeline.compilationStarted += _ => CompileMessages.Clear();
            CompilationPipeline.assemblyCompilationFinished += (_, messages) => CompileMessages.AddRange(messages);
            CompilationPipeline.compilationFinished += _ => PersistCompile();
            EditorApplication.quitting += Stop;
            TestRuns.Register();

            // Compiler output from the build that triggered this reload.
            var stored = SessionState.GetString(CompileKey, "");
            if (stored != "")
            {
                Events.Enqueue(MiniJson.Parse(stored));
                SessionState.EraseString(CompileKey);
            }
            Start();
        }

        static bool ReadConfig()
        {
            var path = Path.Combine(ProjectRoot, ".continuum", "bridge.json");
            if (!File.Exists(path)) return false;
            try
            {
                var config = (Dictionary<string, object>)MiniJson.Parse(File.ReadAllText(path));
                url = ((string)config["url"]).TrimEnd('/');
                token = (string)config["token"];
                return !string.IsNullOrEmpty(url) && !string.IsNullOrEmpty(token);
            }
            catch (Exception error)
            {
                Debug.LogWarning($"[Continuum] Could not read {path}: {error.Message}");
                return false;
            }
        }

        public static string PlayState() =>
            EditorApplication.isPaused ? "paused" : EditorApplication.isPlayingOrWillChangePlaymode ? "playing" : "edit";

        public static void QueueEvent(object value) => Events.Enqueue(value);

        public static void CompleteLater(string commandId, bool ok, object value, string error)
        {
            RemoveInflight(commandId);
            Outbox.Enqueue(Result(commandId, ok, value, error));
        }

        public static void MarkInflight(string commandId)
        {
            var list = Inflight();
            if (!list.Contains(commandId)) list.Add(commandId);
            SessionState.SetString(InflightKey, string.Join(",", list));
        }

        static void RemoveInflight(string commandId)
        {
            var list = Inflight();
            list.Remove(commandId);
            SessionState.SetString(InflightKey, string.Join(",", list));
        }

        static List<string> Inflight() =>
            new List<string>(SessionState.GetString(InflightKey, "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries));

        static void PersistCompile()
        {
            var messages = new List<object>();
            foreach (var message in CompileMessages)
            {
                if (message.type != CompilerMessageType.Error && message.type != CompilerMessageType.Warning) continue;
                messages.Add(new Dictionary<string, object>
                {
                    ["severity"] = message.type == CompilerMessageType.Error ? "error" : "warning",
                    ["message"] = message.message,
                    ["file"] = string.IsNullOrEmpty(message.file) ? null : message.file,
                    ["line"] = message.line,
                });
                if (messages.Count >= 200) break;
            }
            var compileEvent = new Dictionary<string, object> { ["type"] = "compile", ["messages"] = messages };
            BridgeOperations.LastCompile = messages;
            // A successful compile reloads the domain before this thread can send; keep it for afterwards.
            SessionState.SetString(CompileKey, MiniJson.Serialize(compileEvent));
            Events.Enqueue(compileEvent);
        }

        static void OnLog(string condition, string stackTrace, LogType type)
        {
            if (condition.StartsWith("[Continuum]")) return;
            var level = type == LogType.Warning ? "warning" : type == LogType.Log ? "info" : "error";
            var message = level == "error" && !string.IsNullOrEmpty(stackTrace) ? $"{condition}\n{stackTrace}" : condition;
            Events.Enqueue(new Dictionary<string, object> { ["type"] = "log", ["level"] = level, ["message"] = message });
        }

        static void BeforeReload()
        {
            running = false;
            try { Post("/v1/events", new Dictionary<string, object> { ["session"] = sessionId, ["events"] = new List<object> { new Dictionary<string, object> { ["type"] = "reloading" } } }, 2000); }
            catch { }
        }

        static void Start()
        {
            running = true;
            worker = new Thread(Loop) { IsBackground = true, Name = "Continuum Bridge" };
            worker.Start();
            // The poll thread blocks on the long poll; results and logs go out from here meanwhile.
            new Thread(() =>
            {
                while (running)
                {
                    Thread.Sleep(250);
                    try { Flush(); } catch { }
                }
            }) { IsBackground = true, Name = "Continuum Bridge Flush" }.Start();
        }

        static void Stop()
        {
            running = false;
            if (sessionId == null) return;
            try { Post("/v1/goodbye", new Dictionary<string, object> { ["session"] = sessionId }, 2000); } catch { }
        }

        /// <summary>Runs queued commands on the main thread, where Unity's APIs work.</summary>
        static void Pump()
        {
            var budget = 8;
            while (budget-- > 0 && Inbox.TryDequeue(out var command))
            {
                var id = (string)command["id"];
                var operation = (string)command["operation"];
                var args = command.TryGetValue("args", out var raw) && raw is Dictionary<string, object> map ? map : new Dictionary<string, object>();
                try
                {
                    var value = BridgeOperations.Run(id, operation, args);
                    if (!(value is BridgeOperations.Deferred)) Outbox.Enqueue(Result(id, true, value, null));
                }
                catch (Exception error)
                {
                    Outbox.Enqueue(Result(id, false, null, error.InnerException?.Message ?? error.Message));
                }
            }
        }

        static Dictionary<string, object> Result(string id, bool ok, object value, string error) =>
            new Dictionary<string, object> { ["id"] = id, ["ok"] = ok, ["value"] = value, ["error"] = error };

        static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(40) };

        static string Send(HttpMethod method, string path, object body, int timeoutMs, out int status)
        {
            using (var cancel = new CancellationTokenSource(timeoutMs))
            using (var request = new HttpRequestMessage(method, url + path))
            {
                request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
                if (body != null) request.Content = new StringContent(MiniJson.Serialize(body), Encoding.UTF8, "application/json");
                var response = Http.SendAsync(request, cancel.Token).GetAwaiter().GetResult();
                status = (int)response.StatusCode;
                return response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            }
        }

        static string Post(string path, object body, int timeoutMs) => Send(HttpMethod.Post, path, body, timeoutMs, out _);

        static void Hello()
        {
            var body = new Dictionary<string, object>
            {
                ["protocol"] = Protocol,
                ["engine"] = "unity",
                ["editorVersion"] = Application.unityVersion,
                ["pluginVersion"] = PluginVersion,
                ["instanceId"] = "unity-" + SessionState.GetString(InstanceKey, ""),
                ["projectRoot"] = ProjectRoot,
                ["projectName"] = Application.productName,
                ["operations"] = BridgeOperations.Advertised,
                ["playState"] = MainThreadPlayState,
                ["inflight"] = Inflight(),
            };
            var text = Send(HttpMethod.Post, "/v1/hello", body, 5000, out var status);
            var reply = MiniJson.Parse(text) as Dictionary<string, object>;
            if (status != 200 || reply == null || !reply.ContainsKey("sessionId"))
                throw new InvalidOperationException(reply != null && reply.TryGetValue("error", out var message) ? (string)message : $"Hello failed ({status}).");
            sessionId = (string)reply["sessionId"];
            Status = "Connected";
        }

        static volatile string MainThreadPlayState = "edit";

        static void Loop()
        {
            var backoff = 1000;
            while (running)
            {
                try
                {
                    if (sessionId == null) Hello();
                    Flush();
                    var text = Send(HttpMethod.Get, "/v1/poll?session=" + Uri.EscapeDataString(sessionId), null, 35000, out var status);
                    if (status == 404 || status == 401) { sessionId = null; continue; }
                    if (MiniJson.Parse(text) is Dictionary<string, object> reply && reply.TryGetValue("commands", out var list) && list is List<object> commands)
                        foreach (var command in commands) Inbox.Enqueue((Dictionary<string, object>)command);
                    // Results arrive from the main thread; wait briefly so short commands reply in this round trip.
                    for (var wait = 0; wait < 50 && Inbox.Count > 0; wait++) Thread.Sleep(20);
                    Flush();
                    backoff = 1000;
                }
                catch (Exception error)
                {
                    Status = "Waiting for Continuum: " + error.Message;
                    sessionId = null;
                    Thread.Sleep(backoff);
                    backoff = Math.Min(backoff * 2, 15000);
                }
            }
        }

        static void Flush()
        {
            if (sessionId == null) return;
            var results = new List<object>();
            while (Outbox.TryDequeue(out var result)) results.Add(result);
            if (results.Count > 0) Post("/v1/results", new Dictionary<string, object> { ["session"] = sessionId, ["results"] = results }, 30000);
            var events = new List<object>();
            while (events.Count < 300 && Events.TryDequeue(out var value)) events.Add(value);
            if (events.Count > 0) Post("/v1/events", new Dictionary<string, object> { ["session"] = sessionId, ["events"] = events }, 10000);
        }

        [MenuItem("Tools/Continuum/Bridge Status")]
        static void ShowStatus() => EditorUtility.DisplayDialog("Continuum Bridge", $"{Status}\n\nProject: {ProjectRoot}", "OK");

        // Play state is read on the main thread and cached for the worker's hello.
        [InitializeOnLoadMethod]
        static void TrackPlayState() => EditorApplication.update += () => MainThreadPlayState = PlayState();
    }
}

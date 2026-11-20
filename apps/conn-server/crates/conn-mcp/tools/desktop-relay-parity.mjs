// The desktop tab relay on the T3 server (its own PreviewManager, PreviewAutomationBroker,
// DesktopTabRelay and preview MCP toolkits, in process) against the Conn Server
// (`examples/html_cases` with a desktop): one stand-in desktop registers a tab, answers each
// request with the case's reply, and records what it received. Compares the MCP results
// and the desktop's requests. No model, no browser.
import * as FS from "node:fs";
import * as Path from "node:path";
import * as OS from "node:os";
import * as Module from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { monorepo } from "../../../tools/monorepo.mjs";
import { sealedEnv } from "../../../tools/sealed-env.mjs";

const ENVIRONMENT = "html-parity";
const SESSION = "desktop-session";
const URL_ = "http://127.0.0.1:9/page";
const status = (url = URL_) => ({
  ok: true,
  result: {
    available: true,
    visible: true,
    tabId: "$desktop",
    url,
    title: "Desktop page",
    loading: false,
    control: { owner: "agent", ownedByCaller: true, generation: 1 },
    profiles: [],
  },
});
const SNAPSHOT = {
  url: URL_,
  title: "Desktop page",
  loading: false,
  accessibilityTree: '- button "Go" [ref=e1]',
  visibleText: "Go",
  interactiveElements: [],
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: { width: 1280, height: 800 },
};
const desktopConfig = { url: URL_, statusReply: status() };
const fail = (_tag, detail) => ({
  ok: false,
  error: { _tag, message: "remote", ...(detail === undefined ? {} : { detail }) },
});
const cases = [
  { tool: "preview_status", args: {} },
  { tool: "t3_preview_list", args: {} },
  {
    tool: "preview_snapshot",
    args: { tabId: "$desktop" },
    reply: { ok: true, result: SNAPSHOT },
  },
  {
    tool: "preview_snapshot",
    args: {},
    reply: { ok: true, result: SNAPSHOT },
  },
  { tool: "preview_act", args: { action: "click", selector: "#go" }, reply: { ok: true, result: { tabId: "$desktop" } } },
  { tool: "preview_evaluate", args: { expression: "1+1" }, reply: { ok: true, result: 2 } },
  { tool: "preview_act", args: { action: "type", locator: "nope=x", text: "a" }, reply: fail("PreviewAutomationInvalidSelectorError") },
  { tool: "preview_act", args: { action: "click", locator: "aria-ref=e1" }, reply: fail("PreviewAutomationInvalidSelectorError", { staleRef: true }) },
  { tool: "preview_act", args: { action: "type", text: "a" }, reply: fail("PreviewAutomationTargetNotEditableError", { selectorKind: "focused-element" }) },
  { tool: "preview_navigate", args: { url: "http://localhost:3000" }, reply: fail("PreviewAutomationControlInterruptedError", "humanControl") },
  { tool: "preview_wait_for", args: { text: "x", timeoutMs: 50 }, reply: fail("PreviewAutomationTimeoutError", { timeoutMs: 40, pendingStages: ["frames"] }) },
  { tool: "preview_resize", args: { mode: "fill" }, reply: fail("SomethingElse") },
  { tool: "preview_set_appearance", args: { colorScheme: "dark" }, reply: fail("PreviewAutomationUnavailableError") },
  { tool: "preview_dialog", args: { accept: true }, reply: { ok: false } },
  { tool: "preview_snapshot", args: {}, reply: fail("PreviewAutomationResultTooLargeError", { maximumBytes: 1024 }) },
  { tool: "preview_snapshot", args: { tabId: "$desktop", includeImage: true }, reply: fail("PreviewAutomationTabNotFoundError") },
  {
    tool: "preview_snapshot",
    args: { includeImage: true, save: true },
    reply: { ok: true, result: { ...SNAPSHOT, screenshot: { mimeType: "image/png", data: "", width: 0, height: 0 } } },
  },
  { tool: "preview_cdp_endpoint", args: {}, reply: { ok: true, result: { endpoint: "ws://127.0.0.1:9/devtools/page/x", tabId: "$desktop" } } },
  { tool: "preview_recording_start", args: {} },
  { tool: "preview_open", args: { tabId: "$desktop", url: "http://localhost:3001", open: false }, reply: status("http://localhost:3001/") },
  { tool: "preview_status", args: {} },
  { tool: "t3_preview_close", args: { tabId: "$desktop" } },
  { tool: "t3_preview_list", args: {} },
];

/** Puts the real desktop tab id where a case says `$desktop`. */
function bind(value, tab) {
  return JSON.parse(JSON.stringify(value ?? null).replaceAll('"$desktop"', JSON.stringify(tab)));
}

async function expected(root) {
  const repo = monorepo();
  const require = Module.createRequire(Path.join(repo, "apps/server/package.json"));
  const pkg = async (name) => import(pathToFileURL(require.resolve(name)).href);
  const src = async (name) => import(pathToFileURL(Path.join(repo, "apps/server/src", name)).href);
  const Effect = await pkg("effect/Effect"),
    Layer = await pkg("effect/Layer"),
    Deferred = await pkg("effect/Deferred"),
    Stream = await pkg("effect/Stream"),
    Option = await pkg("effect/Option"),
    Schema = await pkg("effect/Schema");
  const NodeServices = await pkg("@effect/platform-node/NodeServices"),
    NodeCrypto = await pkg("@effect/platform-node/NodeCrypto");
  const { McpServer, McpSchema } = await pkg("effect/ai");
  const [Config, Api, Invocation, ThreadKit, Threads, Browser, ServerBrowser, Manager, Broker, Desktop, Activity, Environment, Annotations, Projects, Autofill, Controls, ControlHandlers, Relay] =
    await Promise.all(
      [
        "config.ts",
        "mcp/McpHttpServer.ts",
        "mcp/McpInvocationContext.ts",
        "mcp/McpToolAccess.testkit.ts",
        "orchestration-v2/ThreadManagementService.ts",
        "preview/PreviewBrowser.ts",
        "preview/ServerBrowser.ts",
        "preview/Manager.ts",
        "mcp/PreviewAutomationBroker.ts",
        "preview/DesktopBrowserChannel.ts",
        "preview/PreviewAgentActivity.ts",
        "environment/ServerEnvironment.ts",
        "annotations/AnnotationStore.ts",
        "project/ProjectService.ts",
        "credentials/CredentialAutofill.ts",
        "mcp/toolkits/previewControls/tools.ts",
        "mcp/toolkits/previewControls/handlers.ts",
        "preview/DesktopTabRelay.ts",
      ].map(src),
    );
  const Sessions = await import(
    pathToFileURL(Path.join(repo, "packages/provider-core/src/server/McpProviderSessions.ts"))
  );
  const thread = "thread-desktop-parity";
  const ready = await Effect.runPromise(Deferred.make());
  const wrappedBroker = Layer.effect(
    Broker.PreviewAutomationBroker,
    Effect.gen(function* () {
      const original = yield* Broker.PreviewAutomationBroker;
      return {
        ...original,
        focusHost: (input) =>
          original.focusHost(input).pipe(Effect.tap(() => Deferred.succeed(ready, undefined))),
      };
    }),
  ).pipe(Layer.provideMerge(Broker.layer));
  const foundation = Layer.mergeAll(Config.layerTest(root, { prefix: "t3-desktop-" }), NodeCrypto.layer).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const deps = Layer.mergeAll(
    wrappedBroker,
    Manager.layer,
    Activity.layer,
    Desktop.layer,
    Sessions.layer,
    Annotations.layer.pipe(
      Layer.provide(Layer.mock(Projects.ProjectService)({ getById: (id) => Effect.succeedSome({ id }) })),
    ),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          ThreadKit.liveThreadShell(id, { runtimeMode: "full-access", interactionMode: "default" }),
        ),
    }),
    Layer.mock(Autofill.CredentialAutofill)({
      guardScript: () => Effect.void,
      isScriptLocked: () => Effect.succeed(false),
    }),
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(ENVIRONMENT),
      getDescriptor: Effect.die("unused descriptor"),
    }),
    Layer.succeed(Browser.PreviewBrowser, {
      installed: Effect.succeed(Option.none()),
      executable: Effect.die("This proof must not launch or install Chrome"),
    }),
  ).pipe(Layer.provideMerge(foundation));
  const registrations = Layer.mergeAll(
    Api.layerPreviewToolkit,
    Api.toolkitRegistration(Controls.PreviewControlsToolkit, ControlHandlers.layer),
    Relay.layer,
  ).pipe(
    Layer.provideMerge(ServerBrowser.layer.pipe(Layer.provideMerge(deps))),
    Layer.provideMerge(Api.layerInProcessMcpServer),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ServerBrowser.ServerBrowser;
        yield* Deferred.await(ready);
        const manager = yield* Manager.PreviewManager;
        const relay = yield* Relay.DesktopTabRelay;
        const snapshot = yield* manager.open({ threadId: thread, runtime: "desktop", url: URL_ });
        const tab = snapshot.tabId;
        const { connectionId } = yield* relay.register(SESSION, {
          environmentId: ENVIRONMENT,
          threadId: thread,
          tabId: tab,
          deviceName: "Parity Mac",
          snapshot,
        });
        let reply = null;
        const requests = [];
        yield* relay.requests(SESSION, connectionId).pipe(
          Stream.runForEach((event) => {
            if (event.type !== "request") return Effect.void;
            const request = event.request;
            requests.push(JSON.parse(JSON.stringify(request)));
            const canned = bind(request.operation === "status" ? desktopConfig.statusReply : reply, tab);
            return relay.respond(SESSION, {
              ...canned,
              clientId: "desktop",
              connectionId: event.connectionId,
              requestId: request.requestId,
            });
          }),
          Effect.forkScoped,
        );
        const mcp = yield* McpServer.McpServer;
        const replies = [];
        for (const c of cases) {
          reply = c.reply ?? null;
          const result = yield* mcp.callTool({ name: c.tool, arguments: bind(c.args, tab) }).pipe(
            Effect.provideService(Invocation.McpInvocationContext, {
              environmentId: ENVIRONMENT,
              capabilities: new Set(["orchestration", "preview"]),
              requestNamespace: ENVIRONMENT,
              thread: { threadId: thread, providerSessionId: "full-access", providerInstanceId: "codex" },
              issuedAt: 1,
            }),
            Effect.provideService(McpSchema.McpServerClient, {
              clientId: 1,
              protocolVersion: "2025-06-18",
              clientCapabilities: {},
              clientInfo: { name: "parity", version: "1" },
              initializePayload: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "parity", version: "1" },
              },
              getClient: Effect.die("unused client"),
            }),
            Effect.match({
              onSuccess: (r) => ({ result: Schema.encodeSync(McpSchema.CallToolResult)(r) }),
              onFailure: (e) => ({ error: { message: e.message } }),
            }),
          );
          replies.push(result);
        }
        return { replies, requests, thread, tab };
      }).pipe(Effect.provide(registrations)),
    ),
  );
}

function actual(binary, root) {
  const state = Path.join(root, "rust");
  FS.mkdirSync(state);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [state], { env: sealedEnv(Path.join(root, "rust-env")) });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(JSON.parse(stdout)) : reject(Error(`Rust desktop fixture: ${stderr}\n${stdout}`)),
    );
    // The fixture puts the tab id in for `$desktop`; `bind` there needs the same replies.
    child.stdin.end(
      JSON.stringify({
        desktop: { ...desktopConfig, statusReply: desktopConfig.statusReply },
        cases: cases.map((c) => ({ ...c, reply: c.reply ?? null })),
      }),
    );
  });
}

function normalize(run) {
  const names = [
    [run.thread, "<thread>"],
    [run.tab, "<desktop-tab>"],
  ];
  const transform = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => transform(x, ""));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, value] of Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) {
        if (["updatedAt", "createdAt", "serverEpoch", "revision", "requestId"].includes(k)) out[k] = `<${k}>`;
        else out[k] = transform(value, k);
      }
      return out;
    }
    if (typeof v === "string") {
      if (key === "text") {
        try {
          return JSON.stringify(transform(JSON.parse(v), ""));
        } catch {}
      }
      let text = v;
      for (const [from, to] of names) text = text.replaceAll(from, to);
      return text.replace(/desktop-[0-9a-f-]{36}/g, "desktop-<client>");
    }
    return v;
  };
  return transform({ replies: run.replies, requests: run.requests }, "");
}

export async function desktopRelayParity(binary) {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "conn-desktop-relay-parity-"));
  try {
    const want = normalize(await expected(root));
    const rust = await actual(binary, root);
    const got = normalize({ ...rust, replies: rust.replies.map((r) => (r.result ? { result: r.result } : { error: r.error })) });
    let failed = 0;
    cases.forEach((c, i) => {
      const [e, a] = [want.replies[i], got.replies[i]];
      const equal = JSON.stringify(e) === JSON.stringify(a);
      console.log(`${equal ? "ok  " : "DIFF"} desktop relay ${c.tool} ${i + 1}`);
      if (!equal) {
        failed++;
        console.error(JSON.stringify({ expected: e, got: a }).slice(0, 6000));
      }
    });
    const requestsEqual = JSON.stringify(want.requests) === JSON.stringify(got.requests);
    console.log(`${requestsEqual ? "ok  " : "DIFF"} desktop relay requests (${want.requests.length})`);
    if (!requestsEqual) {
      failed++;
      const count = Math.max(want.requests.length, got.requests.length);
      for (let i = 0; i < count; i++)
        if (JSON.stringify(want.requests[i]) !== JSON.stringify(got.requests[i]))
          console.error(`request ${i + 1}`, JSON.stringify({ expected: want.requests[i], got: got.requests[i] }));
    }
    if (failed) throw Error(`${failed} desktop relay parity cases differ`);
  } finally {
    FS.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await desktopRelayParity(Path.resolve(process.argv[2]));

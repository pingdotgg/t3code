// Actual T3 headless services and MCP registration against our MCP transport. No model calls.
import * as FS from "node:fs";
import * as Path from "node:path";
import * as OS from "node:os";
import * as Module from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as Http from "node:http";
import { monorepo } from "../../../tools/monorepo.mjs";
import { sealedEnv } from "../../../tools/sealed-env.mjs";
function validateMedia(result, tool) {
  for (const block of result.content ?? []) {
    if (block.type === "image") {
      const bytes = Buffer.from(block.data, "base64");
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw Error(`Invalid PNG from ${tool}`);
      const size = result.structuredContent?.screenshot;
      if (size && (bytes.readUInt32BE(16) !== size.width || bytes.readUInt32BE(20) !== size.height))
        throw Error("PNG metadata dimensions differ from its pixels");
    }
  }
  if (tool === "preview_recording_stop" && !result.isError && result.structuredContent?.path) {
    const recording = result.structuredContent;
    const file = FS.openSync(recording.path, "r");
    try {
      const header = Buffer.alloc(16);
      FS.readSync(file, header);
      if (
        FS.fstatSync(file).size !== recording.sizeBytes ||
        !header.subarray(4, 8).equals(Buffer.from("ftyp"))
      )
        throw Error("Recording is not a complete MP4");
    } finally {
      FS.closeSync(file);
    }
  }
}
export async function previewParity(binary, browser) {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "conn-preview-parity-"));
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
  const modules = await Promise.all(
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
    ].map(src),
  );
  const [
    Config,
    Api,
    Invocation,
    ThreadKit,
    Threads,
    Browser,
    ServerBrowser,
    Manager,
    Broker,
    Desktop,
    Activity,
    Environment,
    Annotations,
    Projects,
    Autofill,
    Controls,
    ControlHandlers,
  ] = modules;
  const Sessions = await import(
    pathToFileURL(Path.join(repo, "packages/provider-core/src/server/McpProviderSessions.ts"))
  );
  let fixture;
  let origin;
  if (browser) {
    fixture = Http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><html><head><title>Preview fixture</title></head><body><input type="file" id="file-a"><input type="file" id="file-b"><input id="name" aria-label="Name"><input type="password" value="fixture-hidden"><select id="choice"><option value="one">One</option><option value="two">Two</option></select><button onclick="document.querySelector('#result').textContent='Clicked'">Press me</button><button id="dialog" onclick="alert('Fixture dialog')">Dialog</button><p id="result">Ready</p><script>console.log('local fixture')</script></body></html>`,
      );
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${fixture.address().port}/`;
  }
  const cases = [
    { tool: "preview_status", args: {} },
    { tool: "t3_preview_list", args: {} },
    { tool: "preview_open", args: { profileId: "missing-profile", reuseExistingTab: false } },
    ...[
      "preview_open",
      "preview_navigate",
      "preview_resize",
      "preview_set_appearance",
      "preview_evaluate",
      "preview_dialog",
      "preview_cdp_endpoint",
      "preview_snapshot",
      "preview_act",
      "preview_wait_for",
      "preview_recording_start",
      "preview_recording_stop",
      "t3_preview_close",
    ]
      .map((tool) => ({
        tool,
        args:
          {
            preview_open: { tabId: "missing" },
            preview_navigate: { url: "http://localhost:3000" },
            preview_resize: { mode: "fill" },
            preview_set_appearance: { colorScheme: "dark" },
            preview_evaluate: { expression: "1+1" },
            preview_dialog: { accept: true },
            preview_act: { action: "click", x: 1, y: 1 },
            preview_wait_for: { text: "Ready" },
          }[tool] ?? {},
      }))
      .map((c) => (c.tool === "t3_preview_close" ? { ...c, args: { tabId: "missing" } } : c)),
    { tool: "html_preview", args: {} },
    { tool: "html_preview", args: { html: "<p>x</p>", path: "/missing.html" } },
    { tool: "html_preview", args: { html: "<style>body{height:100vh}</style>" } },
    { tool: "html_preview", args: { path: "/missing.html" }, supervised: true },
  ];
  if (browser) {
    FS.writeFileSync(Path.join(root, "upload-a.txt"), "first");
    FS.writeFileSync(Path.join(root, "upload-b.txt"), "second");
    cases.push(
      {
        tool: "html_preview",
        args: {
          html: '<!doctype html><style>body{margin:0;height:96px}</style><h1>Fixture</h1><script>console.log("fixture")</script>',
          width: 320,
        },
      },
      { tool: "preview_open", args: { url: origin, open: false } },
      { tool: "preview_act", args: { action: "upload", locator: "#file-a", paths: ["relative.txt"] } },
      { tool: "preview_act", args: { action: "upload", locator: "#file-a", paths: [Path.join(root, "upload-a.txt")] } },
      { tool: "preview_act", args: { action: "upload", locator: "#file-b", paths: [Path.join(root, "upload-b.txt")] } },
      { tool: "preview_evaluate", args: { expression: `({a:document.querySelector('#file-a').files[0]?.name,b:document.querySelector('#file-b').files[0]?.name,markers:document.querySelectorAll('[data-conn-upload=active]').length})` } },
      { tool: "preview_snapshot", args: {} },
      { tool: "preview_snapshot", args: { includeImage: true } },
      {
        tool: "preview_act",
        args: { action: "click", locator: "unknown-engine=anything" },
      },
      { tool: "preview_act", args: { action: "click", selector: "#missing", timeoutMs: 50 } },
      { tool: "preview_act", args: { action: "type", selector: "button", text: "wrong" } },
      { tool: "preview_dialog", args: { accept: true } },
      { tool: "preview_act", args: { action: "click", locator: 'role=button[name="Press me"]' } },
      {
        tool: "preview_act",
        args: { action: "type", selector: "#name", text: "Typed", clear: true },
      },
      { tool: "preview_act", args: { action: "select", selector: "#choice", values: ["Two"] } },
      {
        tool: "preview_evaluate",
        args: {
          expression:
            '({name:document.querySelector("#name").value,result:document.querySelector("#result").textContent,password:document.querySelector("[type=password]").value})',
        },
      },
      {
        tool: "preview_resize",
        args: { mode: "preset", preset: "iphone-se", orientation: "landscape" },
      },
      { tool: "preview_set_appearance", args: { colorScheme: "light" } },
      { tool: "preview_act", args: { action: "click", selector: "#dialog" } },
      { tool: "preview_status", args: {} },
      { tool: "preview_dialog", args: { accept: true } },
      { tool: "preview_wait_for", args: { text: "Clicked" } },
      { tool: "preview_wait_for", args: { text: "Never appears", timeoutMs: 1 } },
      { tool: "preview_evaluate", args: { expression: "new Promise(()=>{})", timeoutMs: 5 } },
      { tool: "preview_cdp_endpoint", args: {} },
      { tool: "preview_recording_start", args: {} },
      { tool: "preview_act", args: { action: "click", locator: 'role=button[name="Press me"]' } },
      { tool: "preview_recording_stop", args: {} },
      { tool: "t3_preview_close", args: { tabId: "$first" } },
      { tool: "preview_status", args: {} },
    );
  }
  try {
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
    const config = Config.layerTest(root, { prefix: "t3-preview-" });
    const foundation = Layer.mergeAll(config, NodeCrypto.layer).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    const deps = Layer.mergeAll(
      wrappedBroker,
      Manager.layer,
      Activity.layer,
      Desktop.layer,
      Sessions.layer,
      Annotations.layer.pipe(
        Layer.provide(
          Layer.mock(Projects.ProjectService)({ getById: (id) => Effect.succeedSome({ id }) }),
        ),
      ),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(
            ThreadKit.liveThreadShell(id, {
              runtimeMode: id.endsWith("supervised") ? "approval-required" : "full-access",
              interactionMode: "default",
            }),
          ),
      }),
      Layer.mock(Autofill.CredentialAutofill)({
        guardScript: () => Effect.void,
        isScriptLocked: () => Effect.succeed(false),
      }),
      Layer.succeed(Environment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed("preview-parity"),
        getDescriptor: Effect.die("unused descriptor"),
      }),
      Layer.succeed(Browser.PreviewBrowser, {
        installed: Effect.succeed(Option.none()),
        executable: browser
          ? Effect.succeed(browser)
          : Effect.die("This proof must not launch or install Chrome"),
      }),
    ).pipe(Layer.provideMerge(foundation));
    const registrations = Layer.mergeAll(
      Api.layerPreviewToolkit,
      Api.layerHtmlToolkit,
      Api.toolkitRegistration(Controls.PreviewControlsToolkit, ControlHandlers.layer),
    ).pipe(
      Layer.provideMerge(ServerBrowser.layer.pipe(Layer.provideMerge(deps))),
      Layer.provideMerge(Api.layerInProcessMcpServer),
    );
    const expected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ServerBrowser.ServerBrowser;
          yield* Deferred.await(ready);
          const mcp = yield* McpServer.McpServer;
          const answers = [];
          const tabs = [];
          for (const c of cases) {
            const args = structuredClone(c.args);
            if (args.tabId === "$first") args.tabId = tabs[0];
            const scope = {
              environmentId: "preview-parity",
              capabilities: new Set(["orchestration", "preview"]),
              requestNamespace: "preview-parity",
              thread: {
                threadId: c.supervised ? "thread-preview-supervised" : "thread-preview-parity",
                providerSessionId: "full-access",
                providerInstanceId: "codex",
              },
              issuedAt: 1,
            };
            const result = yield* mcp.callTool({ name: c.tool, arguments: args }).pipe(
              Effect.provideService(Invocation.McpInvocationContext, scope),
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
                onSuccess: (r) => Schema.encodeSync(McpSchema.CallToolResult)(r),
                onFailure: (e) => ({ rpcError: e.message }),
              }),
            );
            if (c.tool === "preview_open" && result.structuredContent?.tabId)
              tabs.push(result.structuredContent.tabId);
            validateMedia(result, c.tool);
            answers.push(result);
          }
          return answers;
        }).pipe(Effect.provide(registrations)),
      ),
    );
    const state = Path.join(root, "rust");
    FS.mkdirSync(state);
    const rust = await new Promise((resolve, reject) => {
      const child = spawn(binary, [state], {
        env: { ...sealedEnv(Path.join(root, "rust-env")), ...(browser ? { CONN_SERVER_BROWSER_PATH: browser } : {}) },
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 128 * 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("exit", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify(cases));
    });
    if (rust.status !== 0) throw Error(`Rust preview fixture: ${rust.stderr}\n${rust.stdout}`);
    if (browser && FS.existsSync(Path.join(state, "tools"))) throw Error("Configured Chrome used the runtime installation directory");
    const actual = JSON.parse(rust.stdout).map(
      (reply) => reply.result ?? { rpcError: reply.error?.message },
    );
    actual.forEach((result, i) => validateMedia(result, cases[i].tool));
    const normalize = (value) => {
      const transform = (v, key) => {
        if (Array.isArray(v)) return v.map((x) => transform(x, ""));
        if (v && typeof v === "object") {
          const result = {};
          for (const [k, value] of Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) {
            if (
              [
                "timestamp",
                "startedAt",
                "completedAt",
                "createdAt",
                "updatedAt",
                "serverEpoch",
                "revision",
                "path",
              ].includes(k)
            ) {
              result[k] = `<${k}>`;
              continue;
            }
            if (k === "sizeBytes") {
              if (!(value > 0)) throw Error("Empty recording");
              result[k] = "<positive bytes>";
              continue;
            }
            if (k === "id" && (/^[0-9a-f-]{36}$/.test(value) || v.mimeType?.startsWith("video/"))) {
              result[k] = "<id>";
              continue;
            }
            result[k] = transform(value, k);
          }
          return result;
        }
        if (typeof v === "string") {
          if (key === "data") return "<PNG>";
          if (key === "text") {
            try {
              return JSON.stringify(transform(JSON.parse(v), ""));
            } catch {}
          }
          return v
            .replace(/tab_([a-z0-9]+)(?:_[a-f0-9-]{36})?/g, "tab_$1")
            .replace(/t3-[a-zA-Z\d]+-(?:[a-z0-9]+-)?((?:f\d+)?e\d+)/g, "t3-generation-$1");
        }
        return v;
      };
      return transform(value, "");
    };
    let failed = 0;
    for (let i = 0; i < cases.length; i++) {
      const a = normalize(actual[i]),
        e = normalize(expected[i]);
      const equal = JSON.stringify(a) === JSON.stringify(e);
      console.log(`${equal ? "ok  " : "DIFF"} preview parity ${cases[i].tool} ${i + 1}`);
      if (!equal) {
        failed++;
        console.error(JSON.stringify({ expected: e, got: a }).slice(0, 8000));
      }
    }
    if (failed) throw Error(`${failed} preview parity cases differ`);
  } finally {
    fixture?.close();
    FS.rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await previewParity(
    Path.resolve(process.argv[2]),
    process.argv[3] && Path.resolve(process.argv[3]),
  );

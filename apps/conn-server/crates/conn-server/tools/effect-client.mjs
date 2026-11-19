// Drives a conn-server binary with Conn's client-runtime pairing and Effect's RpcClient.
// After `vp i` at the monorepo root: `node <this file> target/debug/conn-server`, or
// `node <this file> target/debug/examples/effect_fixture --fixture` for the ack window.
// With DECODE_COVERAGE=<file>, appends each tag whose answer decoded with the client's own
// decoders, for decode-coverage.mjs. Every folder it touches is a temp folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { importSource, packageImporter } from "../../../tools/monorepo.mjs";
import { gitEnv, sealedEnv } from "../../../tools/sealed-env.mjs";

// Packages resolve as packages/contracts sees them, so the sources share one `effect`.
const load = packageImporter("packages/contracts");
const source = importSource;

const DateTime = await load("effect/DateTime");
const Effect = await load("effect/Effect");
const Exit = await load("effect/Exit");
const Option = await load("effect/Option");
const Layer = await load("effect/Layer");
const Redacted = await load("effect/Redacted");
const Stream = await load("effect/Stream");
const { FetchHttpClient } = await load("effect/http");
const { RpcClient, RpcSchema, RpcSerialization } = await load("effect/rpc");
const Socket = await load("effect/socket/Socket");
const { WsRpcGroup } = await source("packages/contracts/src/rpc.ts");
const { joinSocketFrameParts } = await source("packages/shared/src/socketFrameParts.ts");
const { appendOrchestrationProtocol } = await source(
  "packages/client-runtime/src/connection/compatibility.ts",
);
const { fetchRemoteEnvironmentDescriptor } = await source(
  "packages/client-runtime/src/environment/descriptor.ts",
);
const { bootstrapRemoteBearerSession, fetchRemoteSessionState, issueRemoteWebSocketTicket } =
  await source("packages/client-runtime/src/authorization/remote.ts");

const [binary, mode] = process.argv.slice(2);
if (!binary) throw new Error("usage: effect-client.mjs <conn-server binary> [--fixture]");
const fixture = mode === "--fixture";

const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-server-effect-"));
// The Codex status probe runs here, on stub CLIs only: the default `codex` instance is off
// before the start, so this machine's `codex` never runs.
NodeFS.writeFileSync(
  NodePath.join(stateDir, "settings.json"),
  JSON.stringify({ providerInstances: { codex: { driver: "codex", enabled: false } } }),
);
const serverEnv = { ...sealedEnv(stateDir), CONN_CODEX_STATUS_PROBE: "on" };
const workflowScript = NodePath.join(serverEnv.HOME, ".claude", "projects", "effect-client.js");
NodeFS.mkdirSync(NodePath.dirname(workflowScript), { recursive: true });
NodeFS.writeFileSync(workflowScript, "// workflow script fixture\n");
const server = NodeChildProcess.spawn(
  binary,
  fixture ? [stateDir] : ["--listen", "127.0.0.1:0", "--state-dir", stateDir],
  { stdio: ["ignore", "pipe", "pipe"], env: serverEnv },
);
const stderr = [];
server.stderr.on("data", (data) => stderr.push(String(data)));
const pairingUrl = await new Promise((resolve, reject) => {
  let out = "";
  server.stdout.on("data", (data) => {
    out += data;
    const match = /pairingUrl: (\S+)/.exec(out);
    if (match) resolve(match[1]);
  });
  server.on("exit", (code) => reject(new Error(`server exited (${code}): ${stderr.join("")}`)));
});
const httpBaseUrl = new URL(pairingUrl).origin;
const credential = new URL(pairingUrl).hash.replace("#token=", "");

const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-server-effect-work-"));
const git = (cwd, ...args) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      stdio: "ignore",
      env: {
        ...gitEnv(),
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    },
  );
const repo = NodePath.join(NodeFS.realpathSync(work), "repo");
NodeFS.mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
NodeFS.writeFileSync(NodePath.join(repo, "a.txt"), "a\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");

const decodedTags = new Set();

const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const pairing = Effect.gen(function* () {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
  check("descriptor", descriptor.orchestrationProtocolVersion === 2, descriptor.environmentId);
  const access = yield* bootstrapRemoteBearerSession({ httpBaseUrl, credential });
  check("token exchange", access.token_type === "Bearer", `expires_in ${access.expires_in}`);
  const spent = yield* Effect.exit(bootstrapRemoteBearerSession({ httpBaseUrl, credential }));
  check("pairing code is single use", Exit.isFailure(spent));
  const session = yield* fetchRemoteSessionState({ httpBaseUrl, bearerToken: access.access_token });
  check(
    "session state",
    session.authenticated === true,
    `${session.permissions?.length} permissions`,
  );
  const ticket = yield* issueRemoteWebSocketTicket({
    httpBaseUrl,
    bearerToken: access.access_token,
    use: "rpc",
  });
  return { descriptor, ticket: Redacted.value(ticket.ticket) };
}).pipe(Effect.provide(FetchHttpClient.layer));

const { descriptor, ticket } = await Effect.runPromise(pairing);

const socketUrl = new URL(appendOrchestrationProtocol(`${httpBaseUrl.replace(/^http/, "ws")}/ws`));
socketUrl.searchParams.set("wsTicket", ticket);
socketUrl.searchParams.set("frameParts", "1");
const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Layer.effect(
      Socket.Socket,
      Effect.map(Effect.service(Socket.Socket), joinSocketFrameParts),
    ).pipe(Layer.provide(Socket.layerWebSocket(socketUrl.toString()))),
  ),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const take = (stream, n) => Stream.runCollect(Stream.take(stream, n));

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const probe = yield* client["server.probe"]({});
  check("unary server.probe", JSON.stringify(probe) === "{}", JSON.stringify(probe));
  decodedTags.add("server.probe");
  const missing = yield* Effect.exit(client["cloud.getRelayClientStatus"]({}));
  check("unsupported method fails", Exit.isFailure(missing), String(missing.cause).split("\n")[0]);

  const activity = yield* Effect.exit(
    client["server.reportClientActivity"]({
      clientId: "effect-client",
      clientKind: "web",
      visible: true,
      focused: true,
      recentlyInteracted: true,
      scopes: [],
      observedAt: DateTime.makeUnsafe(Date.now()),
    }),
  );
  check("server.reportClientActivity", Exit.isSuccess(activity), String(activity.cause ?? ""));
  if (Exit.isSuccess(activity)) decodedTags.add("server.reportClientActivity");

  if (fixture) {
    yield* decodeCall(client, "subscribePreviewEvents", {});
    yield* decodeCall(client, "panels.requests", {deviceName: "Fixture Mac"});
    const events = yield* take(client.subscribeServerConfig({}), 20);
    check("windowed stream: 20 chunks, window 8", events.length === 20, `${events.length} events`);
    // Stream.take interrupted the subscription; the fixture logs when the server drops it.
    yield* Effect.sleep("200 millis");
    check("interrupt reaches the handler", stderr.join("").includes("stream dropped"));
  } else {
    yield* decodeCall(client, "secrets.answerRequest", { threadId: "missing", turnItemId: "missing", answer: { type: "decline" } });
    yield* decodeCall(client, "panels.respond", { requestId: "unknown", ok: true });
    const login = yield* client["testLogins.save"]({ url: " http://localhost/login ", username: "tester", password: "fixture-only", otpSecret: " TEST " });
    decodedTags.add("testLogins.save");
    check("test login summary excludes secrets", login.createdBy === "user" && login.hasOtp && !("password" in login) && !("otpSecret" in login));
    yield* decodeCall(client, "testLogins.list", {});
    yield* decodeCall(client, "testLogins.update", { id: login.id, label: "Updated", otpSecret: null });
    const revealed = yield* client["testLogins.reveal"]({ id: login.id });
    decodedTags.add("testLogins.reveal");
    check("test login reveal preserves password and clears OTP", revealed.password === "fixture-only" && revealed.otpSecret === null);
    yield* decodeCall(client, "testLogins.remove", { id: login.id });
    yield* decodeCall(client, "testLogins.reveal", { id: login.id });

    const [config] = yield* take(client.subscribeServerConfig({}), 1);
    check(
      "subscribeServerConfig snapshot decodes",
      config.type === "snapshot" &&
        config.config.environment.environmentId === descriptor.environmentId,
      `${Object.keys(config.config.settings).length} settings keys`,
    );
    const lifecycle = yield* take(client.subscribeServerLifecycle({}), 2);
    check("subscribeServerLifecycle", lifecycle.map((e) => e.type).join(",") === "welcome,ready");
    const device = yield* take(client.subscribeDeviceState({}), 1);
    check("subscribeDeviceState", device[0].hostStatus === "disabled");
    const terminals = yield* take(client.subscribeTerminalMetadata({}), 1);
    check("subscribeTerminalMetadata", terminals[0].type === "snapshot");
    const clones = yield* take(client.subscribeProjectClones({}), 1);
    check("subscribeProjectClones", Array.isArray(clones[0]));
    for (const tag of [
      "subscribeServerConfig",
      "subscribeServerLifecycle",
      "subscribeDeviceState",
      "subscribeTerminalMetadata",
      "subscribeProjectClones",
    ]) {
      decodedTags.add(tag);
    }
    yield* decodeEach(client);
  }
}).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("90 seconds"));

/**
 * One call of a method with a valid payload. A value, a stream item, an ended stream or a
 * typed error decoded with the client's schema; a defect or a timeout did not.
 */
const STREAM_WAIT = "1500 millis";
function decodeCall(client, tag, payload) {
  return Effect.gen(function* () {
    const rpc = WsRpcGroup.requests.get(tag);
    const stream = RpcSchema.isStreamSchema(rpc.successSchema);
    const exit = stream
      ? yield* Effect.exit(Stream.runHead(client[tag](payload)).pipe(Effect.timeoutOption(STREAM_WAIT)))
      : yield* Effect.exit(client[tag](payload).pipe(Effect.timeout("10 seconds")));
    let kind;
    if (Exit.isSuccess(exit)) {
      kind = stream && Option.isNone(exit.value) ? "open, no item yet" : "decoded";
    } else {
      const fail = exit.cause.reasons.find((r) => r._tag === "Fail");
      const tagged = fail?.error?._tag;
      kind = tagged && tagged !== "TimeoutError" ? `typed error ${tagged}` : "BAD";
    }
    if (kind === "decoded" || kind.startsWith("typed error")) decodedTags.add(tag);
    check(`decode ${tag}`, kind !== "BAD", kind === "BAD" ? String(exit.cause).split("\n").slice(0, 6).join(" | ") : kind);
    return exit;
  });
}

/** A stub `grok` that answers the status probe as a healthy, signed-in CLI. */
function grokStub() {
  const dir = NodePath.join(work, "grok-stub");
  NodeFS.mkdirSync(dir, { recursive: true });
  const stub = NodePath.resolve(import.meta.dirname, "../../conn-provider-acp/tools/grok-cli-stub.mjs");
  const config = NodePath.join(dir, "config.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      log: NodePath.join(dir, "log.ndjson"),
      behaviour: {
        version: { code: 0, stdout: "grok 1.0.52\n" },
        models: [{ code: 0, stdout: "You are logged in with grok.com.\n  * grok-4.6 (default)\n" }],
        inspect: { code: 0, stdout: JSON.stringify({ skills: [] }) },
        agent: { mode: "ok", initialize: { protocolVersion: 1, _meta: { modelState: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }] } } } },
      },
    }),
  );
  const script = NodePath.join(dir, "grok");
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} --stub-config ${JSON.stringify(config)} "$@"\n`,
    { mode: 0o755 },
  );
  return script;
}

/** A stub `codex` that answers the status probe as Orbit's router setup (no sign-in). */
function codexStub() {
  const dir = NodePath.join(work, "codex-stub");
  NodeFS.mkdirSync(dir, { recursive: true });
  const stub = NodePath.resolve(import.meta.dirname, "../../conn-provider-codex/tools/probe-conformance/stub-codex.mjs");
  NodeFS.copyFileSync(stub, NodePath.join(dir, "stub-codex.mjs"));
  const model = {
    id: "gpt-6-luna", model: "gpt-6-luna", displayName: "gpt-6-luna", description: "", hidden: false, isDefault: true,
    defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }], serviceTiers: [{ id: "priority", name: "Fast", description: "" }],
  };
  NodeFS.writeFileSync(
    NodePath.join(dir, "behaviour.json"),
    JSON.stringify({
      account: { account: null, requiresOpenaiAuth: false },
      skills: { data: [{ cwd: "<cwd>", errors: [], skills: [{ name: "review", description: "Review code", enabled: true, path: "/skills/review/SKILL.md", scope: "user" }] }] },
      models: [{ data: [model], nextCursor: null }],
      config: { config: { model_provider: "orbit", model_providers: { orbit: { base_url: "http://router.orbit:8080/v1" } } }, origins: {} },
    }),
  );
  const script = NodePath.join(dir, "codex");
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(NodePath.join(dir, "stub-codex.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  return script;
}

/** Methods that no recording reaches: one call each, on temp folders. */
const decodeEach = (client) =>
  Effect.gen(function* () {
    const none = "effect-client-none";
    for (const [tag, extra] of [
      ["mcpApps.callTool", { name: "refresh", arguments: {} }],
      ["mcpApps.readResource", { uri: "ui://stub" }],
      ["mcpApps.toolInfo", { name: "refresh" }],
      ["mcpApps.updateModelContext", { conversationThreadId: "missing" }],
    ]) yield* decodeCall(client, tag, { threadId: "missing", itemId: "app", ...extra });
    const call = (tag, payload) => decodeCall(client, tag, payload);
    yield* call("projects.mutate", {
      type: "project.create",
      commandId: "effect-client-c1",
      projectId: "effect-client-p1",
      title: "Repo",
      workspaceRoot: repo,
    });
    yield* call("preview.list", {threadId:none});
    yield* call("preview.close", {threadId:none});
    yield* call("preview.resize", {threadId:none,tabId:"missing",viewport:{_tag:"fill"}});
    yield* call("preview.adjust", {threadId:none,tabId:"missing",colorScheme:"dark"});
    yield* call("preview.reportProfiles", {profiles:[],defaultProfileId:"default",recordingFrameRate:60});
    yield* call("preview.clearProfile", {profileId:"never-opened"});
    yield* call("preview.reportStatus", {threadId:none,tabId:"missing",navStatus:{_tag:"Idle"},canGoBack:false,canGoForward:false});
    yield* call("preview.open", {threadId:none,runtime:"server",url:"file:///refused"});
    yield* call("subscribePreviewEvents", {});
    yield* call("git.resolvePullRequest", { cwd: repo, reference: "42" });
    yield* call("git.preparePullRequestThread", { cwd: repo, reference: "42", mode: "worktree" });
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    NodeFS.writeFileSync(NodePath.join(repo, "commit-proof.txt"), "commit proof\n");
    const commitEvents = yield* Stream.runCollect(client["git.runStackedAction"]({ cwd: repo, actionId: "decode-commit", action: "commit", commitMessage: "Decode commit" }));
    const finishedCommit = commitEvents.find((event) => event.kind === "action_finished");
    check("git.runStackedAction commits and decodes final result", finishedCommit?.result.commit.status === "created");
    decodedTags.add("git.runStackedAction");
    // Scheduled tasks. `runNow` names a missing task: a run would start a real provider.
    const scheduled = yield* call("scheduledTasks.upsert", {
      commandId: "effect-client-task",
      title: "Nightly review",
      prompt: "Review the open pull requests.",
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      projectId: "effect-client-p1",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    const taskId = Exit.isSuccess(scheduled) ? scheduled.value.task.id : none;
    yield* call("scheduledTasks.subscribe", {});
    yield* call("scheduledTasks.setEnabled", { id: taskId, enabled: false });
    yield* call("scheduledTasks.runNow", { id: none });
    yield* call("scheduledTasks.delete", { id: taskId });
    // A webhook task, paused so no request starts a provider: one delivery to its URL is
    // logged as `disabled`, then the delivery methods read it and the token rotates.
    const hook = yield* call("scheduledTasks.upsert", {
      commandId: "effect-client-hook",
      title: "Review pull requests",
      prompt: "Review {{body.url}}",
      enabled: false,
      schedule: {
        type: "webhook",
        signature: { header: "x-signature", encoding: "hex", prefix: "sha256=", secret: "effect-client-secret" },
        dedupe: { replayKey: "{{headers.x-delivery}}" },
        filters: [{ path: "body.url", op: "exists" }],
      },
      projectId: "effect-client-p1",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    const hookTask = Exit.isSuccess(hook) ? hook.value.task : undefined;
    if (hookTask?.webhook) {
      const delivered = yield* Effect.promise(() =>
        fetch(`${httpBaseUrl}${hookTask.webhook.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.invalid/pull/1" }),
        }),
      );
      check("webhook delivery to a paused task", delivered.status === 409, `status ${delivered.status}`);
      // The route's own refusals, as webhookRoute.test.ts has them; none reaches a run.
      const url = `${httpBaseUrl}${hookTask.webhook.path}`;
      // The server answers 413 without reading the rest of an oversized body and closes the
      // connection, so a sender still writing may see the reset instead of the answer.
      const status = (path, init) =>
        Effect.promise(() =>
          fetch(path, init).then(
            (r) => ({ status: r.status, outcome: r.headers.get("x-t3-hook-outcome"), allow: r.headers.get("allow") }),
            (error) => ({ status: "reset", outcome: String(error?.cause?.code ?? error) }),
          ),
        );
      const refusedBig = (r) => (r.status === 413 && r.outcome === "body_too_large") || r.status === "reset";
      const head = yield* status(url, { method: "HEAD" });
      check("webhook HEAD probe", head.status === 405 && head.allow === "GET, POST, PUT, PATCH", JSON.stringify(head));
      const big = yield* status(url, { method: "POST", body: new Uint8Array(1024 * 1024 + 1) });
      check("webhook body over 1 MiB", refusedBig(big), JSON.stringify(big));
      const chunks = new ReadableStream({
        start(controller) {
          for (let sent = 0; sent <= 1024 * 1024; sent += 64 * 1024) controller.enqueue(new Uint8Array(64 * 1024));
          controller.close();
        },
      });
      const streamed = yield* status(url, { method: "POST", body: chunks, duplex: "half" });
      check("webhook chunked body over 1 MiB", refusedBig(streamed), JSON.stringify(streamed));
      const wrong = yield* status(`${url.slice(0, url.lastIndexOf("/"))}/wrong-token`, { method: "POST", body: "{}" });
      check("webhook wrong token", wrong.status === 404 && wrong.outcome === "not_found", JSON.stringify(wrong));
      for (const path of ["/api/hooks/id", "/api/hooks/id/tok/extra", "/api/hooks/%E0/tok"]) {
        const malformed = yield* status(`${httpBaseUrl}${path}`, { method: "POST", body: "{}" });
        check(`webhook malformed path ${path}`, malformed.status === 404, JSON.stringify(malformed));
      }
    }
    const hookId = hookTask?.id ?? none;
    const listed = yield* call("scheduledTasks.listWebhookDeliveries", { id: hookId, acceptAnyOutcome: true });
    const deliveryId = Exit.isSuccess(listed) ? (listed.value.deliveries[0]?.id ?? none) : none;
    yield* call("scheduledTasks.getWebhookDelivery", { id: hookId, deliveryId });
    yield* call("scheduledTasks.rotateWebhookToken", { id: hookId });
    yield* call("scheduledTasks.delete", { id: hookId });
    // Text generators: an unsaved config against a model API stub on loopback, and a missing
    // saved one (a typed error). No outside call.
    const modelApi = NodeHttp.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a", name: "Model A" }] }));
    });
    yield* Effect.promise(() => new Promise((resolve) => modelApi.listen(0, "127.0.0.1", resolve)));
    yield* call("server.listTextGeneratorModels", {
      id: "effect-client-tg",
      config: {
        kind: "openaiCompatible",
        baseUrl: `http://127.0.0.1:${modelApi.address().port}/v1`,
        apiKey: "effect-client-key",
        enabled: true,
      },
    });
    yield* call("server.listTextGeneratorModels", { id: none });
    yield* Effect.promise(() => new Promise((resolve) => modelApi.close(resolve)));
    // Annotations, in the project made above.
    yield* call("annotations.subscribe", { projectId: "effect-client-p1" });
    yield* call("annotations.create", {
      projectId: "effect-client-p1",
      annotation: { id: "effect-client-a1", comment: "Make the button bigger", source: "browser" },
    });
    yield* call("annotations.remove", { projectId: "effect-client-p1", ids: ["effect-client-a1"] });
    yield* call("projects.writeFile", { cwd: repo, relativePath: "b.txt", contents: "b\n" });
    yield* call("projects.listIgnoredFiles", { cwd: repo });
    yield* call("review.getDiffFileContents", {
      cwd: repo,
      sourceKind: "working-tree",
      changeType: "new",
      baseRef: null,
      headRef: null,
      oldPath: "b.txt",
      newPath: "b.txt",
    });
    yield* call("vcs.refreshBranch", { cwd: repo });
    yield* call("vcs.createRef", { cwd: repo, refName: "topic" });
    yield* call("vcs.switchRef", { cwd: repo, refName: "topic" });
    const worktree = yield* call("vcs.createWorktree", {
      cwd: repo,
      refName: "main",
      newRefName: "effect-client-wt",
      path: null,
    });
    const path = Exit.isSuccess(worktree) ? worktree.value.worktree.path : NodePath.join(work, "none");
    yield* call("vcs.removeWorktree", { cwd: repo, path, force: true });
    yield* call("vcs.pull", { cwd: repo });
    const fresh = NodePath.join(work, "fresh");
    NodeFS.mkdirSync(fresh);
    yield* call("vcs.init", { cwd: fresh });
    yield* call("worktreeSetup.cancel", { threadId: none });
    yield* call("filesystem.browse", { partialPath: `${repo}/` });
    yield* call("filesystem.getMetadata", { paths: [repo] });
    yield* call("assets.persistChatAttachments", { threadId: none, messageId: none, attachments: [] });
    const htmlId = "effect-html-00000000-0000-4000-8000-000000000001-html";
    NodeFS.writeFileSync(NodePath.join(stateDir, "attachments", `${htmlId}.html`), "<!doctype html><p>Rendered HTML</p>");
    const htmlAsset = yield* call("assets.createUrl", { resource: { _tag: "attachment", attachmentId: htmlId, fileName: "Rendered HTML.html", mimeType: "text/html", disposition: "inline" } });
    if (Exit.isSuccess(htmlAsset)) {
      const served = yield* Effect.promise(async () => {
        const response = await fetch(`${httpBaseUrl}${htmlAsset.value.relativeUrl}`);
        return { status: response.status, type: response.headers.get("content-type"), csp: response.headers.get("content-security-policy"), body: await response.text() };
      });
      check("HTML render signed asset", served.status === 200 && served.type === "text/html; charset=utf-8" && served.csp === "sandbox allow-scripts allow-forms allow-popups allow-downloads" && served.body === "<!doctype html><p>Rendered HTML</p>", JSON.stringify(served));
    } else check("HTML render signed asset URL", false, String(htmlAsset.cause));
    yield* call("attachments.delete", { attachmentId: none });
    yield* call("server.restart", {});
    yield* call("orchestration.getWorkflowScript", { threadId: none, scriptPath: "relative.js" });
    const script = yield* call("orchestration.getWorkflowScript", { threadId: none, scriptPath: ` ${workflowScript} ` });
    check("workflow script contents", Exit.isSuccess(script) && script.value.contents === "// workflow script fixture\n" && script.value.truncated === false);
    yield* call("orchestration.stopWorkflow", { threadId: none, subagentId: none });
    yield* call("orchestration.forceStopThread", { threadId: none });
    yield* call("orchestration.getNativeChildWork", { threadId: none });
    yield* call("orchestration.getThreadFamily", { threadId: none });
    // Checkpoint diffs: an empty range answers, an unknown thread is a typed error.
    yield* call("orchestration.getFullThreadDiff", { threadId: none, toTurnCount: 0 });
    yield* call("orchestration.getTurnDiff", { threadId: none, fromTurnCount: 0, toTurnCount: 1 });
    yield* call("orchestration.getThreadLinkMetadata", { threadIds: [none] });
    yield* call("orchestration.getThreadTitles", { threadIds: [none] });
    yield* call("orchestration.getWorktreeThreadIds", { worktreePath: repo });
    yield* call("orchestration.searchThread", { threadId: none, query: "x" });
    yield* call("orchestration.searchThreadStream", { threadId: none, query: "x" });
    yield* call("orchestration.subscribeCommandOutput", { threadId: none, itemId: none });
    yield* call("orchestration.subscribePromptSuggestion", { threadId: none });
    yield* call("projects.createFromThread", { threadId: none });
    yield* call("projects.createNew", { name: "effect-client" });
    yield* call("projects.ensureScratch", {});
    // Sign-in: T3's ProviderSetupError for CLI-owned instances (provider-auth-diff.mjs).
    yield* call("provider.auth.subscribe", { instanceId: "codex" });
    yield* call("provider.auth.start", { instanceId: "codex" });
    yield* call("provider.auth.respond", { instanceId: "codex", flowId: "f", interactionId: "i", response: { type: "browser", action: "decline" } });
    yield* call("provider.auth.complete", { instanceId: "codex", flowId: "f", callbackUrl: "http://localhost/cb" });
    yield* call("provider.auth.cancel", { instanceId: "codex", flowId: "f" });
    yield* call("provider.auth.removeMethod", { instanceId: "codex", methodId: "chatgpt" });
    yield* call("provider.auth.logout", { instanceId: "codex" });
    yield* call("provider.install.subscribe", { instanceId: "codex" });
    yield* call("server.getConfig", {});
    // Grok, switched on with a stub CLI (crates/conn-provider-acp/tools/grok-cli-stub.mjs; no
    // real CLI runs): the server probes it as T3 does, and the entry decodes as "ready".
    yield* call("server.updateSettings", {
      patch: {},
      providerInstanceMutation: {
        operation: "create",
        instanceId: "grok",
        instance: { driver: "grok", enabled: true, config: { binaryPath: grokStub() } },
      },
    });
    const grok = yield* call("server.refreshProviders", { instanceId: "grok" });
    const grokEntry = Exit.isSuccess(grok) ? grok.value.providers.find((p) => p.instanceId === "grok") : undefined;
    check(
      "Grok entry from the probe",
      grokEntry?.status === "ready" && grokEntry.models.some((m) => m.slug === "grok-4.6"),
      `${grokEntry?.status} ${grokEntry?.message ?? ""}`,
    );
    // A second Claude instance (Orbit's effort instances) and the default Codex switched
    // off, added while the server runs: the real client decodes both entries.
    yield* call("server.updateSettings", {
      patch: {},
      providerInstanceMutation: {
        operation: "create",
        instanceId: "claudeLow",
        instance: {
          driver: "claudeAgent",
          displayName: "Claude Low",
          accentColor: "#336699",
          config: { binaryPath: "/nonexistent/claude" },
          environment: [{ name: "CONN_EFFECT_CLIENT", value: "1", sensitive: false }],
        },
      },
    });
    yield* call("server.updateSettings", {
      patch: {},
      providerInstanceMutation: { operation: "upsert", instanceId: "codex", instance: { driver: "codex", enabled: false } },
    });
    const instances = yield* call("server.refreshProviders", {});
    const instanceEntries = Exit.isSuccess(instances) ? instances.value.providers : [];
    const low = instanceEntries.find((p) => p.instanceId === "claudeLow");
    check(
      "a second Claude instance is listed with its identity",
      low?.driver === "claudeAgent" && low.displayName === "Claude Low" && low.accentColor === "#336699",
      JSON.stringify(low ?? null).slice(0, 200),
    );
    const codexEntry = instanceEntries.find((p) => p.instanceId === "codex");
    check(
      "a disabled Codex instance is listed disabled",
      codexEntry?.enabled === false && codexEntry.status === "disabled",
      JSON.stringify(codexEntry ?? null).slice(0, 200),
    );
    // Codex instances probed as T3 probes them (stub-codex.mjs; no real CLI runs): one ready
    // through Orbit's router, one whose binary is missing (listed with T3's error entry).
    yield* call("server.updateSettings", {
      patch: {},
      providerInstanceMutation: {
        operation: "create",
        instanceId: "codexRouter",
        instance: { driver: "codex", displayName: "Codex Router", config: { binaryPath: codexStub(), customModels: ["my-model"] } },
      },
    });
    yield* call("server.updateSettings", {
      patch: {},
      providerInstanceMutation: {
        operation: "create",
        instanceId: "codexMissing",
        instance: { driver: "codex", config: { binaryPath: "/nonexistent/codex" } },
      },
    });
    const probed = yield* call("server.refreshProviders", {});
    const probedEntries = Exit.isSuccess(probed) ? probed.value.providers : [];
    const router = probedEntries.find((p) => p.instanceId === "codexRouter");
    check(
      "Codex entry from the probe",
      router?.status === "ready" &&
        router.displayName === "Codex Router" &&
        router.models.some((m) => m.slug === "gpt-6-luna" && m.isDefault === true) &&
        router.models.some((m) => m.slug === "my-model" && m.isCustom === true) &&
        router.skills.some((s) => s.name === "review") &&
        router.auth.endpoint === "http://router.orbit:8080",
      `${router?.status} ${router?.message ?? ""}`,
    );
    const missing = probedEntries.find((p) => p.instanceId === "codexMissing");
    check(
      "a Codex instance with a missing binary is listed with an error",
      missing?.status === "error" && missing.installed === false && (missing.message ?? "").startsWith("Could not start Codex CLI"),
      JSON.stringify(missing ?? null).slice(0, 200),
    );
    yield* call("server.getHostResources", {});
    yield* call("server.getProcessDiagnostics", {});
    yield* call("server.upsertKeybinding", { key: "mod+shift+f12", command: "sidebar.toggle" });
    yield* call("server.removeKeybinding", { key: "mod+shift+f12", command: "sidebar.toggle" });
    // The server refuses to signal itself; nothing is signalled.
    yield* call("server.signalProcess", { pid: server.pid, startTimeMs: 0, signal: "SIGINT" });
    // The server never starts an editor; it answers that the command is missing.
    yield* call("shell.openInEditor", { cwd: repo, editor: "vscode" });
    yield* call("terminal.clear", { threadId: none, terminalId: "default" });
    yield* call("terminal.observe", { threadId: none, terminalId: "default" });
    const prRef = { projectId: none, host: "github.com", repository: "a/b", number: 7 };
    for (const tag of ["pullRequests.summary", "pullRequests.detail", "pullRequests.preview", "pullRequests.routing", "pullRequests.checks", "pullRequests.activity", "pullRequests.filesViewed", "pullRequests.changeBreakdown", "pullRequests.linkedThreads"]) {
      yield* call(tag, prRef);
    }
    yield* call("pullRequests.routingIdentity", { host: "github.com" });
    yield* call("pullRequests.list", { state: "open" });
    yield* call("pullRequests.listStats", { refs: [prRef] });
    yield* call("pullRequests.filterOptions", { kind: "labels" });
    yield* call("pullRequests.threadComments", { ...prRef, threadId: "review-thread", cursor: "next-comments" });
    yield* call("pullRequests.diffFileContents", { ...prRef, changeType: "change", oldPath: "a.txt", newPath: "a.txt" });
    yield* call("pullRequests.setFilesViewed", { ...prRef, files: [{ path: "a.txt", viewed: true }] });
    yield* call("pullRequests.comment", { ...prRef, body: "Comment" });
    yield* call("pullRequests.replyToThread", { ...prRef, threadId: "review-thread", body: "Reply" });
    yield* call("pullRequests.updateComment", { ...prRef, commentId: "comment", kind: "issue-comment", body: "Edited" });
    yield* call("pullRequests.setReaction", { ...prRef, content: "heart", reacted: true });
    yield* call("pullRequests.setThreadResolution", { ...prRef, threadId: "review-thread", resolved: false });
    yield* call("pullRequests.submitReview", { ...prRef, verdict: "approve", body: "", comments: [] });
    yield* call("pullRequests.requestReviewers", { ...prRef, reviewers: [{ id: "reader", kind: "user" }], requested: true });
    yield* call("pullRequests.reviewerCandidates", prRef);
    yield* call("pullRequests.labelCandidates", prRef);
    yield* call("pullRequests.setLabels", { ...prRef, labels: ["bug"], applied: true });
    yield* call("pullRequests.update", { ...prRef, body: "Edited" });
    yield* call("pullRequests.runAction", { ...prRef, action: "close" });
    yield* call("pullRequests.generateReviewGuide", prRef);
    yield* call("pullRequests.stack", prRef);
    yield* call("pullRequests.reviewGuide", prRef);
    yield* call("pullRequests.reportState", { reference: prRef, state: "open" });
    yield* call("pullRequests.invalidate", { reference: prRef });
    yield* call("pullRequests.subscribeRefreshes", {});
    yield* call("pullRequests.subscribeLinkedThreadRefreshes", {});
    // Source control: GitHub probed, with no login or token of this machine (sealedEnv).
    yield* call("server.discoverSourceControl", {});
    // As a T3 server without an app client id: typed refusals, signed-out, not starred.
    const signIn = { provider: "github", host: "github.com" };
    yield* call("sourceControl.signInStart", signIn);
    yield* call("sourceControl.signInWait", signIn);
    yield* call("sourceControl.signInCancel", signIn);
    const repository = { ...signIn, repository: "pingdotgg/t3code" };
    yield* call("sourceControl.appAccess", repository);
    yield* call("sourceControl.starred", repository);
    yield* call("sourceControl.star", { ...repository, provider: "unknown" });
    // Unknown providers are refused before any request; a clone copies the local repository.
    yield* call("sourceControl.lookupRepository", { provider: "unknown", repository: "o/r" });
    yield* call("sourceControl.cloneRepository", {
      remoteUrl: repo,
      destinationPath: NodePath.join(work, "effect-client-clone"),
    });
    yield* call("sourceControl.publishRepository", {
      cwd: repo,
      provider: "unknown",
      repository: "no-workspace",
      visibility: "private",
    });
  });

const result = await Effect.runPromiseExit(program);
if (Exit.isFailure(result)) check("rpc session", false, String(result.cause));
server.kill("SIGTERM");
await new Promise((r) => (server.exitCode === null ? server.once("exit", r) : r()));
NodeFS.rmSync(stateDir, { recursive: true, force: true });
NodeFS.rmSync(work, { recursive: true, force: true });
if (process.env.DECODE_COVERAGE) {
  NodeFS.appendFileSync(process.env.DECODE_COVERAGE, [...decodedTags].map((t) => `${t}\n`).join(""));
}

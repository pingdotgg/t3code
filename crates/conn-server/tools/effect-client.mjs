// Drives a conn-server binary with Conn's client-runtime pairing and Effect's RpcClient.
// With CONN_MONOREPO set (after `vp i` there): `node <this file> target/debug/conn-server`, or
// `node <this file> target/debug/examples/effect_fixture --fixture` for the ack window.
// With DECODE_COVERAGE=<file>, appends each tag whose answer decoded with the client's own
// decoders, for decode-coverage.mjs. Every folder it touches is a temp folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { importSource, packageImporter } from "../../../tools/monorepo.mjs";

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
const server = NodeChildProcess.spawn(
  binary,
  fixture ? [stateDir] : ["--listen", "127.0.0.1:0", "--state-dir", stateDir],
  { stdio: ["ignore", "pipe", "pipe"] },
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
        ...process.env,
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
    const events = yield* take(client.subscribeServerConfig({}), 20);
    check("windowed stream: 20 chunks, window 8", events.length === 20, `${events.length} events`);
    // Stream.take interrupted the subscription; the fixture logs when the server drops it.
    yield* Effect.sleep("200 millis");
    check("interrupt reaches the handler", stderr.join("").includes("stream dropped"));
  } else {
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

/** Methods that no recording reaches: one call each, on temp folders. */
const decodeEach = (client) =>
  Effect.gen(function* () {
    const none = "effect-client-none";
    const call = (tag, payload) => decodeCall(client, tag, payload);
    yield* call("projects.mutate", {
      type: "project.create",
      commandId: "effect-client-c1",
      projectId: "effect-client-p1",
      title: "Repo",
      workspaceRoot: repo,
    });
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
    yield* call("attachments.delete", { attachmentId: none });
    yield* call("orchestration.forceStopThread", { threadId: none });
    yield* call("orchestration.getNativeChildWork", { threadId: none });
    yield* call("orchestration.getThreadFamily", { threadId: none });
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
    yield* call("provider.auth.subscribe", { instanceId: "codex" });
    yield* call("provider.install.subscribe", { instanceId: "codex" });
    yield* call("server.getConfig", {});
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
    yield* call("panels.requests", {});
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

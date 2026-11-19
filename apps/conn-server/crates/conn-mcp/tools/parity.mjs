#!/usr/bin/env node
// Same calls on the T3 server and the Conn Server (`examples/replay_server`), on throwaway
// state; compares outcome, failure code and result shape. By default no model is called:
// the thread launch and every step on its thread are skipped. `--model` runs them too, with
// one Haiku turn on the T3 server. `--no-model` is accepted and is the default.
// Usage: parity.mjs [--model] [--record-tools-list <file>] <conn-server-binary>. Needs `vp i`
// in the monorepo. `--record-tools-list` also writes the T3 server's `tools/list` reply to
// <file>: after a pin bump, refresh `fixtures/ts-tools-list.json` with it (docs/upkeep.md).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { previewParity } from "./preview-parity.mjs";
import { htmlParity } from "./html-parity.mjs";
import { toolOutputParity } from "./tool-output-parity.mjs";
import { checkMcpApps } from "./mcp-apps-parity.mjs";
import { McpSession, oauthMcpToken, pairBearer } from "./mcp-client.mjs";
import { claudeStub, tsCredential, rustCredential, fileText, projectProviderPolicy, updateSettings } from "./handoff-fixture.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";
import { canaryEnv, gitEnv, sealedEnv, sealedPath } from "../../../tools/sealed-env.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

const argv = process.argv.slice(2);
const noModel = !argv.includes("--model");
const recordAt = argv.indexOf("--record-tools-list");
const recordFile = recordAt === -1 ? undefined : argv[recordAt + 1];
if (recordAt !== -1 && (recordFile === undefined || recordFile.startsWith("--"))) {
  console.error("--record-tools-list needs a file");
  process.exit(2);
}
const rustBinary = argv.find((a, i) => !a.startsWith("--") && (recordAt === -1 || i !== recordAt + 1));
if (rustBinary === undefined) {
  console.error("usage: parity.mjs [--model] <conn-server-binary>");
  process.exit(2);
}
monorepo();
await checkMcpApps(NodePath.join(NodePath.dirname(rustBinary), "mcp_apps"));
const implemented = NodeFS.readFileSync(new URL("../tools.implemented", import.meta.url), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-mcp-parity-")));
const children = [];
process.once("exit", () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  NodeFS.rmSync(root, { recursive: true, force: true });
});

function scratchProject(name) {
  const dir = NodePath.join(root, name, "parity");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir, env: gitEnv() });
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir, env: gitEnv() },
  );
  return dir;
}

/** Starts a server, resolves with its origin and startup pairing code. */
function start(command, args, options, port) {
  const child = NodeChildProcess.spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`${command}: no pairing code in 90 s`)),
      90_000,
    );
    const onData = (data) => {
      out += data;
      const match = out.match(/pair#token=([A-Za-z0-9]+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ origin: `http://127.0.0.1:${port}`, code: match[1] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`${command} exited ${code}`)));
  });
}

const freePort = () =>
  new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function startTs() {
  const project = scratchProject("ts");
  const base = NodePath.join(root, "ts", "base");
  NodeFS.mkdirSync(base);
  const tsHome = NodePath.join(root, "ts", "home");
  NodeFS.mkdirSync(tsHome);
  // The T3 server fetches model-manifest.json from GitHub while this is on (its default).
  NodeFS.mkdirSync(NodePath.join(base, "userdata"));
  const stub = noModel ? claudeStub(NodePath.join(root,"ts")) : undefined;
  NodeFS.writeFileSync(
    NodePath.join(base, "userdata", "settings.json"),
    JSON.stringify({ enableProviderUpdateChecks: false,
      ...(stub === undefined ? {} : {providerInstances:{claudeAgent:{driver:"claudeAgent",enabled:true,config:{binaryPath:stub.binary}}}}),
    }),
  );
  const port = await freePort();
  const node = process.execPath;
  const tsPath = [
    NodePath.dirname(node),
    ...(noModel ? [] : [NodePath.join(NodeOS.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]),
    "/usr/bin",
    "/bin",
  ];
  // Without --model, no provider or host CLI is on the T3 server's PATH, so its provider and
  // source control probes can start none of this machine's (they find nothing, as on a host
  // without them). A folder that holds one (a CI image's /usr/bin has gh) is replaced
  // by links to the rest (`sealedPath`).
  const tsPathText = noModel ? sealedPath(NodePath.join(root, "ts"), tsPath.join(":")) : tsPath.join(":");
  const { origin, code } = await start(
    node,
    [
      GUARD_ARG,
      NodePath.join(monorepo(), "apps/server/src/bin.ts"),
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--base-dir",
      base,
      project,
    ],
    {
      cwd: project,
      env: {
        // Without --model, a throwaway HOME and no folder of user tools on PATH: the T3
        // server's provider probes then find no CLI, login or setting of this machine.
        // `--model` runs one real Haiku turn, which needs the real `claude` and its login.
        HOME: noModel ? tsHome : NodeOS.homedir(), // canary: allow (--model only)
        USER: NodeOS.userInfo().username,
        PATH: tsPathText,
        T3CODE_HOME: base,
        T3CODE_NO_BROWSER: "1",
        SHELL: "/bin/sh",
        ...canaryEnv(),
      },
    },
    port,
  );
  const bearer = await pairBearer(origin, code);
  return {
    bearer,
    records: stub?.records,
    name: "T3 server",
    origin,
    authorization: `Bearer ${await oauthMcpToken(origin, bearer)}`,
  };
}

async function startRust() {
  const project = scratchProject("rust");
  const port = await freePort();
  const state = NodePath.join(root, "rust", "state");
  NodeFS.mkdirSync(state,{recursive:true});
  const capture = NodePath.join(state,"mcp-capture.json");
  const { origin, code } = await start(
    rustBinary,
    ["--listen", `127.0.0.1:${port}`, "--state-dir", state, "--project", project],
    { env: {...sealedEnv(NodePath.join(root, "rust")), REPLAY_MCP_CAPTURE:capture} },
    port,
  );
  const bearer = await pairBearer(origin,code);
  return { name: "Conn Server", capture, origin, bearer, authorization: `Bearer ${bearer}` };
}

/** A value's shape: types, object keys, the first array item's shape. */
function shape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? ["…"] : [shape(value[0])];
  if (typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape(value[key])]),
    );
  return typeof value;
}

/** Paths where two shapes differ; `null` and an empty array match anything. */
function differences(a, b, path = "") {
  if (a === "null" || b === "null") return [];
  if (Array.isArray(a) && Array.isArray(b))
    return a[0] === "…" || b[0] === "…" ? [] : differences(a[0], b[0], `${path}[]`);
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) out.push(`${path}.${key}: only the T3 server sends it`);
      else if (!(key in b)) out.push(`${path}.${key}: only the Conn Server sends it`);
      else out.push(...differences(a[key], b[key], `${path}.${key}`));
    }
    return out;
  }
  return JSON.stringify(a) === JSON.stringify(b)
    ? []
    : [`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
}

/** JSON with object keys sorted: key order carries no meaning. */
function canonical(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

function outcome(reply) {
  if (reply.error !== undefined)
    return { kind: "rpc-error", code: reply.error.code, message: reply.error.message };
  if (reply.result.isError) {
    const text = reply.result.content?.[0]?.text ?? "";
    try {
      const failure = JSON.parse(text);
      return { kind: "failure", code: failure.code, message: failure.message };
    } catch {
      return { kind: "failure", code: text };
    }
  }
  return { kind: "ok", value: reply.result.structuredContent };
}

const htmlBinary = [
  NodePath.join(NodePath.dirname(rustBinary), "html_cases"),
  NodePath.join(NodePath.dirname(rustBinary), "examples", "html_cases"),
].find((file) => NodeFS.existsSync(file));
if (htmlBinary === undefined) throw new Error("Build the conn-mcp html_cases example first.");
await htmlParity(htmlBinary);
await previewParity(htmlBinary);
await toolOutputParity(NodePath.join(NodePath.dirname(htmlBinary), "tool_output_cases"));

const servers = await Promise.all([startTs(), startRust()]);
const sessions = servers.map((server) => new McpSession(server.origin, server.authorization));
for (const session of sessions) await session.initialize();

// Known, with the owner who closes them.
const ACCEPTED = new Set([
  // Optional in the contract; the descriptor (server track, environment.rs) does not detect it.
  ".platform.machine: only the T3 server sends it",
]);

let failed = 0;
const report = (line, ok) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "DIFF"} ${line}`);
};

// tools/list: the implemented tools' definitions must be equal.
const lists = await Promise.all(sessions.map((s) => s.request("tools/list", {})));
if (recordFile !== undefined) {
  NodeFS.writeFileSync(recordFile, `${JSON.stringify(lists[0], null, 2)}\n`);
  console.log(`wrote the T3 server's tools/list (${lists[0].result.tools.length} tools) to ${recordFile}`);
}
// This session is an outside client: tools that act as the calling thread must be missing on
// both servers, and exactly those (src/outside-hidden.txt).
const outsideHidden = new Set(
  NodeFS.readFileSync(new URL("../src/outside-hidden.txt", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line !== ""),
);
for (const name of implemented) {
  const [ts, rust] = lists.map((list) => list.result.tools.find((tool) => tool.name === name));
  if (outsideHidden.has(name)) {
    report(`tools/list ${name}: hidden from outside clients`, ts === undefined && rust === undefined);
    continue;
  }
  report(`tools/list ${name}`, ts !== undefined && JSON.stringify(ts) === JSON.stringify(rust));
}

/**
 * The provider both servers run: the T3 server lists every driver it has, the Conn Server only
 * Claude here, so the shapes compare that entry and the values its models.
 */
const claudeOnly = (value) => ({
  ...value,
  providers: value.providers.filter((p) => p.providerInstanceId === "claudeAgent"),
});
const claudeModels = (value) =>
  value.providers
    .filter((p) => p.providerInstanceId === "claudeAgent")
    .map((p) => ({ models: p.models, omittedModels: p.omittedModels ?? 0 }));

/** What a search found, in order: ids differ between servers, titles and sources do not. */
const searchOrder = (value) => value.matches.map((match) => [match.title, match.source]);

// With no `gh` on PATH, T3's credential lookup ends as "not signed in" (cli-unauthenticated);
// conn-source-control reports the missing CLI (cli-missing). Both refuse the watch with their
// GitHub requirement text. The PR panel answers the same way; it is not this slice's code.
const NO_GH = {
  why: "no gh: T3 says cli-unauthenticated, Conn says cli-missing",
  match: (result) =>
    result.kind === "failure" &&
    [
      "GitHub has no working credential for this host. Run `gh auth login`, or check the account and hosts in Settings → Source control & issues.",
      "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI (https://cli.github.com/) and run `gh auth login`.",
    ].includes(result.code),
};

// Per-server state the calls refer to: project and thread ids differ.
const context = [{}, {}];
const steps = [
  ["t3_workflow_stop", () => ({ threadId: "thread:none", subagentId: "workflow:none" })],
  ["t3_workflow_stop", () => ({ threadId: " ", subagentId: "workflow:none" })],
  ["tool_search", () => ({ query: "t3_workflow_stop" })],
  ["mcp_call", () => ({ tool: "weather", arguments: {} })],
  ["mcp_connect", () => ({ name: "stub", url: "http://127.0.0.1:1/mcp" })],
  ["mcp_connect", () => ({ name: "stub" })],
  [
    "t3_project_list",
    () => ({}),
    (c, v) => (c.projectId = v.projects.find((p) => p.title === "parity")?.id ?? v.projects[0].id),
  ],
  ["t3_project_read", (c) => ({ projectId: c.projectId })],
  ["t3_environment_read", () => ({})],
  ["orchestrator_capabilities", () => ({}), undefined, { view: claudeOnly, same: claudeModels }],
  [
    "orchestrator_capabilities",
    () => ({ search: "haiku 4.5" }),
    undefined,
    { view: claudeOnly, same: claudeModels },
  ],
  ["t3_thread_list", () => ({ allProjects: true })],
  ["t3_thread_list", () => ({})],
  // T3 #30976: a limit above the maximum is clamped, not refused.
  ["t3_thread_list", () => ({ allProjects: true, limit: 200 })],
  ["t3_project_list", () => ({ limit: 200 })],
  // A worktree thread without a message starts no turn, so it runs without --model too.
  [
    "t3_thread_launch",
    (c) => ({
      projectId: c.projectId,
      title: "Parity worktree",
      modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD", branch: "parity/worktree" },
      clientRequestId: "parity-worktree",
    }),
    (c, v) => (c.idleThreadId = v.threadId),
    { noTurn: true },
  ],
  [
    "t3_workflow_stop",
    (c) => ({ threadId: c.idleThreadId, subagentId: "workflow:none" }),
    undefined,
    { noTurn: true },
  ],
  ["t3_worktree_list", (c) => ({threadId:c.idleThreadId, refKind:"local"})],
  ["t3_worktree_list", () => ({threadId:"thread:none"})],
  ["t3_worktree_list", () => ({})],
  ["t3_worktree_status", () => ({})],
  ["t3_worktree_handoff", () => ({branch:"parity/hidden"})],
  ["create_threads", () => ({threads:[{title:"Hidden"}]})],
  ["t3_attachment_prepare_upload", () => ({upload:{type:"file",name:"note.txt",mimeType:"text/plain",sizeBytes:3}}), async (c,v,server) => {
    c.upload = v;
    const uploaded = await fetch(`${server.origin}${v.relativeUrl}`,{method:"POST",body:"abc"});
    if (!uploaded.ok) throw new Error(`fixture upload: ${uploaded.status} ${await uploaded.text()}`);
  }],
  ["t3_attachment_discard", (c) => ({attachmentId:c.upload?.attachmentId ?? "pending-00000000-0000-4000-8000-000000000001-txt"})],
  ["t3_attachment_discard", (c) => ({attachmentId:c.upload?.attachmentId ?? "pending-00000000-0000-4000-8000-000000000001-txt"})],
  ["t3_thread_send_attachments", (c) => ({threadId:c.idleThreadId,attachments:[{type:"file",id:"other-00000000-0000-4000-8000-000000000001-txt",name:"note.txt",mimeType:"text/plain",sizeBytes:3}]})],
  // t3_thread_organize on the idle worktree thread: every action, then the refusals.
  ...[
    "pin",
    "unpin",
    "settle",
    "unsettle",
    "mark_unread",
    "archive",
    "unarchive",
    "unsnooze",
  ].map((action) => ["t3_thread_organize", (c) => ({ threadId: c.idleThreadId, action })]),
  [
    "t3_thread_organize",
    (c) => ({ threadId: c.idleThreadId, action: "snooze", snoozedUntil: "2099-01-01T00:00:00.000Z" }),
  ],
  ["t3_thread_organize", (c) => ({ threadId: c.idleThreadId, action: "unsnooze" })],
  ["t3_thread_organize", (c) => ({ threadId: c.idleThreadId, action: "snooze" })],
  [
    "t3_thread_organize",
    (c) => ({ threadId: c.idleThreadId, action: "snooze", snoozedUntil: "2001-01-01T00:00:00.000Z" }),
  ],
  [
    "t3_thread_organize",
    (c) => ({ threadId: c.idleThreadId, action: "snooze", snoozedUntil: "not a date" }),
  ],
  ["t3_thread_organize", () => ({ action: "pin" })],
  ["t3_thread_organize", () => ({ threadId: "thread:none", action: "pin" })],
  ["t3_thread_organize", (c) => ({ threadId: c.idleThreadId, action: "bogus" })],
  // t3_queue on the idle thread: an empty queue, then each write on a run that is not queued.
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "list" })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "list", cursor: 5, limit: 1 })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "list", limit: 200 })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "read" })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "read", queuedRunId: "run:none" })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "cancel" })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "cancel", queuedRunId: "run:none" })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "edit", queuedRunId: "run:none" })],
  [
    "t3_queue",
    (c) => ({ threadId: c.idleThreadId, action: "edit", queuedRunId: "run:none", text: "x" }),
  ],
  [
    "t3_queue",
    (c) => ({ threadId: c.idleThreadId, action: "reorder", queuedRunId: "run:none", beforeRunId: null }),
  ],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "reorder", queuedRunId: "run:none" })],
  [
    "t3_queue",
    (c) => ({ threadId: c.idleThreadId, action: "promote_to_steer", queuedRunId: "run:none" }),
  ],
  [
    "t3_queue",
    (c) => ({
      threadId: c.idleThreadId,
      action: "promote_to_steer",
      queuedRunId: "run:none",
      targetRunId: "run:none",
    }),
  ],
  ["t3_queue", () => ({ threadId: "thread:none", action: "list" })],
  ["t3_queue", () => ({ action: "list" })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "list", limit: 0 })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "list", cursor: -1 })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "list", limit: 1.5 })],
  ["t3_queue", (c) => ({ threadId: c.idleThreadId, action: "list", limit: "2" })],
  ["t3_queue", () => ({ threadId: 5, action: "list" })],
  ["t3_queue", () => ({ action: 5 })],
  // Pull request links on the idle thread: values compared, not only shapes.
  ...[
    (c) => ({ threadId: c.idleThreadId, url: "https://github.com/O/R/pull/4" }),
    (c) => ({ threadId: c.idleThreadId, url: "https://github.com/o/r/pull/4" }),
    (c) => ({ threadId: c.idleThreadId, repository: "O/R", number: 3, host: "GitHub.com" }),
    (c) => ({ threadId: c.idleThreadId, url: "https://github.example:8443/a/b/pull/7" }),
  ].map((input) => ["link_pull_request", input, undefined, { same: (v) => v }]),
  ...[
    (c) => ({ threadId: c.idleThreadId, url: "https://example.com/team/x" }),
    (c) => ({ threadId: c.idleThreadId, repository: "o/r" }),
    (c) => ({ threadId: c.idleThreadId, repository: "o/r", number: 1 }),
    (c) => ({ threadId: c.idleThreadId, repository: "o/r", number: 1, host: "git.example" }),
    () => ({ url: "https://github.com/o/r/pull/1" }),
    () => ({ threadId: "thread:none", url: "https://github.com/o/r/pull/1" }),
  ].map((input) => ["link_pull_request", input]),
  [
    "link_pull_requests",
    (c) => ({
      threadId: c.idleThreadId,
      urls: [
        "https://github.com/o/r/pull/5",
        "https://GitHub.com/O/R/pull/5",
        "https://github.com/o/r/pull/3",
        "not a url",
        // Match input and key order: the servers can assign different millisecond ties.
        "https://github.com/z/s/pull/2",
      ],
    }),
    undefined,
    { same: (v) => v },
  ],
  // Batch links can tie on one server's millisecond clock but not the other's; unit tests
  // check list order with fixed linkedAt values.
  ["list_thread_pull_requests", (c) => ({ threadId: c.idleThreadId }), undefined, {
    same: (v) => ({ ...v, pullRequests: v.pullRequests.toSorted((a, b) => canonical(a).localeCompare(canonical(b))) }),
  }],
  [
    "list_thread_pull_requests",
    (c) => ({ threadId: c.idleThreadId, states: ["merged"] }),
    undefined,
    { same: (v) => v },
  ],
  ...[
    (c) => ({ threadId: c.idleThreadId, url: "https://github.com/o/r/pull/3" }),
    (c) => ({ threadId: c.idleThreadId, url: "https://github.com/o/r/pull/3" }),
    (c) => ({ threadId: c.idleThreadId, repository: "o/r", number: 5, host: "github.com" }),
  ].map((input) => ["unlink_pull_request", input, undefined, { same: (v) => v }]),
  [
    "unlink_pull_requests",
    (c) => ({ threadId: c.idleThreadId, states: ["open", "closed"] }),
    undefined,
    { same: (v) => v },
  ],
  ["list_thread_pull_requests", (c) => ({ threadId: c.idleThreadId }), undefined, { same: (v) => v }],
  ["list_thread_pull_requests", () => ({ threadId: "thread:none" })],
  ["list_thread_pull_requests", () => ({})],
  ["unlink_pull_requests", (c) => ({ threadId: c.idleThreadId, states: ["bogus"] })],
  ["unlink_pull_requests", (c) => ({ threadId: c.idleThreadId, states: ["open", 5] })],
  ["unlink_pull_requests", (c) => ({ threadId: c.idleThreadId, states: [] })],
  ["link_pull_requests", (c) => ({ threadId: c.idleThreadId, urls: [] })],
  // Pull request watches and guides. No `gh` is on either server's PATH, so each host read
  // takes the same "no credential" path; values and failure texts are compared.
  ...[
    (c) => ({ threadId: c.idleThreadId, url: "https://github.com/o/r/pull/9" }),
    (c) => ({ threadId: c.idleThreadId, url: "https://github.com/o/r/pull/3" }),
  ].map((input) => ["unwatch_pull_request", input, undefined, { same: (v) => v }]),
  ...[
    (c) => ({ threadId: c.idleThreadId, url: "https://github.com/o/r/pull/9" }),
    (c) => ({ threadId: c.idleThreadId, repository: "o/r", number: 9, host: "github.com" }),
    (c) => ({ threadId: c.idleThreadId, url: "https://example.com/team/x" }),
    (c) => ({ threadId: c.idleThreadId, repository: "o/r", number: 1 }),
    () => ({ url: "https://github.com/o/r/pull/9" }),
    () => ({ threadId: "thread:none", url: "https://github.com/o/r/pull/9" }),
    () => ({ threadId: "thread:none" }),
  ].flatMap((input) => [
    ["watch_pull_request", input, undefined, { same: (v) => v, known: NO_GH }],
    ["unwatch_pull_request", input, undefined, { same: (v) => v }],
  ]),
  ["list_thread_pull_requests", (c) => ({ threadId: c.idleThreadId }), undefined, {
    same: (v) => v.pullRequests.map((p) => [p.number, p.watching]).toSorted(),
  }],
  ...[
    { url: "https://github.com/o/r/pull/9" },
    { repository: "o/r", number: 9, host: "github.com" },
    { url: "https://example.com/team/x" },
    { repository: "o/r" },
    { repository: "o/r", number: 9 },
  ].map((input) => ["read_pull_request_guide", () => input, undefined, { same: (v) => v }]),
  ["send_to_user", () => ({ message: 5 })],
  ["t3_thread_wait", () => ({ threadId: true })],
  ["t3_thread_list", () => ({ allProjects: "yes" })],
  ["t3_thread_list", () => ({ statuses: "running" })],
  ["t3_thread_configure", () => ({ modelSelection: "x" })],
  ["t3_thread_read", () => ({ threadId: "thread:none", view: 5 })],
  ["t3_thread_read", () => ({ threadId: "thread:none", view: "bogus" })],
  // t3_thread_configure: read, then set the model on the same provider instance.
  ["t3_thread_configure", (c) => ({ threadId: c.idleThreadId })],
  [
    "t3_thread_configure",
    (c) => ({
      threadId: c.idleThreadId,
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    }),
  ],
  ["t3_thread_configure", (c) => ({ threadId: c.idleThreadId })],
  ["t3_thread_configure", () => ({ threadId: "thread:none" })],
  ["t3_thread_configure", () => ({})],
  // Scheduled tasks, as an outside client: reads, then each refusal before a task is saved.
  ["list_scheduled_tasks", () => ({})],
  ["list_scheduled_tasks", (c) => ({ projectId: c.projectId })],
  ...[
    (c) => ({ projectId: c.projectId, prompt: "Check progress", schedule: { type: "interval", everyMs: 3_600_000 } }),
    (c) => ({ projectId: c.projectId }),
    () => ({ prompt: "p", schedule: { type: "interval", everyMs: 3_600_000 } }),
    (c) => ({ projectId: c.projectId, prompt: "p", schedule: { type: "interval", everyMs: 3_600_000 }, bindToCurrentThread: true }),
    () => ({ projectId: "project:none", prompt: "p", schedule: { type: "interval", everyMs: 3_600_000 } }),
    () => ({ scheduledTaskId: "scheduled-task:none", enabled: false }),
    (c) => ({ projectId: c.projectId, prompt: "p", schedule: { type: "interval", everyMs: 5 } }),
    (c) => ({ projectId: c.projectId, prompt: "p", schedule: { type: "fixed_time", timeOfDay: "25:00" } }),
    (c) => ({ projectId: c.projectId, prompt: "p", schedule: "daily" }),
  ].map((input) => ["schedule_task", input]),
  ["delete_scheduled_task", () => ({ scheduledTaskId: "scheduled-task:none" })],
  ["delete_scheduled_task", () => ({})],
  ["run_scheduled_task_now", () => ({ taskId: "scheduled-task:none" })],
  ["run_scheduled_task_now", () => ({})],
  // Annotations act as the calling thread: an outside client is refused after the arguments.
  ["annotations_list", () => ({})],
  ["annotations_claim", () => ({})],
  ["annotations_claim", () => ({ id: "../x" })],
  ["annotations_complete", () => ({ id: "a", summary: "Done" })],
  ["annotations_complete", () => ({ id: "a" })],
  ["annotations_release", () => ({ id: "a", question: true })],
  ["annotations_release", () => ({ id: "" })],
  [
    "t3_thread_launch",
    (c) => ({
      projectId: c.projectId,
      title: "Parity",
      modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      clientRequestId: "parity-1",
    }),
    (c, v) => (c.threadId = v.threadId),
  ],
  ["t3_thread_wait", (c) => ({ threadId: c.threadId, timeoutMs: 1000 })],
  ["t3_thread_interrupt", (c) => ({ threadId: c.threadId })],
  ["t3_pending_request", (c) => ({ action: "list", threadId: c.threadId })],
  [
    "t3_thread_update",
    (c) => ({ threadId: c.threadId, action: "rename", title: "Parity renamed" }),
  ],
  [
    "t3_thread_send",
    (c) => ({
      threadId: c.threadId,
      message: "Reply with the single word OK.",
      mode: "queue",
      clientRequestId: "parity-2",
    }),
    (c, v) => (c.runId = v.runId),
  ],
  ["t3_thread_wait", (c) => ({ threadId: c.threadId, runId: c.runId, timeoutMs: 120_000 })],
  [
    "t3_thread_read",
    (c) => ({ threadId: c.threadId, view: "activity", afterPosition: -1, limit: 100 }),
  ],
  ["t3_thread_read", (c) => ({ threadId: c.threadId })],
  ["t3_thread_search", () => ({ query: "Parity renamed" })],
  ...[{ query: "Parity worktree" }, { query: "parity", limit: 1 }, { query: "nothing matches this" }].map(
    (input) => ["t3_thread_search", () => input, undefined, { same: searchOrder }],
  ),
  ["t3_thread_search", () => ({ query: " a " })],
  ["t3_thread_search", () => ({ query: "q".repeat(201) })],
  ["t3_thread_read", () => ({ threadId: "thread:none" })],
  ["t3_thread_list", () => ({ bogus: 1 })],
  ["delegate_task", () => ({ task: "x" })],
  ["task_status", () => ({ taskId: "task:none" })],
  ["task_cancel", () => ({ taskId: "task:none" })],
  // send_to_user acts as the calling thread; its argument check runs first.
  ["panel_open", () => ({ panel: "files" })],
  ["panel_open", () => ({ panel: "browser", url: "https://example.com" })],
  ["save_test_login", () => ({url:"http://example.test",username:"tester",password:"fixture-only"})],
  ["request_credentials", () => ({domain:"example.test"})],
  ["database_query", () => ({sql:"select 1"})],
  ["request_secret", () => ({ label: "Fixture key", reason: "Parity check" })],
  ["request_secret", () => ({ label: "Fixture key", reason: "Parity check", delivery: "file", value: "test-only" })],
  ["send_to_user", () => ({ message: "hi" })],
  ["send_to_user", () => ({ message: "" })],
  ["send_to_user", () => ({ message: "x".repeat(4001) })],
  // t3_background_wait acts as the calling thread; its argument check runs first, and the
  // decode messages are compared.
  ["t3_background_wait", () => ({ taskIds: ["bg-1"] })],
  ["t3_background_wait", () => ({ taskIds: [" bg-1 ", "x"], waiting: false })],
  ["t3_background_wait", () => ({ taskIds: [] })],
  ["t3_background_wait", () => ({ taskIds: Array.from({ length: 21 }, (_, i) => `t${i}`) })],
  ["t3_background_wait", () => ({ taskIds: ["bg-1", " "] })],
  ["t3_background_wait", () => ({ taskIds: [""] })],
  ["t3_background_wait", () => ({ taskIds: ["bg-1", 5] })],
  ["t3_background_wait", () => ({ taskIds: "bg-1" })],
  ["t3_background_wait", () => ({ taskIds: ["bg-1"], waiting: "yes" })],
  ["t3_background_wait", () => ({ waiting: true })],
];
// The steps that launch a thread (a model turn on the T3 server) or act on it.
const onLaunchedThread = (tool, input, options) =>
  options?.noTurn !== true &&
  (tool === "t3_thread_launch" || input({ threadId: "<t>" }).threadId === "<t>");
const run = noModel
  ? steps.filter(([tool, input, , options]) => !onLaunchedThread(tool, input, options))
  : steps;
if (noModel) console.log(`no model: skipped ${steps.length - run.length} steps on a launched thread`);
for (const [tool, input, after, options] of run) {
  const results = await Promise.all(
    sessions.map(async (session, i) => {
      const reply = await session.callTool(tool, input(context[i]));
      const result = outcome(reply);
      if (result.kind === "ok" && after !== undefined) await after(context[i], result.value, servers[i]);
      return result;
    }),
  );
  const [ts, rust] = results;
  const label = `${tool} ${JSON.stringify(input({ projectId: "<p>", threadId: "<t>", runId: "<r>" }))}`;
  if (ts.kind !== rust.kind || ts.code !== rust.code) {
    if (options?.known !== undefined && options.known.match(ts) && options.known.match(rust)) {
      report(`${label}: KNOWN ${options.known.why}`, true);
      continue;
    }
    report(
      `${label}: T3 ${ts.kind} ${ts.code ?? ""} / Conn ${rust.kind} ${rust.code ?? ""}`,
      false,
    );
    continue;
  }
  if (ts.kind === "rpc-error") {
    report(
      `${label}: both ${ts.code}${ts.message === rust.message ? ", same message" : `\n       T3:   ${ts.message}\n       Conn: ${rust.message}`}`,
      ts.message === rust.message,
    );
    continue;
  }
  if (ts.kind === "failure") {
    report(
      `${label}: both fail with ${ts.code}`,
      tool !== "t3_workflow_stop" || ts.message === rust.message,
    );
    continue;
  }
  const view = options?.view ?? ((value) => value);
  const diff = differences(shape(view(rust.value)), shape(view(ts.value))).filter(
    (d) => !ACCEPTED.has(d),
  );
  if (options?.same !== undefined) {
    const [a, b] = [options.same(ts.value), options.same(rust.value)].map(canonical);
    if (a !== b) diff.push(`values differ: T3 ${a} / Conn ${b}`);
  }
  report(
    `${label}${diff.length === 0 ? "" : `\n       ${diff.join("\n       ")}`}`,
    diff.length === 0,
  );
}
if (noModel) {
  const setupScript = {
        id:"parity-setup",name:"Parity setup",icon:"play",runOnWorktreeCreate:true,
        command: String.raw`printf '%s\n%s\n' "$T3CODE_PROJECT_ROOT" "$T3CODE_WORKTREE_PATH" > handoff-setup.txt`,
      };
  await Promise.all(servers.map(async (server,i) => {
    const response = await fetch(`${server.origin}/api/projects/mutate`,{
      method:"POST",headers:{authorization:`Bearer ${server.bearer}`,"content-type":"application/json"},
      body:JSON.stringify({type:"project.update",commandId:"parity-setup-script",projectId:context[i].projectId,scripts:[setupScript]}),
    });
    if (!response.ok) throw new Error(`fixture project scripts ${response.status}: ${await response.text()}`);
  }));
  // Keep a stale tracking ref after deleting the remote branch. Handoff must use the local
  // base and report startedFromOrigin:false, as T3's scoped fetch does.
  for (const side of ["ts","rust"]) {
    const project = NodePath.join(root,side,"parity");
    const remote = NodePath.join(root,side,"origin.git");
    const git = (cwd,...args) => NodeChildProcess.execFileSync("git",args,{cwd,env:gitEnv(),stdio:["ignore","pipe","pipe"]}).toString().trim();
    git(project,"clone","--bare",project,remote);
    git(project,"remote","add","origin",remote);
    git(project,"fetch","--no-tags","origin");
    const branch=git(project,"symbolic-ref","--short","HEAD");
    git(remote,"update-ref","-d",`refs/heads/${branch}`);
  }
  const launched = await Promise.all(sessions.map((session,i) => session.callTool("t3_thread_launch",{
    projectId:context[i].projectId,title:"Handoff parent",message:"hang",
    modelSelection:{instanceId:"claudeAgent",model:"claude-haiku-5-5"},runtimeMode:"auto",
    workspaceStrategy:{type:"root"},clientRequestId:"handoff-parent",
  }).then(outcome)));
  if (launched.some((r) => r.kind !== "ok")) throw new Error(`fixture parent launch: ${JSON.stringify(launched)}`);
  const credentials = await Promise.all([tsCredential(servers[0].records),rustCredential(servers[1].capture)]);
  const agents = credentials.map((entry) => new McpSession(new URL(entry.url).origin,entry.headers.Authorization));
  await Promise.all(agents.map((agent) => agent.initialize()));
  await Promise.all(servers.map((server) => updateSettings(server,{enableAgentBrowserAccess:false})));
  const retained = await Promise.all(agents.map((agent) => agent.callTool("request_credentials",{domain:"not a host"}).then(outcome)));
  report("browser access captured at session start",retained.every((r) => r.kind === "ok"));
  await Promise.all(servers.map((server) => updateSettings(server,{enableAgentBrowserAccess:true})));
  const state = [{},{}];
  const agentSteps = [
    ["save_test_login", () => ({url:" https://www.example.test/login ",username:" tester ",password:"fixture-only",label:" Tester ",otpSecret:" TEST "}), (v) => ({...v,id:"<id>",createdAt:"<time>"}), (c,v) => {c.loginId=v.id;}],
    ["request_credentials", () => ({domain:"http://example.test:8080/login"}), (v) => ({items:v.items.map(item=>({...item,id:"<id>"}))})],
    ["request_credentials", () => ({domain:"example.test/login?next=https://example.test"}), (v) => ({items:v.items.map(item=>({...item,id:"<id>"}))})],
    ["request_credentials", () => ({domain:"other.example.test"})],
    ["request_credentials", () => ({domain:"\ufeffexample.test"})],
    ["request_credentials", () => ({domain:"\u0085example.test"})],
    ["request_credentials", () => ({domain:"not a host"})],
    ["request_credentials", () => ({domain:" "})],
    ["save_test_login", () => ({url:"example.test",username:"",password:"fixture-only"})],
    ["database_query", () => ({sql:"select 1"})],
    ["database_query", () => ({sql:" "})],
    ...[
      ["mcp_call",{tool:" "}], ["mcp_call",{tool:"x".repeat(201)}],
      ["mcp_call",{tool:" weather ",server:" stub "}], ["mcp_call",{tool:"\uFEFFweather\n",server:null}],
      ["mcp_call",{tool:"x".repeat(200)}], ["mcp_call",{tool:"🌦".repeat(101)}],
      ["mcp_call",{tool:"weather",server:" "}], ["mcp_connect",{url:" "}],
      ["mcp_connect",{command:"x".repeat(8193)}], ["mcp_connect",{url:"x".repeat(8192)}],
      ["mcp_connect",{name:"x".repeat(201),url:"http://localhost"}],
      ["mcp_connect",{url:"http://localhost",headers:{key:"x".repeat(8193)}}],
      ["mcp_connect",{command:"node",env:{key:7}}],
      ["mcp_connect",{command:" node ",env:{key:"  raw  "}}],
      ["mcp_call",{tool:"weather",arguments:{}}],
      ["mcp_connect",{name:"stub",url:"http://127.0.0.1:1/mcp"}],
      ["mcp_connect",{name:"stub"}],
      ["mcp_connect",{url:"http://localhost",command:"node"}],
      ["mcp_connect",{command:"node",headers:{key:"value"}}],
      ["mcp_connect",{url:"http://localhost",env:{key:"value"}}],
    ].map(([tool,args]) => [tool,() => args]),
    ["t3_worktree_status", () => ({}), (v) => ({...v,projectWorkspaceRoot:"<project>"})],
    ["create_threads", () => ({threads:[{title:"Batch one"},{}],clientRequestId:"handoff-batch"}), (v) => v.threads.map((t) => ({title:t.title,status:t.status,createdBy:t.createdBy,creationSource:t.creationSource,providerInstanceId:t.providerInstanceId,model:t.model})), (c,v) => {c.targetThreadId=v.threads[0].threadId;}],
    ["create_threads", () => ({threads:[{title:"Batch one"},{}],clientRequestId:"handoff-batch"}), (v) => v.threads.map((t) => ({title:t.title,status:t.status}))],
    ...[0,1].map(() => ["create_threads", () => ({threads:[{prompt:"hang"}],clientRequestId:"prompt-retry"}), (v) => ({hasRun:v.threads[0].runId !== null}), (c,v) => {
      const run = v.threads[0].runId;
      if (c.promptRun !== undefined && c.promptRun !== run) throw new Error("A prompted retry created another run");
      c.promptRun = run;
    }]),
    ["create_threads", () => ({threads:[{title:null}]}), (v) => ({title:v.threads[0].title,model:v.threads[0].model,status:v.threads[0].status})],
    ["create_threads", () => ({threads:[{target:{providerInstanceId:null}}]}), (v) => ({title:v.threads[0].title,model:v.threads[0].model,status:v.threads[0].status})],
    ["t3_worktree_list", () => ({threadId:" "})],
    ["t3_worktree_list", () => ({query:"x".repeat(257)})],
    ["create_threads", () => ({threads:[{runtimeMode:"full-access"}]})],
    ["create_threads", () => ({threads:[]})],
    ["create_threads", () => ({threads:[{title:"   "}]})],
    ["create_threads", () => ({threads:[{prompt:"x".repeat(120001)}]})],
    ["create_threads", () => ({threads:[{target:{providerInstanceId:"missing"}}]})],
    ["create_threads", () => ({threads:[{target:{driverKind:"parity-missing"}}]})],
    ["create_threads", () => ({threads:[{target:{options:[{id:"effort",value:"bad"}]}}]})],
    ["t3_worktree_handoff", () => ({branch:"   "})],
    ["t3_attachment_prepare_upload", () => ({upload:{name:"shot.png",mimeType:"image/png",sizeBytes:0}})],
    ["t3_attachment_prepare_upload", () => ({upload:{type:"file",name:"note.txt",mimeType:"text/plain",sizeBytes:3}}), () => "prepared", async (c,v,server) => {
      c.attachment={type:"file",id:v.attachmentId,name:"note.txt",mimeType:"text/plain",sizeBytes:3};
      const response = await fetch(`${server.origin}${v.relativeUrl}`,{method:"POST",body:"abc"});
      if (!response.ok) throw new Error(`agent fixture upload ${response.status}`);
    }],
    ["t3_thread_send_attachments", (c) => ({threadId:c.targetThreadId,attachments:[c.attachment,c.attachment]})],
    ["t3_thread_send_attachments", (c) => ({threadId:c.targetThreadId,attachments:[0,1].map((n) => ({type:"file",id:`pending-00000000-0000-4000-8000-${String(n).padStart(12,"0")}-png`,name:"large.png",mimeType:"image/png",sizeBytes:50*1024*1024}))})],
    ["t3_thread_send_attachments", (c) => ({threadId:c.targetThreadId,attachments:[c.attachment],message:"hang"}), (v) => ({status:v.status})],
    ["t3_worktree_handoff", () => ({branch:"parity/handoff",startFromOrigin:true,continuationPrompt:"hang"}), (v) => ({...v,worktreePath:"<worktree>"}), (c,v) => {c.worktreePath=v.worktreePath;}],
    ["t3_worktree_status", () => ({}), (v) => ({...v,worktreePath:v.worktreePath === null ? null : "<worktree>",projectWorkspaceRoot:"<project>"})],
  ];
  for (const [tool,input,normalize = (v) => v,after] of agentSteps) {
    if (tool === "t3_worktree_handoff" && input({}).branch === "parity/handoff") {
      // Handoff replaces the provider session, so exercise its credentials before release.
      report("calling thread test login saved on both servers",state.every((c) => typeof c.loginId === "string"));
      const loginFiles = [NodePath.join(root,"ts","base","userdata","secrets","test-logins.bin"), NodePath.join(root,"rust","state","secrets","test-logins.bin")];
      const loginBytes = loginFiles.map((file) => NodeFS.readFileSync(file));
      const storedLogins = loginBytes.map((bytes) => {
        const value = JSON.parse(bytes);
        return {...value,logins:value.logins.map((login) => ({...login,id:"<id>",createdAt:"<time>"}))};
      });
      report("test login disk format and exact secret bytes",canonical(storedLogins[0]) === canonical(storedLogins[1]) && storedLogins[0].logins[0].password === "fixture-only");
      for (const file of loginFiles) NodeFS.writeFileSync(file,"invalid fixture store",{mode:0o600});
      const corruptLoginReplies = await Promise.all(agents.map((agent) => agent.callTool("request_credentials",{domain:"example.test"})));
      const corruptLoginResults = corruptLoginReplies.map(outcome);
      const sameLoginFailure = corruptLoginResults.every((result) => result.kind === "failure") && canonical(corruptLoginResults[0]) === canonical(corruptLoginResults[1]);
      report(`test login store failure text${sameLoginFailure ? "" : `: T3 ${canonical(corruptLoginReplies[0])} / Conn ${canonical(corruptLoginReplies[1])}`}`,sameLoginFailure);
      loginFiles.forEach((file,i) => NodeFS.writeFileSync(file,loginBytes[i],{mode:0o600}));
      await Promise.all(servers.map((server,i) => projectProviderPolicy(server,context[i].projectId,false,[setupScript])));
      for (const target of [{},{providerInstanceId:"claudeAgent"}]) {
        const denied = await Promise.all(agents.map((agent) => agent.callTool("create_threads",{threads:[{target}]}).then(outcome)));
        report("calling thread create_threads: disabled project provider refused",denied.every((r) => r.kind === "failure" && r.code === "invalid_request"));
      }
      const retries = await Promise.all(agents.map((agent) => agent.callTool("create_threads",{threads:[{prompt:"hang"}],clientRequestId:"prompt-retry"}).then(outcome)));
      report("calling thread create_threads: accepted retry survives policy change",retries.every((r,i) => r.kind === "ok" && r.value.threads[0].runId === state[i].promptRun));
      await Promise.all(servers.map((server,i) => projectProviderPolicy(server,context[i].projectId,true,[setupScript])));
      const discards = await Promise.all(agents.map((agent,i) => agent.callTool("t3_attachment_discard",{attachmentId:state[i].attachment.id}).then(outcome)));
      report("accepted difference: successful send reclaims Conn's pending owner slot",discards[0].kind === "ok" && discards[1].kind === "failure" && discards[1].code === "invalid_request");
    }
    const values = await Promise.all(agents.map(async (agent,i) => {
      const result=outcome(await agent.callTool(tool,input(state[i])));
      if (result.kind === "ok") { await after?.(state[i],result.value,servers[i]); return {kind:"ok",value:normalize(result.value)}; }
      return result;
    }));
    report(`calling thread ${tool}: ${canonical(values[0]) === canonical(values[1]) ? "same outcome" : JSON.stringify(values)}`, canonical(values[0]) === canonical(values[1]));
  }
  await Promise.all(servers.map((server) => updateSettings(server,{enableAgentBrowserAccess:false})));
  for (const name of NodeFS.readdirSync(servers[0].records).filter((name) => name.endsWith(".json"))) NodeFS.unlinkSync(NodePath.join(servers[0].records,name));
  NodeFS.rmSync(servers[1].capture,{force:true});
  const deniedLaunch = await Promise.all(sessions.map((session,i) => session.callTool("t3_thread_launch",{
    projectId:context[i].projectId,title:"Browser access disabled",message:"hang",
    modelSelection:{instanceId:"claudeAgent",model:"claude-haiku-5-5"},runtimeMode:"auto",
    workspaceStrategy:{type:"root"},clientRequestId:"browser-access-disabled",
  }).then(outcome)));
  if (deniedLaunch.some((r) => r.kind !== "ok")) throw new Error("Could not launch denied browser fixture");
  const deniedCredentials = await Promise.all([tsCredential(servers[0].records),rustCredential(servers[1].capture)]);
  const deniedAgents = deniedCredentials.map((entry) => new McpSession(new URL(entry.url).origin,entry.headers.Authorization));
  await Promise.all(deniedAgents.map((agent) => agent.initialize()));
  for (const [tool,args] of [["request_credentials",{domain:"example.test"}],["save_test_login",{url:"example.test",username:"denied",password:"fixture-only"}]]) {
    const results=await Promise.all(deniedAgents.map((agent) => agent.callTool(tool,args).then(outcome)));
    report(`disabled browser access ${tool}: same refusal`,results.every((r) => r.kind === "failure") && canonical(results[0]) === canonical(results[1]));
  }
  const setup = await Promise.all(state.map(async (c,i) => {
    const text = await fileText(NodePath.join(c.worktreePath,"handoff-setup.txt"));
    const lines = text.trimEnd().split("\n");
    return lines.length === 2 && lines[0] === NodePath.join(root,i === 0 ? "ts" : "rust","parity") && lines[1] === c.worktreePath;
  }));
  report("calling thread handoff setup: project and worktree environment",setup.every(Boolean));
  const ended = await Promise.all(sessions.map((session,i) => session.callTool("t3_thread_wait",{
    threadId:launched[i].value.threadId,runId:launched[i].value.runId,timeoutMs:10_000,
  }).then(outcome)));
  const endedStates = ended.map((r) => r.kind === "ok" ? {status:r.value.status,timedOut:r.value.timedOut} : r);
  report(`calling thread handoff ends old run: ${canonical(endedStates[0])}`,canonical(endedStates[0]) === canonical(endedStates[1]));


}
console.log(failed === 0 ? "\nparity: no differences" : `\nparity: ${failed} differences`);
process.exit(failed === 0 ? 0 : 1);

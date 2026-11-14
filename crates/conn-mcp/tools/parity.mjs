#!/usr/bin/env node
// Same calls on the T3 server and the Conn Server (`examples/replay_server`), on throwaway
// state; compares outcome, failure code and result shape. By default no model is called:
// the thread launch and every step on its thread are skipped. `--model` runs them too, with
// one Haiku turn on the T3 server. `--no-model` is accepted and is the default.
// Usage: parity.mjs [--model] [--record-tools-list <file>] <conn-server-binary>. Needs `vp i`
// in `CONN_MONOREPO`. `--record-tools-list` also writes the T3 server's `tools/list` reply to
// <file>: after a pin bump, refresh `fixtures/ts-tools-list.json` with it (docs/upkeep.md).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { McpSession, oauthMcpToken, pairBearer } from "./mcp-client.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";

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
const implemented = NodeFS.readFileSync(new URL("../tools.implemented", import.meta.url), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-mcp-parity-"));
const children = [];
process.once("exit", () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  NodeFS.rmSync(root, { recursive: true, force: true });
});

function scratchProject(name) {
  const dir = NodePath.join(root, name, "parity");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir },
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
  const port = await freePort();
  const node = process.execPath;
  const { origin, code } = await start(
    node,
    [
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
        HOME: NodeOS.homedir(),
        USER: NodeOS.userInfo().username,
        PATH: [
          NodePath.dirname(node),
          NodePath.join(NodeOS.homedir(), ".local/bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ].join(":"),
        T3CODE_HOME: base,
        T3CODE_NO_BROWSER: "1",
      },
    },
    port,
  );
  const bearer = await pairBearer(origin, code);
  return {
    name: "T3 server",
    origin,
    authorization: `Bearer ${await oauthMcpToken(origin, bearer)}`,
  };
}

async function startRust() {
  const project = scratchProject("rust");
  const port = await freePort();
  const state = NodePath.join(root, "rust", "state");
  const { origin, code } = await start(
    rustBinary,
    ["--listen", `127.0.0.1:${port}`, "--state-dir", state, "--project", project],
    {},
    port,
  );
  return { name: "Conn Server", origin, authorization: `Bearer ${await pairBearer(origin, code)}` };
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
      return { kind: "failure", code: failure.code };
    } catch {
      return { kind: "failure", code: text };
    }
  }
  return { kind: "ok", value: reply.result.structuredContent };
}

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
for (const name of implemented) {
  const [ts, rust] = lists.map((list) => list.result.tools.find((tool) => tool.name === name));
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

// Per-server state the calls refer to: project and thread ids differ.
const context = [{}, {}];
const steps = [
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
    (c) => ({ threadId: c.idleThreadId, url: "https://git.cafe/O/R/pull/4" }),
    (c) => ({ threadId: c.idleThreadId, url: "https://git.cafe/o/r/pulls/4" }),
    (c) => ({ threadId: c.idleThreadId, repository: "O/R", number: 3, host: "GitHub.com" }),
    (c) => ({ threadId: c.idleThreadId, url: "http://forge.example:3000/a/b/pulls/7" }),
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
        "https://gitlab.com/g/s/p/-/merge_requests/2",
      ],
    }),
    undefined,
    { same: (v) => v },
  ],
  ["list_thread_pull_requests", (c) => ({ threadId: c.idleThreadId }), undefined, { same: (v) => v }],
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
  ["send_to_user", () => ({ message: "hi" })],
  ["send_to_user", () => ({ message: "" })],
  ["send_to_user", () => ({ message: "x".repeat(4001) })],
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
      if (result.kind === "ok" && after !== undefined) after(context[i], result.value);
      return result;
    }),
  );
  const [ts, rust] = results;
  const label = `${tool} ${JSON.stringify(input({ projectId: "<p>", threadId: "<t>", runId: "<r>" }))}`;
  if (ts.kind !== rust.kind || ts.code !== rust.code) {
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
    report(`${label}: both fail with ${ts.code}`, true);
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
console.log(failed === 0 ? "\nparity: no differences" : `\nparity: ${failed} differences`);
process.exit(failed === 0 ? 0 : 1);

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
  ["orchestrator_capabilities", () => ({})],
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
    undefined,
    { noTurn: true },
  ],
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
  ["t3_thread_read", () => ({ threadId: "thread:none" })],
  ["t3_thread_list", () => ({ bogus: 1 })],
  ["delegate_task", () => ({ task: "x" })],
  ["task_status", () => ({ taskId: "task:none" })],
  ["task_cancel", () => ({ taskId: "task:none" })],
];
// The steps that launch a thread (a model turn on the T3 server) or act on it.
const onLaunchedThread = (tool, input, options) =>
  options?.noTurn !== true &&
  (tool === "t3_thread_launch" || input({ threadId: "<t>" }).threadId === "<t>");
const run = noModel
  ? steps.filter(([tool, input, , options]) => !onLaunchedThread(tool, input, options))
  : steps;
if (noModel) console.log(`no model: skipped ${steps.length - run.length} steps on a launched thread`);
for (const [tool, input, after] of run) {
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
  const diff = differences(shape(rust.value), shape(ts.value)).filter((d) => !ACCEPTED.has(d));
  report(
    `${label}${diff.length === 0 ? "" : `\n       ${diff.join("\n       ")}`}`,
    diff.length === 0,
  );
}
console.log(failed === 0 ? "\nparity: no differences" : `\nparity: ${failed} differences`);
process.exit(failed === 0 ? 0 : 1);

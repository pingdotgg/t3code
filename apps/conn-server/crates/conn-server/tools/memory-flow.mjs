#!/usr/bin/env node
// Memory of a Conn Server on Linux, from /proc/<pid>/smaps_rollup, through a client's day:
// just started; a client connected with its streams open; after 20 turns in 3 threads; after
// 2 idle minutes. Meant for `examples/replay_server` (the engine's fake provider, no model).
// Usage: node memory-flow.mjs <server-binary> [turns] [threads] [idle-seconds]
// MEM_T3_PIDS=<pid,pid,...> also samples those T3 servers at the same moments (read with
// `sudo -n cat`, as their smaps are not ours). The server binds 127.0.0.1 on a free port and
// keeps its state in a temp folder (--state-dir), never ~/.t3. Needs no monorepo.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { gitEnv, sealedEnv } from "../../../tools/sealed-env.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const { McpSession } = await import(
  NodeURL.pathToFileURL(NodePath.resolve(here, "../../conn-mcp/tools/mcp-client.mjs")).href
);

const binary = NodePath.resolve(process.argv[2] ?? "");
if (!NodeFS.existsSync(binary))
  throw new Error("usage: memory-flow.mjs <server-binary> [turns] [threads] [idle-seconds]");
const turns = Number(process.argv[3] ?? 20);
const threadCount = Number(process.argv[4] ?? 3);
const idleSeconds = Number(process.argv[5] ?? 120);
const t3Pids = (process.env.MEM_T3_PIDS ?? "").split(",").filter(Boolean).map(Number);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await new Promise((resolve) => {
  const probe = NodeNet.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
// `conn-linux-` is the temp prefix the Linux host allows for this work.
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-linux-memory-"));
const home = NodePath.join(root, ".t3");
const state = NodePath.join(home, "userdata");
const workspace = NodePath.join(root, "workspace");
const origin = `http://127.0.0.1:${port}`;
// Sealed: a throwaway HOME, a stand-in shell, no variable of the shell beyond what a process
// needs, and no run of this machine's `claude` for the status (sealedEnv).
const env = { ...sealedEnv(root), T3CODE_HOME: home, DISABLE_AUTOUPDATER: "1" };
delete env.T3CODE_PORT;
delete env.T3CODE_HOST;
const cli = (...args) =>
  NodeChildProcess.execFileSync(binary, [...args, "--state-dir", state], {
    env,
    encoding: "utf8",
  }).trim();

const KEYS = ["Rss", "Pss", "Pss_Anon", "Pss_File", "Private_Dirty"];
const rollup = (text) => {
  const out = {};
  for (const line of text.split("\n")) {
    const [key, value] = line.split(":");
    if (KEYS.includes(key)) out[key] = Number.parseInt(value, 10) / 1024;
  }
  return out;
};
const sudoRead = (pid) => {
  try {
    return NodeChildProcess.execFileSync(
      "sudo",
      ["-n", "cat", `/proc/${pid}/smaps_rollup`],
      { encoding: "utf8" },
    );
  } catch {
    return "";
  }
};
const samples = [];
const sample = (label, pid) => {
  const own = rollup(NodeFS.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
  const t3 = t3Pids.map((p) => rollup(sudoRead(p)).Pss_Anon).filter((v) => v !== undefined);
  samples.push({ label, ...own, t3 });
  const t3Text =
    t3.length === 0
      ? ""
      : `; T3 Pss_Anon ${t3.map((v) => v.toFixed(0)).join(", ")} MiB (mean ${(
          t3.reduce((a, b) => a + b, 0) / t3.length
        ).toFixed(0)})`;
  console.log(
    `${label}: ${KEYS.map((k) => `${k} ${own[k]?.toFixed(1)}`).join(", ")} MiB${t3Text}`,
  );
};

NodeFS.mkdirSync(state, { recursive: true });
NodeFS.mkdirSync(workspace);
NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace, env: gitEnv() });
NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "# workspace\n");
NodeChildProcess.execFileSync("git", ["add", "."], { cwd: workspace, env: gitEnv() });
NodeChildProcess.execFileSync(
  "git",
  ["-c", "user.name=m", "-c", "user.email=m@example.com", "-c", "commit.gpgsign=false"]
    .concat(["commit", "-qm", "init"]),
  { cwd: workspace, env: gitEnv() },
);

const server = NodeChildProcess.spawn(
  binary,
  ["serve", "--state-dir", state, "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
  { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
server.stdout.on("data", (d) => (output += d));
server.stderr.on("data", (d) => (output += d));
const exited = new Promise((resolve) => server.on("exit", (code, signal) => resolve({ code, signal })));
let socket = null;
let pinger = null;

try {
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await fetch(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!ready) await sleep(1000);
  }
  if (!ready) throw new Error(`not ready:\n${output}`);
  await sleep(5000);
  sample("just started", server.pid);

  cli("project", "add", workspace, "--title", "Workspace");
  const token = cli("auth", "session", "issue", "--label", "Memory", "--token-only");
  const bearer = { authorization: `Bearer ${token}` };
  const ticket = await fetch(`${origin}/api/auth/websocket-ticket/rpc`, {
    method: "POST",
    headers: bearer,
  }).then((r) => r.json());
  if (typeof ticket.ticket !== "string") throw new Error(`ticket: ${JSON.stringify(ticket)}`);

  // The streams the web client opens at boot, as plain Effect RPC JSON frames.
  let nextId = 0;
  const chunks = new Map();
  const failures = [];
  socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket.ticket)}&orchestrationProtocol=2`,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const tags = new Map();
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(event.data);
    for (const frame of Array.isArray(value) ? value : [value]) {
      if (frame._tag === "Chunk") {
        const tag = tags.get(frame.requestId);
        chunks.set(tag, (chunks.get(tag) ?? 0) + frame.values.length);
        socket.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
      } else if (frame._tag === "Exit" && frame.exit?._tag === "Failure") {
        failures.push(`${tags.get(frame.requestId)}: ${JSON.stringify(frame.exit.cause).slice(0, 300)}`);
      } else if (frame._tag === "Defect") {
        failures.push(`defect: ${JSON.stringify(frame.defect).slice(0, 300)}`);
      }
    }
  });
  const subscribe = (tag, payload) => {
    const id = String(++nextId);
    tags.set(id, tag);
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  };
  pinger = setInterval(() => socket.send(JSON.stringify({ _tag: "Ping" })), 5000);
  subscribe("subscribeServerConfig", {});
  subscribe("subscribeServerLifecycle", {});
  subscribe("orchestration.subscribeShell", {});
  await sleep(5000);
  sample("connected, streams open", server.pid);

  const mcp = new McpSession(origin, `Bearer ${token}`);
  await mcp.initialize();
  const tool = async (name, args) => {
    const reply = await mcp.callTool(name, args);
    if (reply.result?.isError !== false) throw new Error(`${name}: ${JSON.stringify(reply)}`);
    return reply.result.structuredContent;
  };
  const projects = await tool("conn_project_list", {});
  const project = projects.projects.find((p) => p.workspaceRoot === NodeFS.realpathSync(workspace));
  const threads = [];
  for (let n = 1; n <= turns; n++) {
    const index = (n - 1) % threadCount;
    let run;
    if (threads[index] === undefined) {
      run = await tool("conn_thread_launch", {
        projectId: project.id,
        title: `Memory ${index + 1}`,
        message: `Turn ${n}`,
        modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        clientRequestId: `memory-${index}`,
      });
      threads[index] = run.threadId;
      // The thread view the web client opens.
      subscribe("orchestration.subscribeThread", {
        threadId: run.threadId,
        acceptBoundedSnapshot: true,
        acceptDeferredWork: true,
      });
    } else {
      run = await tool("conn_thread_send", { threadId: threads[index], message: `Turn ${n}`, mode: "queue" });
    }
    const waited = await tool("conn_thread_wait", { threadId: run.threadId, runId: run.runId, timeoutMs: 60_000 });
    if (waited.status !== "completed") throw new Error(`turn ${n}: ${JSON.stringify(waited)}`);
  }
  await sleep(2000);
  sample(`after ${turns} turns in ${threadCount} threads`, server.pid);
  await sleep(idleSeconds * 1000);
  sample(`after ${idleSeconds} idle seconds`, server.pid);
  console.log(`chunks per stream: ${JSON.stringify(Object.fromEntries(chunks))}`);
  if (failures.length > 0) throw new Error(`stream failures:\n${failures.join("\n")}`);
} finally {
  if (pinger !== null) clearInterval(pinger);
  socket?.close();
  server.kill("SIGTERM");
  const result = await Promise.race([exited, sleep(10_000).then(() => ({ code: "timeout" }))]);
  if (result.code === "timeout") server.kill("SIGKILL");
  console.log(`server exit ${result.code ?? result.signal}`);
  NodeFS.rmSync(root, { recursive: true, force: true });
}

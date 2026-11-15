#!/usr/bin/env node
// Orbit's container flow (DROP-IN.md §1) and its task-turn path (`task-copy-turn.yml`,
// `t3_copy_rpc.mjs`) against a Conn Server binary. The turn is one Haiku
// turn with `conn-server`, and the scripted fake provider with `examples/replay_server`.
// Usage: node orbit-flow.mjs <conn-server> [port]. The port defaults to a free one. The home is
// a temporary T3CODE_HOME, never ~/.t3. Needs no monorepo. The server binds 0.0.0.0 as Orbit
// starts it; ORBIT_FLOW_HOST=127.0.0.1 binds loopback only (on a shared host).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { monorepoRoot } from "../../../tools/monorepo.mjs";
import { gitEnv, sealedEnv } from "../../../tools/sealed-env.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const { McpSession } = await import(
  NodeURL.pathToFileURL(NodePath.resolve(here, "../../conn-mcp/tools/mcp-client.mjs")).href
);
const { copyRpc } = await import(
  NodeURL.pathToFileURL(NodePath.resolve(here, "orbit-copy-rpc.mjs")).href
);

const binary = NodePath.resolve(process.argv[2] ?? "");
const host = process.env.ORBIT_FLOW_HOST || "0.0.0.0";
const freePort = () =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    // Probe the address the server binds.
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const port = process.argv[3] === undefined ? await freePort() : Number(process.argv[3]);
if (!NodeFS.existsSync(binary)) throw new Error("usage: orbit-flow.mjs <conn-server> [port]");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-orbit-"));
const home = NodePath.join(root, ".t3");
const workspace = NodePath.join(root, "workspace");
const origin = `http://127.0.0.1:${port}`;
// CONN_CLAUDE_STATUS_PROBE=off and CONN_CODEX_STATUS_PROBE=off: the server never runs this
// machine's `claude` or `codex` for its status.
// With `replay_server` (no model), a sealed environment: a throwaway HOME, a stand-in shell and
// no variable of the shell beyond what a process needs. The live Haiku turn with `conn-server`
// needs the real `claude` and its login, so it keeps the shell's environment.
const live = !NodePath.basename(binary).startsWith("replay_server");
const env = {
  ...(live ? process.env : sealedEnv(root)),
  T3CODE_HOME: home,
  DISABLE_AUTOUPDATER: "1",
  CONN_CLAUDE_STATUS_PROBE: "off",
  CONN_CODEX_STATUS_PROBE: "off",
};
delete env.T3CODE_PORT;
delete env.T3CODE_HOST;

// model-manifest.json comes from a loopback stub, never from GitHub (the test seam
// CONN_MODEL_MANIFEST_URL). It serves the manifest the monorepo bundles, else a small one
// that lists the model this flow uses.
const bundledFile = NodePath.join(monorepoRoot, "apps/server/src/provider/model-manifest.json");
const manifestText =
  bundledFile && NodeFS.existsSync(bundledFile)
    ? NodeFS.readFileSync(bundledFile, "utf8")
    : JSON.stringify(
        {
          version: 1,
          updatedAt: "2099-01-01T00:00:00Z",
          currentModels: { claudeAgent: ["claude-haiku-5-5"] },
          providers: {
            claudeAgent: {
              profiles: {},
              models: [{ slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", status: "current" }],
            },
          },
        },
        null,
        2,
      );
const stub = { mode: "manifest", hits: 0 };
const stubServer = NodeHttp.createServer((request, response) => {
  stub.hits++;
  if (stub.mode === "manifest" && request.url === "/model-manifest.json") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(manifestText);
  } else {
    response.writeHead(500);
    response.end("stub: failing on purpose");
  }
});
await new Promise((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${stubServer.address().port}/model-manifest.json`;
env.CONN_MODEL_MANIFEST_URL = stubUrl;

const step = (text) => console.log(`\n## ${text}`);
const ok = (text) => console.log(`ok   ${text}`);
const fail = (text) => {
  throw new Error(text);
};
const cli = (...args) =>
  NodeChildProcess.execFileSync(binary, args, { env, encoding: "utf8" }).trim();
/** A CLI call as Orbit's playbook runs it: stdout, stderr and the exit code, never a throw. */
const run = (args, input = "") => {
  const result = NodeChildProcess.spawnSync(binary, args, {
    env,
    cwd: workspace,
    input,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The pids below `pid`, from one `ps` listing. */
const descendants = (pid) => {
  const rows = NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([p, pp, ...comm]) => ({ pid: Number(p), ppid: Number(pp), comm: comm.join(" ") }));
  const out = [];
  const walk = (parent) => {
    for (const row of rows.filter((r) => r.ppid === parent)) {
      out.push(row);
      walk(row.pid);
    }
  };
  walk(pid);
  return out;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Files Orbit writes before the first start.
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(home, "userdata", "settings.json"),
  JSON.stringify({ linkedEnvironmentsEnabled: true }),
);
NodeFS.mkdirSync(workspace);
NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace, env: gitEnv() });
NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "# workspace\n");
NodeChildProcess.execFileSync("git", ["add", "."], { cwd: workspace, env: gitEnv() });
NodeChildProcess.execFileSync(
  "git",
  [
    "-c",
    "user.name=o",
    "-c",
    "user.email=o@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "init",
  ],
  { cwd: workspace, env: gitEnv() },
);

step(`start: ${NodePath.basename(binary)} serve --host=${host} --port=${port} --no-browser`);
const server = NodeChildProcess.spawn(
  binary,
  ["serve", `--host=${host}`, `--port=${port}`, "--no-browser"],
  { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
server.stdout.on("data", (d) => (output += d));
server.stderr.on("data", (d) => (output += d));
let stopped = false;
const exited = new Promise((resolve) =>
  server.on("exit", (code, signal) => {
    stopped = true;
    resolve({ code, signal });
  }),
);
ok(`pid ${server.pid}`);

try {
  step("readiness: GET /.well-known/t3/environment once a second, up to 30 s");
  let descriptor = null;
  for (let i = 0; i < 30 && descriptor === null && !stopped; i++) {
    descriptor = await fetch(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (descriptor === null) await sleep(1000);
  }
  if (descriptor === null) fail(`not ready:\n${output}`);
  for (const key of ["environmentId", "label", "serverVersion"]) {
    if (typeof descriptor[key] !== "string") fail(`descriptor.${key} is not a string`);
  }
  ok(`ready: ${descriptor.environmentId} "${descriptor.label}" ${descriptor.serverVersion}`);

  step("project add on the running server");
  const added = cli("project", "add", workspace, "--title", "Workspace");
  console.log(added);

  step('auth session issue --label "Orbit Swamp" --token-only');
  const token = cli("auth", "session", "issue", "--label", "Orbit Swamp", "--token-only");
  if (token.includes("\n") || token.length < 20) fail(`unexpected token output: ${token}`);
  ok(`token of ${token.length} characters`);
  const session = await (
    await fetch(`${origin}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  if (session.authenticated !== true) fail(`session: ${JSON.stringify(session)}`);
  ok(
    `GET /api/auth/session: authenticated, scopes ${session.scopes?.join(" ")}, expires ${session.expiresAt}`,
  );

  step("MCP as Swamp: t3_project_list, t3_thread_launch, t3_thread_wait, t3_thread_read");
  const mcp = new McpSession(origin, `Bearer ${token}`);
  const init = await mcp.initialize();
  ok(`initialize: protocol ${init.result?.protocolVersion}`);
  const tool = async (name, args) => {
    const reply = await mcp.callTool(name, args);
    if (reply.result?.isError !== false) fail(`${name}: ${JSON.stringify(reply)}`);
    return reply.result.structuredContent;
  };
  const projects = await tool("t3_project_list", {});
  const project = projects.projects.find((p) => p.workspaceRoot === NodeFS.realpathSync(workspace));
  if (project === undefined) fail(`project not listed: ${JSON.stringify(projects)}`);
  ok(`t3_project_list: ${project.title} ${project.id}`);
  const launchArgs = {
    projectId: project.id,
    title: "Orbit flow",
    message: "Reply with exactly: orbit ok",
    modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    clientRequestId: "operation-1",
  };
  const launched = await tool("t3_thread_launch", launchArgs);
  const again = await tool("t3_thread_launch", launchArgs);
  if (again.threadId !== launched.threadId || again.runId !== launched.runId)
    fail("a retried launch made a second thread or run");
  ok(`t3_thread_launch: ${launched.threadId} run ${launched.runId} (retry returns the same)`);
  const waited = await tool("t3_thread_wait", {
    threadId: launched.threadId,
    runId: launched.runId,
    timeoutMs: 180_000,
  });
  ok(`t3_thread_wait: ${waited.status}${waited.timedOut ? " (timed out)" : ""}`);
  const read = await tool("t3_thread_read", {
    threadId: launched.threadId,
    view: "activity",
    afterPosition: -1,
  });
  const text = JSON.stringify(read);
  if (!/orbit ok/i.test(text)) fail(`the answer is not in the read: ${text.slice(0, 600)}`);
  ok(`t3_thread_read activity: ${read.items?.length} items, the answer is there`);

  // `swamp/ansible/task-copy-turn.yml`, in its order, then `t3_copy_rpc.mjs`.
  step("task turn: read settings.json and model-manifest.json, check the model");
  const model = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
  const settings = JSON.parse(
    NodeFS.readFileSync(NodePath.join(home, "userdata", "settings.json"), "utf8"),
  );
  const driver = settings.providerInstances?.[model.instanceId]?.driver ?? model.instanceId;
  const manifestFile = NodePath.join(home, "userdata", "model-manifest.json");
  // The server fetched it from the stub at start; give it a moment if it has not yet.
  for (let i = 0; i < 40 && !NodeFS.existsSync(manifestFile); i++) await sleep(250);
  if (!NodeFS.existsSync(manifestFile)) fail(`no model-manifest.json after a start (stub hits: ${stub.hits})`);
  if (stub.hits !== 1) fail(`the stub was asked ${stub.hits} times, not once`);
  {
    const written = JSON.parse(NodeFS.readFileSync(manifestFile, "utf8"));
    if (JSON.stringify(written.manifest) !== JSON.stringify(JSON.parse(manifestText))) {
      fail("model-manifest.json does not hold the manifest the stub served");
    }
    ok(
      `model-manifest.json written from the loopback stub (${bundledFile && NodeFS.existsSync(bundledFile) ? "the bundled manifest" : "a small manifest"}), one request`,
    );
  }
  if (NodeFS.existsSync(manifestFile)) {
    const cached = JSON.parse(NodeFS.readFileSync(manifestFile, "utf8"));
    const listed = (cached.manifest?.providers?.[driver]?.models ?? []).filter(
      (entry) => typeof entry?.slug === "string",
    );
    const offered = listed.flatMap((entry) => [entry.slug, ...(entry.aliases ?? [])]);
    if (typeof cached.fetchedAtMs !== "number") fail("model-manifest.json has no fetchedAtMs");
    if (listed.length > 0 && !offered.includes(model.model)) {
      fail(`${model.model} is not offered by the cached manifest: ${offered.join(" ")}`);
    }
    ok(`model-manifest.json lists ${listed.length} ${driver} models; ${model.model} is offered`);
  } else {
    ok("no model-manifest.json (no fetch yet): Orbit checks no model, as with T3");
  }

  step("task turn: thread list --project <workspace> --json (settle)");
  const listThreads = () => {
    const listed = run(["thread", "list", "--project", workspace, "--json"]);
    if (listed.code !== 0) fail(`thread list exited ${listed.code}: ${listed.stderr}`);
    return JSON.parse(listed.stdout);
  };
  ok(`${listThreads().length} thread(s), each with title and status`);

  step("task turn: thread start --provider --model --title --wait --json <workspace> -");
  const title = "Orbit task 1 thread 1";
  const started = run(
    ["thread", "start", "--provider", model.instanceId, "--model", model.model, "--title", title,
      "--wait", "--json", workspace, "-"],
    "Reply with exactly: orbit ok",
  );
  if (started.code !== 0) fail(`thread start exited ${started.code}: ${started.stderr}`);
  const start = JSON.parse(started.stdout);
  if (Object.keys(start).join(",") !== "threadId,runId,status,reply,error") {
    fail(`thread start printed ${started.stdout}`);
  }
  if (start.status !== "completed" || typeof start.reply !== "string") {
    fail(`thread start: ${started.stdout}`);
  }
  ok(`exit 0, ${start.status}, reply ${JSON.stringify(start.reply)}`);

  step("task turn: thread list --json, find by title; thread show --messages 200 --json");
  const found = listThreads().filter((t) => t.title === title);
  if (found.length !== 1 || found[0].threadId !== start.threadId) {
    fail(`not found by title: ${JSON.stringify(found)}`);
  }
  const shown = run(["thread", "show", "--messages", "200", "--json", found[0].threadId]);
  if (shown.code !== 0) fail(`thread show exited ${shown.code}: ${shown.stderr}`);
  const show = JSON.parse(shown.stdout);
  if (show.thread?.threadId !== start.threadId || show.messages?.length !== 2) {
    fail(`thread show: ${shown.stdout.slice(0, 600)}`);
  }
  ok(`status ${found[0].status}; ${show.messages.map((m) => m.role).join(", ")}`);

  step("task turn, continued: thread send --wait --json <thread> -");
  const sent = run(["thread", "send", "--wait", "--json", start.threadId, "-"], "Once more");
  if (sent.code !== 0) fail(`thread send exited ${sent.code}: ${sent.stderr}`);
  const send = JSON.parse(sent.stdout);
  if (send.status !== "completed" || send.runId === start.runId) fail(`thread send: ${sent.stdout}`);
  ok(`exit 0, ${send.status}, reply ${JSON.stringify(send.reply)}`);

  step("task turn that asks: --wait exits 2, then t3_copy_rpc.mjs read and interrupt");
  const asked = run(
    ["thread", "start", "--provider", model.instanceId, "--model", model.model, "--title",
      "Orbit task 2 thread 1", "--wait", "--json", workspace, "-"],
    "ask",
  );
  if (asked.code !== 2) fail(`a turn that asks exited ${asked.code}: ${asked.stdout} ${asked.stderr}`);
  const waiting = JSON.parse(asked.stdout);
  if (waiting.status !== "waiting" || waiting.reply !== null) fail(`asks: ${asked.stdout}`);
  ok(`exit 2, ${waiting.status}; stderr: ${asked.stderr.trim()}`);
  const side = {
    env: { HOME: root },
    cli: async (args, input = "") => run(args, input),
  };
  const asking = await copyRpc(side, "read", waiting.threadId);
  if (asking.code !== 0 || !asking.revoked) fail(`copy rpc read: ${JSON.stringify(asking)}`);
  const kinds = asking.out.requests.map((r) => r.kind).join(" ");
  // The fake provider asks for a command approval, not a question: Orbit leaves it running.
  if (asking.out.requests.length !== 1 || asking.out.stoppable !== false) {
    fail(`copy rpc read: ${JSON.stringify(asking.out)}`);
  }
  ok(`read: ${asking.out.runs.length} live run, requests ${kinds}, stoppable ${asking.out.stoppable}; session revoked`);
  const stop = await copyRpc(side, "interrupt", waiting.threadId, waiting.runId, "request:1");
  if (stop.code !== 0 || !stop.revoked || stop.out.interrupted !== false) {
    fail(`copy rpc interrupt: ${JSON.stringify(stop)}`);
  }
  ok(`interrupt refused as Orbit's script refuses an approval: ${stop.out.error}`);
  const leftover = JSON.parse(cli("auth", "session", "list", "--json")).filter((s) =>
    ["t3 thread cli", "orbit copy turn"].includes(s.client?.label),
  );
  if (leftover.length > 0) fail(`sessions left: ${JSON.stringify(leftover)}`);
  ok("no thread-CLI or copy-turn session is left");

  step("revoke the Swamp session");
  const list = JSON.parse(cli("auth", "session", "list", "--json"));
  const swamp = list.find((s) => s.client?.label === "Orbit Swamp");
  if (swamp === undefined) fail(`no Orbit Swamp session in ${JSON.stringify(list)}`);
  console.log(cli("auth", "session", "revoke", swamp.sessionId));
  let status = 0;
  for (let i = 0; i < 40; i++) {
    status =
      (
        await fetch(`${origin}/api/auth/session`, {
          headers: { authorization: `Bearer ${token}` },
        }).then((r) => r.json())
      ).authenticated === true
        ? 200
        : 401;
    if (status === 401) break;
    await sleep(1000);
  }
  if (status !== 401) fail("the revoked session still authenticates");
  const after = await new McpSession(origin, `Bearer ${token}`).raw({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "x", version: "0" },
    },
  });
  if (after.status !== 401) fail(`/mcp after revoke answered ${after.status}`);
  ok("the revoked token gets 401 from /api/auth/session and /mcp");
} finally {
  step("SIGTERM");
  const children = descendants(server.pid);
  console.log(
    `children before: ${children.map((c) => `${c.pid} ${NodePath.basename(c.comm)}`).join(", ") || "none"}`,
  );
  const started = Date.now();
  server.kill("SIGTERM");
  const { code, signal } = await Promise.race([
    exited,
    sleep(10_000).then(() => ({ code: "timeout" })),
  ]);
  console.log(`exit ${code ?? signal} after ${Date.now() - started} ms`);
  await sleep(1000);
  const left = children.filter((c) => alive(c.pid));
  if (left.length > 0) {
    console.log(`LEFT RUNNING: ${left.map((c) => `${c.pid} ${c.comm}`).join(", ")}`);
    process.exitCode = 1;
  } else {
    ok("no child of the server runs");
  }
  console.log(
    output
      .split("\n")
      .filter((l) => !l.includes("pairingUrl"))
      .join("\n"),
  );
  NodeFS.rmSync(root, { recursive: true, force: true });
}

/**
 * A short start on a fresh home with the seam at `url`: whether the server got ready, and
 * whether it wrote model-manifest.json within 3 s.
 */
async function briefStart(url) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-orbit-manifest-"));
  const briefHome = NodePath.join(dir, ".t3");
  NodeFS.mkdirSync(NodePath.join(briefHome, "userdata"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(briefHome, "userdata", "settings.json"),
    JSON.stringify({ linkedEnvironmentsEnabled: true }),
  );
  const briefPort = await freePort();
  const child = NodeChildProcess.spawn(
    binary,
    ["serve", "--host=127.0.0.1", `--port=${briefPort}`, "--no-browser"],
    {
      env: { ...env, T3CODE_HOME: briefHome, CONN_MODEL_MANIFEST_URL: url },
      cwd: dir,
      stdio: "ignore",
    },
  );
  const gone = new Promise((resolve) => child.on("exit", resolve));
  try {
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      ready = await fetch(`http://127.0.0.1:${briefPort}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(1000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (!ready) await sleep(500);
    }
    await sleep(3000);
    const written = NodeFS.existsSync(NodePath.join(briefHome, "userdata", "model-manifest.json"));
    return { ready, written };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([gone, sleep(10_000)]);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  step("model manifest: the stub answers 500; then nothing listens at the seam's URL");
  stub.mode = "error";
  stub.hits = 0;
  const failed = await briefStart(stubUrl);
  if (!failed.ready || failed.written || stub.hits !== 1) {
    fail(`500: ready ${failed.ready}, file ${failed.written}, stub hits ${stub.hits}`);
  }
  ok("500: the server is ready, tried once, wrote no file");
  const closedPort = await freePort();
  const refused = await briefStart(`http://127.0.0.1:${closedPort}/model-manifest.json`);
  if (!refused.ready || refused.written) {
    fail(`no listener: ready ${refused.ready}, file ${refused.written}`);
  }
  ok("no listener: the server is ready and wrote no file");
  ok("without the file Orbit's model check checks nothing, as with a T3 server that has not fetched");
} catch (error) {
  console.log(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  stubServer.close();
}

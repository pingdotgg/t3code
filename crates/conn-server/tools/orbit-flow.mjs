#!/usr/bin/env node
// Orbit's container flow (DROP-IN.md §1) against a Conn Server binary. The turn is one Haiku
// turn with `conn-server`, and the scripted fake provider with `examples/replay_server`.
// Usage: node orbit-flow.mjs <conn-server> [port]. The port defaults to a free one. The home is
// a temporary T3CODE_HOME, never ~/.t3. Needs no monorepo.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const { McpSession } = await import(
  NodeURL.pathToFileURL(NodePath.resolve(here, "../../conn-mcp/tools/mcp-client.mjs")).href
);

const binary = NodePath.resolve(process.argv[2] ?? "");
const freePort = () =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    // The server binds 0.0.0.0, so probe the same address.
    probe.listen(0, "0.0.0.0", () => {
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
const env = { ...process.env, T3CODE_HOME: home, DISABLE_AUTOUPDATER: "1" };
delete env.T3CODE_PORT;
delete env.T3CODE_HOST;

const step = (text) => console.log(`\n## ${text}`);
const ok = (text) => console.log(`ok   ${text}`);
const fail = (text) => {
  throw new Error(text);
};
const cli = (...args) =>
  NodeChildProcess.execFileSync(binary, args, { env, encoding: "utf8" }).trim();
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
NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "# workspace\n");
NodeChildProcess.execFileSync("git", ["add", "."], { cwd: workspace });
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
  { cwd: workspace },
);

step(`start: ${NodePath.basename(binary)} serve --host=0.0.0.0 --port=${port} --no-browser`);
const server = NodeChildProcess.spawn(
  binary,
  ["serve", "--host=0.0.0.0", `--port=${port}`, "--no-browser"],
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

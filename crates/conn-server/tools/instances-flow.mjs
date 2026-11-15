#!/usr/bin/env node
// Provider instances through the whole server: settings written before the first start (as
// Orbit writes them), a turn on each instance, a change through `server.updateSettings`, and
// the next session on the new values. No model is called and no real CLI runs: every instance
// points at a recording stub that writes its argv and environment and exits.
//
//   node crates/conn-server/tools/instances-flow.mjs <conn-server>
//
// Sealed: a temp T3CODE_HOME and HOME, only the shell variables node needs (no ANTHROPIC_*,
// CLAUDE_*, OPENAI_*, CODEX_* reach the server), the Claude status probe off. Needs `npm ci`
// in helpers/sdk-host (Claude runs through the SDK host). Exit 0 when every check passes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { sealedNodeEnv } from "../../../tools/sealed-env.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const { McpSession } = await import(
  NodeURL.pathToFileURL(NodePath.resolve(here, "../../conn-mcp/tools/mcp-client.mjs")).href
);

const binary = NodePath.resolve(process.argv[2] ?? "");
if (!NodeFS.existsSync(binary)) throw new Error("usage: instances-flow.mjs <conn-server>");
const freePort = () =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const port = await freePort();
const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-instances-")));
const env = {
  ...sealedNodeEnv(root),
  T3CODE_HOME: NodePath.join(root, ".t3"),
  CONN_CLAUDE_STATUS_PROBE: "off",
  // Codex is probed here: the default instance is off, and codexWork's stub answers the probe.
  CONN_CODEX_STATUS_PROBE: "on",
};
const home = env.HOME;
const workspace = NodePath.join(root, "workspace");
const origin = `http://127.0.0.1:${port}`;
const SECRET = "flow-sensitive-value";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${pass ? "" : `: ${detail}`}`);
  if (!pass) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cli = (...args) => NodeChildProcess.execFileSync(binary, args, { env, encoding: "utf8" }).trim();

/** A stub CLI in `~/stubs/<name>/` that records each start in `records/` and exits 1. */
const stub = (name) => {
  const dir = NodePath.join(home, "stubs", name);
  NodeFS.mkdirSync(NodePath.join(dir, "records"), { recursive: true });
  const script = NodePath.join(dir, name.startsWith("codex") ? "codex" : "claude");
  NodeFS.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `out=${JSON.stringify(NodePath.join(dir, "records"))}/$$.json`,
      `exec ${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), env: process.env}))' "$out" "$@"; exit 1`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { dir, script, tilde: `~/${NodePath.relative(home, script)}` };
};
/**
 * A stub `codex` that records each start in `records/` (pid, argv, environment, the methods
 * it got), answers the status probe's requests (`initialize`, `account/read`, `skills/list`,
 * `model/list`, `config/read`) as Orbit's router setup would (no sign-in), and exits 1 on any
 * thread call, as `stub` does.
 */
const codexStub = (name) => {
  const dir = NodePath.join(home, "stubs", name);
  NodeFS.mkdirSync(NodePath.join(dir, "records"), { recursive: true });
  const program = NodePath.join(dir, "stub.cjs");
  NodeFS.writeFileSync(
    program,
    `const fs = require("fs");
const out = ${JSON.stringify(NodePath.join(dir, "records"))} + "/" + process.pid + ".json";
const record = { pid: process.pid, argv: process.argv.slice(2), env: process.env, methods: [] };
const save = () => fs.writeFileSync(out, JSON.stringify(record));
save();
const answers = {
  initialize: { userAgent: "codex_cli_rs/0.166.0 (flow) T3 Code", codexHome: process.env.CODEX_HOME || "", platformFamily: "unix", platformOs: "macos" },
  "account/read": { account: null, requiresOpenaiAuth: false },
  "skills/list": { data: [] },
  "model/list": { data: [{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "gpt-6-luna", description: "", hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }] }], nextCursor: null },
  "config/read": { config: { model_provider: "orbit", model_providers: { orbit: { base_url: "http://router.orbit:8080/v1" } } }, origins: {} },
};
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  record.methods.push(message.method);
  save();
  if (message.id === undefined) return;
  if (!(message.method in answers)) process.exit(1);
  process.stdout.write(JSON.stringify({ id: message.id, result: answers[message.method] }) + "\\n");
});
process.stdin.on("end", () => process.exit(0));
`,
  );
  const script = NodePath.join(dir, "codex");
  NodeFS.writeFileSync(script, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`, { mode: 0o755 });
  return { dir, script, tilde: `~/${NodePath.relative(home, script)}` };
};
const records = (s) =>
  NodeFS.readdirSync(NodePath.join(s.dir, "records"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(NodeFS.readFileSync(NodePath.join(s.dir, "records", f), "utf8")));
/** The first start that is not a status probe (the probe alone sets `MISE_OFFLINE=1`). */
const waitRecord = async (s, label) => {
  for (let i = 0; i < 120; i++) {
    const found = records(s).filter((r) => r.env.MISE_OFFLINE !== "1");
    if (found.length > 0) return found[0];
    await sleep(500);
  }
  ok(`${label}: the stub started`, false, `nothing in ${s.dir}/records`);
  return undefined;
};

const claudeLow = stub("claude-low");
const claudeLowNext = stub("claude-low-next");
const codexWork = codexStub("codex-work");

// Files Orbit writes before the first start. The default instances are off, so no real CLI
// can run; the sensitive value moves to the secret store at start, as in T3.
NodeFS.mkdirSync(NodePath.join(env.T3CODE_HOME, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(env.T3CODE_HOME, "userdata", "settings.json"),
  JSON.stringify({
    providerInstances: {
      claudeAgent: { driver: "claudeAgent", enabled: false },
      codex: { driver: "codex", enabled: false },
      claudeLow: {
        driver: "claudeAgent",
        displayName: "Claude Low",
        config: { binaryPath: claudeLow.tilde },
        environment: [
          { name: "CONN_FLOW", value: "low-1" },
          { name: "CONN_FLOW_SECRET", value: SECRET, sensitive: true },
        ],
      },
      codexWork: {
        driver: "codex",
        config: { binaryPath: codexWork.script, homePath: "~/codex-work" },
        environment: [{ name: "CONN_FLOW", value: "work-1" }],
      },
    },
  }),
);
NodeFS.mkdirSync(workspace);
NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace, env });

const server = NodeChildProcess.spawn(binary, ["serve", "--host=127.0.0.1", `--port=${port}`, "--no-browser"], {
  env,
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (d) => (output += d));
server.stderr.on("data", (d) => (output += d));
const exited = new Promise((resolve) => server.on("exit", (code, signal) => resolve({ code, signal })));

try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await fetch(`${origin}/.well-known/t3/environment`).then((r) => r.ok).catch(() => false);
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error(`not ready:\n${output}`);
  const providersLine = output.split("\n").find((l) => l.startsWith("providers:")) ?? "";
  ok(
    "the instances in settings.json exist at start",
    ["claudeAgent", "codex", "claudeLow", "codexWork", "grok"].every((id) => providersLine.includes(id)),
    providersLine,
  );
  cli("project", "add", workspace, "--title", "Workspace");
  const token = cli("auth", "session", "issue", "--label", "instances-flow", "--token-only");

  // `server.updateSettings` and `server.refreshProviders` over the client socket.
  const { ticket } = await (
    await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?orchestrationProtocol=2&wsTicket=${ticket}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  socket.onmessage = (event) => {
    for (const line of String(event.data).split("\n").filter(Boolean)) {
      const parsed = JSON.parse(line);
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        if (message._tag === "Exit") pending.get(String(message.requestId))?.(message.exit);
        if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
      }
    }
  };
  let nextId = 1;
  const rpc = (tag, payload) =>
    new Promise((resolve) => {
      const id = String(nextId++);
      pending.set(id, resolve);
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });

  const providers = await rpc("server.refreshProviders", {});
  const listed = providers.value?.providers ?? [];
  const low = listed.find((p) => p.instanceId === "claudeLow");
  ok("claudeLow is listed with its display name", low?.displayName === "Claude Low", JSON.stringify(low));
  ok(
    "the disabled default Claude is listed disabled",
    listed.find((p) => p.instanceId === "claudeAgent")?.status === "disabled",
    JSON.stringify(listed.map((p) => [p.instanceId, p.status])),
  );
  ok(
    "the disabled default Codex is listed disabled",
    listed.find((p) => p.instanceId === "codex")?.status === "disabled",
    JSON.stringify(listed.map((p) => [p.instanceId, p.status])),
  );
  // codexWork is probed as T3 probes it: its own app-server, environment and home.
  const work = listed.find((p) => p.instanceId === "codexWork");
  ok(
    "codexWork: a probed entry (ready, the version, the models, the router endpoint)",
    work?.status === "ready" &&
      work.installed === true &&
      work.version === "0.166.0" &&
      work.models.some((m) => m.slug === "gpt-6-luna") &&
      work.auth?.endpoint === "http://router.orbit:8080" &&
      work.usageLimits?.unavailable?.reason === "unsupported",
    JSON.stringify(work ?? null).slice(0, 400),
  );
  const probes = records(codexWork).filter((r) => r.env.MISE_OFFLINE === "1");
  const probe = probes[0];
  ok(
    "codexWork: the probe ran its app-server with the instance environment and home",
    probe?.argv[0] === "app-server" &&
      probe.env.CONN_FLOW === "work-1" &&
      probe.env.CODEX_HOME === NodePath.join(home, "codex-work") &&
      probe.methods.slice(0, 3).join(",") === "initialize,initialized,account/read",
    JSON.stringify(probe ? { argv: probe.argv, methods: probe.methods } : null),
  );
  // The probe's app-server ends with the probe: an idle server keeps no Codex running.
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  ok(
    "codexWork: no probe app-server is left running",
    probes.length > 0 && probes.every((r) => !alive(r.pid)),
    JSON.stringify(probes.map((r) => [r.pid, alive(r.pid)])),
  );

  const mcp = new McpSession(origin, `Bearer ${token}`);
  await mcp.initialize();
  const projects = (await mcp.callTool("t3_project_list", {})).result.structuredContent;
  const project = projects.projects.find((p) => p.workspaceRoot === NodeFS.realpathSync(workspace));
  let request = 0;
  const launch = (instanceId, model) =>
    mcp.callTool("t3_thread_launch", {
      projectId: project.id,
      title: `instances ${instanceId}`,
      message: "Reply with exactly: ok",
      modelSelection: { instanceId, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      clientRequestId: `instances-${++request}`,
    });

  // A turn on each configured instance starts its stub with its environment.
  await launch("claudeLow", "claude-haiku-5-5");
  const lowRun = await waitRecord(claudeLow, "claudeLow");
  ok("claudeLow: the instance environment", lowRun?.env.CONN_FLOW === "low-1", lowRun?.env.CONN_FLOW);
  ok("claudeLow: the sensitive value reaches the CLI", lowRun?.env.CONN_FLOW_SECRET === SECRET);
  await launch("codexWork", "gpt-6-luna");
  const workRun = await waitRecord(codexWork, "codexWork");
  ok("codexWork: app-server", workRun?.argv[0] === "app-server", JSON.stringify(workRun?.argv));
  ok("codexWork: the instance environment", workRun?.env.CONN_FLOW === "work-1", workRun?.env.CONN_FLOW);
  ok(
    "codexWork: CODEX_HOME from homePath with ~",
    workRun?.env.CODEX_HOME === NodePath.join(home, "codex-work"),
    workRun?.env.CODEX_HOME,
  );

  // A disabled instance is refused at dispatch, and starts nothing.
  const refused = await launch("claudeAgent", "claude-haiku-5-5");
  ok(
    "a turn on the disabled claudeAgent is refused",
    refused.result?.isError === true &&
      (refused.result.content?.[0]?.text ?? "").includes('Provider instance \\"claudeAgent\\" is disabled'),
    JSON.stringify(refused).slice(0, 300),
  );

  // Change the instance while the server runs: the next session uses the new values.
  const updated = await rpc("server.updateSettings", {
    patch: {},
    providerInstanceMutation: {
      operation: "upsert",
      instanceId: "claudeLow",
      instance: {
        driver: "claudeAgent",
        displayName: "Claude Low",
        config: { binaryPath: claudeLowNext.script },
        environment: [{ name: "CONN_FLOW", value: "low-2" }],
      },
    },
  });
  ok("server.updateSettings", updated?._tag === "Success", JSON.stringify(updated).slice(0, 300));
  // The status task rebuilds the instance on the settings change.
  await sleep(1500);
  await launch("claudeLow", "claude-haiku-5-5");
  const nextRun = await waitRecord(claudeLowNext, "claudeLow after the change");
  ok("after the change: the new binary and environment", nextRun?.env.CONN_FLOW === "low-2", nextRun?.env.CONN_FLOW);
  ok("after the change: the removed variable is gone", nextRun !== undefined && !("CONN_FLOW_SECRET" in nextRun.env));

  // Removed while the server runs: the instance is gone.
  await rpc("server.updateSettings", {
    patch: {},
    providerInstanceMutation: { operation: "remove", instanceId: "codexWork" },
  });
  await sleep(1500);
  const after = (await rpc("server.refreshProviders", {})).value?.providers ?? [];
  ok("a removed instance leaves the provider list", !after.some((p) => p.instanceId === "codexWork"));
  socket.close();

  ok("the sensitive value is in no server output", !output.includes(SECRET));
} finally {
  server.kill("SIGTERM");
  const result = await Promise.race([exited, sleep(10_000).then(() => ({ code: "timeout" }))]);
  if (result.code === "timeout") server.kill("SIGKILL");
  NodeFS.rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "instances-flow: all checks passed" : `instances-flow: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

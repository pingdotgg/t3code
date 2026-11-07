#!/usr/bin/env node
// Runtime evidence driver for #15250 (native Codex child model lookup retries).
//
//   node run.mjs --checkout <server checkout> --out <dir> [--port 43831] [--rows R1,R2a,...]
//
// Starts a real T3 server from <checkout> against an isolated home under <out>, with
// the codex provider pointed at the STUBBED Codex app-server next to this file. Each
// row is one thread whose prompt names its fixture; all rows run in parallel. After
// the retry window it reads the subagent projection read-only, then stops only the
// server PID it spawned.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
if (!args.checkout || !args.out) {
  console.error(
    "usage: node run.mjs --checkout <server checkout> --out <dir> [--port N] [--rows R1,R3]",
  );
  process.exit(2);
}
const checkout = NodePath.resolve(args.checkout);
const out = NodePath.resolve(args.out);
const port = Number(args.port ?? 43831);
const windowMs = Number(args["window-ms"] ?? 100_000);

const ROWS = {
  R1: "first-ok",
  R2a: "retry-ok",
  R3: "always-fail",
  R3b: "always-hang",
  R4a: "interrupted",
  R5: "rerouted",
  R6: "read-empty-resume-ok",
};
const rows = (args.rows ?? "R1,R2a,R4a,R5,R6,R3b,R3").split(",");

const home = NodePath.join(out, "home");
const logs = NodePath.join(out, "requests");
const project = NodePath.join(out, "proj");
const fake = NodePath.join(out, "fake");
for (const dir of [home, NodePath.join(home, "userdata"), logs, project, fake])
  NodeFS.mkdirSync(dir, { recursive: true });
if (home.startsWith(NodePath.join(process.env.HOME ?? "/nonexistent", ".t3")))
  throw new Error("refusing live home");

const stub = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "stub-codex-app-server.mjs",
);
const launcher = NodePath.join(fake, "codex");
NodeFS.writeFileSync(
  launcher,
  `#!/bin/sh\n# STUBBED Codex app-server launcher\nEV_LOG_DIR=${JSON.stringify(logs)} exec node ${JSON.stringify(stub)} "$@"\n`,
);
NodeFS.chmodSync(launcher, 0o755);
NodeFS.writeFileSync(
  NodePath.join(home, "userdata", "settings.json"),
  JSON.stringify(
    {
      providerInstances: {
        codex: { driver: "codex", config: { setupMode: "existing", binaryPath: launcher } },
      },
    },
    null,
    2,
  ),
);
if (!NodeFS.existsSync(NodePath.join(project, ".git"))) {
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: project });
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "evidence project\n");
}

const bin = NodePath.join(checkout, "apps/server/src/bin.ts");
const cli = (cliArgs) =>
  NodeChildProcess.execFileSync("node", [bin, ...cliArgs, "--base-dir", home], {
    cwd: project,
    encoding: "utf8",
  });

const t0 = Date.now();
const stamp = (msg) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const serverLog = NodePath.join(out, "server.log");
const server = NodeChildProcess.spawn(
  "node",
  [
    bin,
    "start",
    "--base-dir",
    home,
    "--no-browser",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--auto-bootstrap-project-from-cwd",
  ],
  { cwd: project, stdio: ["ignore", "pipe", "pipe"] },
);
NodeFS.writeFileSync(NodePath.join(out, "server.pid"), String(server.pid));
const serverChunks = [];
server.stdout.on("data", (chunk) => serverChunks.push(chunk));
server.stderr.on("data", (chunk) => serverChunks.push(chunk));
stamp(`server pid ${server.pid} on 127.0.0.1:${port} (checkout ${checkout})`);

const stop = () => {
  if (server.exitCode === null) server.kill("SIGTERM");
  NodeFS.writeFileSync(serverLog, Buffer.concat(serverChunks));
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await sleep(1000);
  try {
    cli(["thread", "list"]);
    ready = true;
  } catch {}
}
if (!ready) throw new Error("server never became reachable; see server.log");
stamp("server reachable");

const threads = {};
for (const row of rows) {
  const fixture = ROWS[row];
  const outText = cli([
    "thread",
    "start",
    ".",
    `fixture=${fixture} (#15250 evidence ${row})`,
    "--provider",
    "codex",
    "--model",
    "gpt-5.4",
    "--json",
  ]);
  threads[row] = { fixture, start: outText.trim() };
  stamp(`${row} started (${fixture}): ${outText.trim().slice(0, 200)}`);
}

stamp(`waiting ${windowMs}ms for the retry window`);
await sleep(windowMs);

const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
  readOnly: true,
});
const subagents = db
  .prepare(
    `select subagent_id, json_extract(payload_json,'$.status') as status,
            json_extract(payload_json,'$.model') as model,
            json_extract(payload_json,'$.modelSelection') as modelSelection,
            json_extract(payload_json,'$.title') as title,
            payload_json
       from orchestration_v2_projection_subagents`,
  )
  .all();
// subagent.updated events are stored in orchestration_events at both SHAs.
const updatedEvents = db
  .prepare(
    `select occurred_at as at, json_extract(payload_json,'$.id') as id,
            json_extract(payload_json,'$.status') as status,
            json_extract(payload_json,'$.model') as model
       from orchestration_events where event_type = 'subagent.updated' order by sequence`,
  )
  .all();
db.close();

const results = {};
for (const row of rows) {
  const fixture = ROWS[row];
  const logPath = NodePath.join(logs, `req-${fixture}.ndjson`);
  const entries = NodeFS.existsSync(logPath)
    ? NodeFS.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const child = `child-${fixture}-`;
  const childRequests = entries.filter(
    (entry) => entry.dir === "in" && entry.threadId?.startsWith(child),
  );
  const spawnAt = entries.find(
    (entry) => entry.method === "item/completed" && entry.note === "started",
  )?.t;
  const projection = subagents.filter((s) => s.subagent_id.includes(child));
  const updates = updatedEvents.filter((e) => e.id.includes(child));
  results[row] = {
    fixture,
    child,
    reads: childRequests.filter((e) => e.method === "thread/read").length,
    resumes: childRequests.filter((e) => e.method === "thread/resume").length,
    requestTimesSec: childRequests.map(
      (e) => `${e.method === "thread/read" ? "R" : "S"}@${((e.t - spawnAt) / 1000).toFixed(2)}`,
    ),
    lastRequestSecAfterSpawn: childRequests.length
      ? ((childRequests.at(-1).t - spawnAt) / 1000).toFixed(2)
      : null,
    projection: projection.map(({ payload_json: _payload, ...rest }) => rest),
    subagentUpdatedEvents: updates.length,
    updateTimeline: updates.map((e) => `${e.at.slice(11, 23)} ${e.status} model=${e.model}`),
  };
}
NodeFS.writeFileSync(
  NodePath.join(out, "results.json"),
  JSON.stringify({ checkout, port, threads, results }, null, 2),
);
console.log(JSON.stringify(results, null, 2));
stop();
await new Promise((done) => (server.exitCode === null ? server.once("exit", done) : done()));
stamp(`server pid ${server.pid} exited (${server.exitCode ?? server.signalCode})`);

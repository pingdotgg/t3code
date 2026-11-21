#!/usr/bin/env node
// Proves the T3 import (`conn-engine/src/t3_import.rs`) on a copy of a real T3 home: the T3
// server and the Conn Server each start on their own clone of the same `userdata`, and the
// check compares what a client reads from both.
//
//   node crates/conn-server/tools/t3-import-diff.mjs <conn-server> <userdata copy> [--keep] [--limit N]
//
// <userdata copy> is a COPY of `~/.t3/userdata` (make `statev2.sqlite` with sqlite's `.backup`;
// never pass a live T3 home). It is not changed: each server gets an APFS clone (`cp -c`) of it
// in a sibling folder. Compared, after the snapshot sequences are dropped:
//
// - `/.well-known/t3/environment`: the environment id.
// - `GET /api/orchestration/shell`: the projects and the thread rows.
// - `GET /api/orchestration/threads/:id` for every thread in the T3 shell: the whole projection
//   (thread, runs, attempts, nodes, subagents, provider rows, runtime requests, messages, plans,
//   turn items, visible turn items, checkpoints, context handoffs and transfers).
// - `server.getConfig` over `/ws`: the settings and the keybindings.
//
// Differences in KNOWN are counted with their reason and do not fail the check. Anything else
// exits 1. No model is called: both servers run with an empty HOME and a PATH without provider
// CLIs, so no provider starts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { importSource, monorepo, packageImporter } from "../../../tools/monorepo.mjs";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const option = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const limit = Number(option("--limit") ?? Infinity);
// `--reuse <dir>`: the folder a `--keep` run left; both servers start on its homes again.
const reuse = option("--reuse");
const [binary, source] = argv.filter((a, i) => !a.startsWith("--") && !["--limit", "--reuse"].includes(argv[i - 1]));
if (!binary || !source || !NodeFS.existsSync(NodePath.join(source, "statev2.sqlite"))) {
  console.error("usage: t3-import-diff.mjs <conn-server> <userdata copy with statev2.sqlite> [--keep] [--limit N]");
  process.exit(2);
}
if (NodePath.resolve(source) === NodePath.join(process.env.HOME ?? "", ".t3", "userdata")) {
  console.error("refusing a live T3 home: pass a copy");
  process.exit(2);
}
const MONOREPO = monorepo();
const T3_BIN = NodePath.join(MONOREPO, "apps/server/src/bin.ts");
const root = reuse ?? NodeFS.mkdtempSync(NodePath.join(NodePath.dirname(NodePath.resolve(source)), "t3-import-diff-"));
const dumps = NodePath.join(root, "differing");

// What a client holds after it reads a projection: T3's wire projection (idempotent; T3
// applies it on every read, this server's HTTP route does not, for any thread), then the
// contract's decode, which fills the defaults of fields an older row lacks.
const contracts = await importSource("packages/contracts/src/orchestrationV2.ts");
const Schema = await packageImporter("packages/contracts")("effect/Schema");
const wire = await importSource("apps/server/src/orchestration-v2/WireProjection.ts");
const projectionCodec = Schema.toCodecJson(contracts.OrchestrationV2ThreadProjection);
const decodeProjection = Schema.decodeUnknownSync(projectionCodec);
const encodeProjection = Schema.encodeSync(projectionCodec);
const clientView = (projection) => encodeProjection(wire.projectThreadProjectionForWire(decodeProjection(projection)));
const shellCodec = Schema.toCodecJson(contracts.OrchestrationV2ThreadShell);
const shellView = (row) => Schema.encodeSync(shellCodec)(Schema.decodeUnknownSync(shellCodec)(row));
const settingsModule = await importSource("packages/contracts/src/settings.ts");
const settingsCodec = Schema.toCodecJson(settingsModule.ServerSettings);
const settingsView = (settings) => Schema.encodeSync(settingsCodec)(Schema.decodeUnknownSync(settingsCodec)(settings));

// The newest time the copy holds. A row stamped later was written by a server after it
// started on the copy (restart recovery of runs that were live when the copy was taken),
// not read from the copy.
const copyInstant = NodeChildProcess.execFileSync("sqlite3", [
  `file:${NodePath.resolve(source, "statev2.sqlite")}?mode=ro&immutable=1`,
  `SELECT MAX(t) FROM (SELECT MAX(updated_at) AS t FROM orchestration_v2_projection_threads
     UNION ALL SELECT MAX(COALESCE(completed_at, requested_at)) FROM orchestration_v2_projection_runs
     UNION ALL SELECT MAX(updated_at) FROM orchestration_v2_projection_turn_items)`,
], { encoding: "utf8" }).trim();
const ISO = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g;
const changedAfterCopy = (...bodies) =>
  bodies.some((body) => [...JSON.stringify(body ?? null).matchAll(ISO)].some((m) => m[1] > copyInstant));

/**
 * Differences that do not fail the check: a JSON path pattern and the reason. None of them
 * comes from the import: each holds for any thread this server serves, and the import keeps
 * the rows each is computed from.
 */
const KNOWN = [
  {
    path: /^thread\[[^\]]*\]\.projection\.thread\.opens\.score$|^shell\.threads\.opens\.score$/,
    reason: "a float differs in its last digit: serde_json reads JSON numbers without `float_roundtrip` (the thread's open-rank score; every stored float)",
  },
  {
    path: /^shell\.threads\.tags$/,
    reason: "the shell row has `tags: []` where T3 leaves an empty `tags` out (`shell.rs`, every thread)",
  },
  {
    path: /^shell\.threads\.visibleItemCount$/,
    reason: "a run fork's shell counts only its own items; T3 adds the inherited prefix (`visibleItemCountForShell`; every fork)",
  },
  {
    path: /^shell\.threads\.latestRunStopRequested$/,
    reason: "the shell row says `latestRunStopRequested: false`; T3 reads the run's stop request (`shell.rs`, every thread)",
  },
  {
    path: /\.input\.summary$/,
    reason: "T3's wire summary of a dynamic tool's input is that object as text; this server keeps object keys sorted (serde_json), so the text lists the same keys in another order",
  },
  {
    path: /^shell\.threads\.latestRunBackgroundWake$/,
    reason: "the shell row says `latestRunBackgroundWake: false`; T3 reads the run (`shell.rs`, every thread)",
  },
  {
    path: /^shell\.threads\.activeOrderKey$/,
    reason: "a field the stored thread lacks is `null` in the shell row; T3 leaves it out (`shell.rs` `field`, every thread)",
  },
  {
    path: /^shell\.threads\.latestUserAuthoredMessageAt$/,
    reason: "the shell row reads only the newest user message and is null when an agent wrote it; T3 takes the newest message a user wrote (`shell.rs`, every thread)",
  },
  {
    path: /^shell\.threads\.pendingRuntimeRequest$/,
    reason: "the shell row shows a waiting secret card only; T3 also shows a waiting link card (`waitsOnUser`; every thread)",
  },
  {
    path: /^shell\.projects\.repositoryIdentity$/,
    reason: "T3 resolves a project's git remote for its shell row; this server does not (every project)",
  },
];

const freePort = () =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const children = [];
const stopAll = () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
};
process.on("exit", stopAll);

async function start(name) {
  const home = NodePath.join(root, name);
  const userdata = NodePath.join(home, ".t3", "userdata");
  if (!reuse) {
    NodeFS.mkdirSync(NodePath.dirname(userdata), { recursive: true });
    NodeChildProcess.execFileSync("cp", ["-c", "-R", NodePath.resolve(source), userdata]);
  }
  NodeFS.rmSync(NodePath.join(userdata, "server-runtime.json"), { force: true });
  const port = await freePort();
  const isT3 = name === "t3";
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/sh",
    TMPDIR: NodeFS.mkdtempSync(NodePath.join(root, `${name}-tmp-`)),
    T3CODE_HOME: NodePath.join(home, ".t3"),
    DISABLE_AUTOUPDATER: "1",
  };
  const cli = (args) =>
    isT3
      ? NodeChildProcess.spawnSync(process.execPath, [T3_BIN, ...args, "--base-dir", env.T3CODE_HOME], {
          env, cwd: home, encoding: "utf8",
        })
      : NodeChildProcess.spawnSync(NodePath.resolve(binary), [...args, "--state-dir", userdata], {
          env, cwd: home, encoding: "utf8",
        });
  const command = isT3
    ? [process.execPath, T3_BIN, "serve", "--base-dir", env.T3CODE_HOME]
    : [NodePath.resolve(binary), "serve", "--state-dir", userdata];
  const log = NodeFS.openSync(NodePath.join(root, `${name}.log`), "w");
  const started = Date.now();
  const child = NodeChildProcess.spawn(
    command[0],
    [...command.slice(1), "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
    { env, cwd: home, stdio: ["ignore", log, log] },
  );
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}; see ${root}/${name}.log`);
    const ok = await fetch(`${origin}/.well-known/t3/environment`).then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const ready = Date.now() - started;
  const issued = cli(["auth", "session", "issue", "--scope", "orchestration:read", "--scope", "access:read", "--ttl", "1h", "--label", "t3 import diff", "--token-only"]);
  if (issued.status !== 0) throw new Error(`${name} auth issue: ${issued.stderr}`);
  const token = issued.stdout.trim();
  return { name, origin, token, ready, child };
}

async function get(side, path) {
  const response = await fetch(`${side.origin}${path}`, {
    headers: { authorization: `Bearer ${side.token}`, "x-t3-orchestration-protocol": "2" },
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

async function rpc(side, tag, payload) {
  const ticket = await fetch(`${side.origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${side.token}` },
  }).then((r) => r.json());
  const socket = new WebSocket(
    `${side.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  );
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`${side.name} refused the socket`));
  });
  const value = await new Promise((resolve, reject) => {
    socket.onmessage = (event) => {
      for (const line of String(event.data).split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
        if (frame._tag === "Exit" && String(frame.requestId) === "1") {
          frame.exit._tag === "Success" ? resolve(frame.exit.value) : reject(new Error(JSON.stringify(frame.exit)));
        }
      }
    };
    socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
  });
  socket.close();
  return value;
}

/** Paths where two JSON values differ, at most `max`. */
function diff(a, b, path = "", out = [], max = 20) {
  if (out.length >= max) return out;
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object" || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path, t3: a, conn: b });
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ path: `${path}.length`, t3: a.length, conn: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out, max);
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(key in a)) out.push({ path: `${path}.${key}`, t3: undefined, conn: b[key] });
    else if (!(key in b)) out.push({ path: `${path}.${key}`, t3: a[key], conn: undefined });
    else diff(a[key], b[key], `${path}.${key}`, out, max);
  }
  return out;
}

const known = (path) => KNOWN.find((k) => k.path.test(path));
const RESTART =
  "the thread holds rows stamped after the copy was taken: each server's restart recovery changed it (runs live at the copy), so it is not compared";
const failures = [];
let sourceSideTransfers = 0;
const knownSeen = new Map();
function compare(label, a, b) {
  for (const d of diff(a, b)) {
    const k = known(`${label}${d.path}`);
    if (k) knownSeen.set(k.reason, (knownSeen.get(k.reason) ?? 0) + 1);
    else failures.push({ label, ...d });
  }
}
const short = (v) => {
  const text = JSON.stringify(v);
  return text === undefined ? "undefined" : text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

let rowCheck = false;
/**
 * Byte for byte, straight from the two files: every T3 projection row against the engine row
 * with its id. Rows of threads a server changed after it started (restart recovery) are
 * counted apart.
 */
function checkRows() {
  const engine = NodePath.join(root, "conn", ".t3", "userdata", "engine.sqlite");
  const t3 = NodePath.resolve(source, "statev2.sqlite");
  const tables = [
    ["runs", "orchestration_v2_projection_runs", "run_id", "t.thread_id"],
    ["attempts", "orchestration_v2_projection_run_attempts", "attempt_id", "t.thread_id"],
    ["nodes", "orchestration_v2_projection_nodes", "node_id", "t.thread_id"],
    ["subagents", "orchestration_v2_projection_subagents", "subagent_id", "t.thread_id"],
    ["providerThreads", "orchestration_v2_projection_provider_threads", "provider_thread_id",
      "COALESCE(t.thread_id, (SELECT n.thread_id FROM t3.orchestration_v2_projection_nodes n WHERE n.node_id = t.owner_node_id))"],
    ["providerTurns", "orchestration_v2_projection_provider_turns", "provider_turn_id", "t.thread_id"],
    ["runtimeRequests", "orchestration_v2_projection_runtime_requests", "runtime_request_id", "t.thread_id"],
    ["messages", "orchestration_v2_projection_messages", "message_id", "t.thread_id"],
    ["plans", "orchestration_v2_projection_plans", "plan_id", "t.thread_id"],
    ["turnItems", "orchestration_v2_projection_turn_items", "turn_item_id", "t.thread_id"],
    ["checkpointScopes", "orchestration_v2_projection_checkpoint_scopes", "scope_id", "t.thread_id"],
    ["checkpoints", "orchestration_v2_projection_checkpoints", "checkpoint_id", "t.thread_id"],
    ["contextHandoffs", "orchestration_v2_projection_context_handoffs", "context_handoff_id", "t.thread_id"],
    ["contextTransfers", "orchestration_v2_projection_context_transfers", "context_transfer_id", "t.target_thread_id"],
  ];
  // A thread is "changed" only on evidence that the running server wrote to it: an event in
  // this engine's log (the import writes none) or a row stored above the import boundary.
  // The difference under test never counts as that evidence.
  const sql = [
    `ATTACH 'file:${t3}?mode=ro&immutable=1' AS t3;`,
    `CREATE TEMP TABLE changed AS SELECT DISTINCT thread_id FROM events
       UNION SELECT DISTINCT thread_id FROM entities WHERE seq > (SELECT value FROM meta WHERE key = 'imported_through');`,
    `SELECT 'threads', count(*), sum(t.payload_json = e.thread), sum(e.id IS NULL), sum(t.payload_json != e.thread AND t.thread_id IN (SELECT thread_id FROM changed)) FROM t3.orchestration_v2_projection_threads t LEFT JOIN threads e ON e.id = t.thread_id;`,
    ...tables.map(([kind, table, id, thread]) =>
      `SELECT '${kind}', count(*), sum(t.payload_json = e.body), sum(e.id IS NULL), sum(t.payload_json != e.body AND ${thread} IN (SELECT thread_id FROM changed)) FROM t3.${table} t LEFT JOIN entities e ON e.thread_id = ${thread} AND e.kind = '${kind}' AND e.id = t.${id};`),
    `SELECT 'providerSessions', count(*), sum(s.payload_json = e.body), sum(e.id IS NULL), sum(s.payload_json != e.body AND b.thread_id IN (SELECT thread_id FROM changed)) FROM t3.orchestration_v2_projection_provider_session_bindings b JOIN t3.orchestration_v2_projection_provider_sessions s USING (provider_session_id) LEFT JOIN entities e ON e.thread_id = b.thread_id AND e.kind = 'providerSessions' AND e.id = b.provider_session_id;`,
  ].join("\n");
  const out = NodeChildProcess.execFileSync("sqlite3", ["-separator", " ", `file:${engine}?mode=ro`], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  console.log("rows, byte for byte (T3 rows / identical / missing / changed by restart recovery):");
  let lost = 0;
  let unexplained = 0;
  for (const line of out.trim().split("\n")) {
    const [kind, total, same, missing, recovered] = line.split(" ");
    const n = (v) => Number(v || 0);
    console.log(`  ${kind}: ${total} / ${n(same)} / ${n(missing)} / ${n(recovered)}`);
    lost += n(missing);
    unexplained += n(total) - n(same) - n(missing) - n(recovered);
  }
  if (lost > 0 || unexplained > 0) {
    console.log(`ROWS: ${lost} missing, ${unexplained} changed outside restart recovery`);
    process.exitCode = 1;
  } else {
    console.log("rows: none missing, none changed outside restart recovery");
  }
}

const COLLECTIONS = [
  "runs", "attempts", "nodes", "subagents", "providerSessions", "providerThreads", "providerTurns",
  "runtimeRequests", "messages", "plans", "turnItems", "visibleTurnItems", "checkpointScopes",
  "checkpoints", "contextHandoffs", "contextTransfers",
];

try {
  const [t3, conn] = await Promise.all([start("t3"), start("conn")]);
  console.log(`ready: t3 ${t3.ready} ms, conn ${conn.ready} ms (includes the import)`);
  const importLine = NodeFS.readFileSync(NodePath.join(root, "conn.log"), "utf8")
    .split("\n").find((line) => line.includes("imported the T3 server's state"));
  console.log(importLine ?? "conn: no import line in the log");

  const [te, ce] = await Promise.all([get(t3, "/.well-known/t3/environment"), get(conn, "/.well-known/t3/environment")]);
  compare("environment.environmentId", te.body.environmentId, ce.body.environmentId);

  const [ts, cs] = await Promise.all([get(t3, "/api/orchestration/shell"), get(conn, "/api/orchestration/shell")]);
  const byId = (rows) => [...rows].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const compareRows = (label, a, b) => {
    const left = new Map(a.map((row) => [row.id, row]));
    const right = new Map(b.map((row) => [row.id, row]));
    for (const id of new Set([...left.keys(), ...right.keys()])) {
      const l = left.get(id);
      const r = right.get(id);
      if (changedAfterCopy(l, r)) {
        knownSeen.set(RESTART, (knownSeen.get(RESTART) ?? 0) + 1);
        continue;
      }
      for (const d of diff(l, r)) {
        const path = `${label}${d.path}`;
        const k = known(path);
        if (k) knownSeen.set(k.reason, (knownSeen.get(k.reason) ?? 0) + 1);
        else failures.push({ label: `${label}[${id}]`, ...d });
      }
    }
  };
  compareRows("shell.projects", ts.body.projects, cs.body.projects);
  compareRows("shell.threads", ts.body.threads.map(shellView), cs.body.threads.map(shellView));
  compareRows("shell.archivedThreads", (ts.body.archivedThreads ?? []).map(shellView), (cs.body.archivedThreads ?? []).map(shellView));
  console.log(`shell: t3 ${ts.body.projects.length} projects, ${ts.body.threads.length} threads; conn ${cs.body.projects.length} projects, ${cs.body.threads.length} threads`);

  const ids = byId(ts.body.threads).map((t) => t.id).slice(0, limit);
  const totals = { t3: {}, conn: {} };
  let compared = 0;
  const work = [...ids];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let id = work.shift(); id !== undefined; id = work.shift()) {
        const [tp, cp] = await Promise.all([get(t3, `/api/orchestration/threads/${encodeURIComponent(id)}`), get(conn, `/api/orchestration/threads/${encodeURIComponent(id)}`)]);
        compare(`thread[${id}].status`, tp.status, cp.status);
        const t = tp.body?.projection ?? tp.body;
        const c = cp.body?.projection ?? cp.body;
        for (const kind of COLLECTIONS) {
          totals.t3[kind] = (totals.t3[kind] ?? 0) + (t?.[kind]?.length ?? 0);
          totals.conn[kind] = (totals.conn[kind] ?? 0) + (c?.[kind]?.length ?? 0);
        }
        const strip = (body, side) => {
          if (body === null || typeof body !== "object" || body.projection === undefined) return body;
          const projection = clientView(body.projection);
          // T3 lists a context transfer on its source thread too; this engine files it on the
          // target thread only (`fork.rs`, `merge_back.rs`). Each is compared on its target.
          if (side === "t3") {
            const all = projection.contextTransfers;
            projection.contextTransfers = all.filter((x) => x.targetThreadId === id);
            sourceSideTransfers += all.length - projection.contextTransfers.length;
          }
          // Provider threads in T3's order: this engine appends the subagents' after its own.
          projection.providerThreads = [...projection.providerThreads].sort(
            (a, b) => (a.firstRunOrdinal ?? 0) - (b.firstRunOrdinal ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
          return { projection };
        };
        if (changedAfterCopy(tp.body, cp.body)) {
          knownSeen.set(RESTART, (knownSeen.get(RESTART) ?? 0) + 1);
          compared++;
          continue;
        }
        const before = failures.length;
        compare(`thread[${id}]`, strip(tp.body, "t3"), strip(cp.body, "conn"));
        if (failures.length > before && NodeFS.readdirSync(root).length < 200) {
          NodeFS.mkdirSync(dumps, { recursive: true });
          if (NodeFS.readdirSync(dumps).length < 80) {
            const file = encodeURIComponent(id).slice(0, 120);
            NodeFS.writeFileSync(NodePath.join(dumps, `${file}.t3.json`), JSON.stringify(tp.body, null, 1));
            NodeFS.writeFileSync(NodePath.join(dumps, `${file}.conn.json`), JSON.stringify(cp.body, null, 1));
          }
        }
        compared++;
        if (compared % 100 === 0) console.log(`  ${compared}/${ids.length} threads`);
      }
    }),
  );
  console.log(`threads compared: ${compared}`);
  console.log("rows (t3 / conn):");
  for (const kind of COLLECTIONS) console.log(`  ${kind}: ${totals.t3[kind]} / ${totals.conn[kind]}`);

  const [tconf, cconf] = await Promise.all([rpc(t3, "server.getConfig", {}), rpc(conn, "server.getConfig", {})]);
  compare("config.settings", settingsView(tconf.settings), settingsView(cconf.settings));
  compare("config.keybindings", tconf.keybindings, cconf.keybindings);
  console.log(`settings keys: t3 ${Object.keys(tconf.settings ?? {}).length}, conn ${Object.keys(cconf.settings ?? {}).length}; keybindings: t3 ${tconf.keybindings?.length}, conn ${cconf.keybindings?.length}`);

  NodeFS.writeFileSync(NodePath.join(root, "config.t3.json"), JSON.stringify(tconf, null, 1));
  NodeFS.writeFileSync(NodePath.join(root, "config.conn.json"), JSON.stringify(cconf, null, 1));
  NodeFS.writeFileSync(NodePath.join(root, "shell.t3.json"), JSON.stringify(ts.body, null, 1));
  NodeFS.writeFileSync(NodePath.join(root, "shell.conn.json"), JSON.stringify(cs.body, null, 1));
  console.log(`copy instant: ${copyInstant}`);
  console.log(`context transfers T3 also lists on their source thread (compared on the target): ${sourceSideTransfers}`);
  for (const [reason, count] of knownSeen) console.log(`known (${count}): ${reason}`);
  if (failures.length > 0) {
    const byLabel = new Map();
    for (const f of failures) {
      const key = f.label.replace(/\[[^\]]*\]/g, "[*]") + f.path.replace(/\[\d+\]/g, "[*]");
      if (!byLabel.has(key)) byLabel.set(key, { count: 0, example: f });
      byLabel.get(key).count++;
    }
    console.log(`DIFFERENCES: ${failures.length}`);
    for (const [key, { count, example }] of [...byLabel].sort((x, y) => y[1].count - x[1].count)) {
      console.log(`  ${count}× ${key}\n     e.g. ${example.label}${example.path}: t3 ${short(example.t3)} | conn ${short(example.conn)}`);
    }
    process.exitCode = 1;
  } else {
    console.log("no differences");
  }
  rowCheck = true;
} finally {
  stopAll();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (rowCheck) checkRows();
  if (keep || reuse) console.log(`kept: ${root}`);
  else NodeFS.rmSync(root, { recursive: true, force: true });
}

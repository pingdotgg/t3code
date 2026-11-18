#!/usr/bin/env node
// Orbit's idle check against the T3 server and the Conn Server, in the same states.
//
//   node crates/conn-server/tools/idle-diff.mjs [--keep] [--info] [--only a,b] <conn-server>
//
// Orbit decides whether a container may sleep from one `GET /api/orchestration/shell` with
// `x-t3-orchestration-protocol: 2` (`ConnAgentActivity.php`), and the Gateway's thread index
// reads the same route (`ConnThreadIndex.php` through `HttpT3ServerClient.php`). A wrong
// "idle" freezes a container in the middle of a turn; a wrong "active" keeps it awake.
//
// Each scenario starts a pair: the T3 server from the monorepo (its own temp T3CODE_HOME and
// a free port) and the Conn Server (a temp `--state-dir`). Both run Codex through the stub of
// the Codex conformance check (`crates/conn-provider-codex/tools/codex-stub.mjs`), found as
// `codex` on a PATH that holds only the stub and the system folders. The stub replays a
// recorded T3 test-kit transcript (or one derived from it) and holds a turn open at a replay
// gate. No model is called and no real provider CLI runs. Both servers are driven the same
// way, through `/mcp`.
//
// In each state the tool reads the route as Orbit does and compares:
// - the Orbit view: exactly the fields Orbit reads, and Orbit's own verdicts (a turn works, a
//   request waits for the user). A difference fails the check.
// - the HTTP status and content type, and on a refusal the `reason` Orbit logs. A difference
//   fails the check.
// - the rest of each thread row after ids and timestamps are replaced: listed as `info`, never
//   a failure (the client, not Orbit, reads those fields).
// Every process gets a sealed environment and a temp HOME; every process is stopped by PID.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { McpSession, oauthMcpToken, pairBearer } from "../../conn-mcp/tools/mcp-client.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";
import { sealedEnv, sealedNodeEnv } from "../../../tools/sealed-env.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const STUB = NodePath.resolve(HERE, "../../conn-provider-codex/tools/codex-stub.mjs");

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const onlyAt = argv.indexOf("--only");
const only = onlyAt === -1 ? undefined : (argv[onlyAt + 1] ?? "").split(",");
const binaryArg = argv.find((a, i) => !a.startsWith("--") && (onlyAt === -1 || i !== onlyAt + 1));
if (binaryArg === undefined) {
  console.error("usage: idle-diff.mjs [--keep] [--info] [--only a,b] <conn-server>");
  process.exit(2);
}
const rustBinary = NodePath.resolve(binaryArg);
const MONOREPO = monorepo();
const FIXTURES = NodePath.join(MONOREPO, "apps/server/src/orchestration-v2/testkit/fixtures");
/** How many server pairs run at once: each T3 server is a Node process of about 300 MiB. */
const PARALLEL = Number(process.env.IDLE_DIFF_PARALLEL ?? 4);

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-idle-diff-")));
/** Every server we started: stopped by PID (its process group, so its stub children go too). */
const servers = new Set();
function stopAll() {
  for (const child of servers) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
}
process.once("exit", () => {
  stopAll();
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(130));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// ---------------------------------------------------------------------------------------
// Transcripts

const readEntries = (file) =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
const fixture = (name) => NodePath.join(FIXTURES, name, "codex_transcript.ndjson");
const writeEntries = (name, entries) => {
  const file = NodePath.join(root, "transcripts", `${name}.ndjson`);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return file;
};

/** `simple`, with the turn completed as failed (Codex's `turn.status: "failed"`). */
function failedTranscript() {
  const entries = readEntries(fixture("simple")).map((entry) => {
    if (entry.type !== "emit_inbound" || entry.frame?.method !== "turn/completed") return entry;
    const frame = structuredClone(entry.frame);
    frame.params.turn.status = "failed";
    frame.params.turn.error = {
      message: "idle-diff: the stub failed this turn",
      codexErrorInfo: null,
      additionalDetails: null,
    };
    return { ...entry, frame };
  });
  return writeEntries("failed", entries);
}

/**
 * `subagent_v2`, with the subagent ending after the root turn: the child's last status change
 * and turn end, and the root's subagent items that report them, move behind the root's
 * `turn/completed`, under the gate label `child-end`. So the root turn ends while its subagent
 * still runs.
 */
function backgroundTranscript() {
  const entries = readEntries(fixture("subagent_v2"));
  const rootId = entries.find((e) => e.frame?.result?.thread?.id)?.frame.result.thread.id;
  const isRootDone = (e) => e.frame?.method === "turn/completed" && e.frame.params?.threadId === rootId;
  const isChildDone = (e) =>
    e.frame?.method === "turn/completed" && e.frame.params?.threadId !== rootId;
  const childDone = entries.findIndex(isChildDone);
  const rootDone = entries.findIndex(isRootDone);
  if (childDone < 1 || rootDone < childDone) throw new Error("subagent_v2 changed shape");
  const moved = [];
  const kept = [];
  entries.forEach((entry, i) => {
    const item = entry.frame?.params?.item?.type;
    const late =
      i === childDone ||
      (i === childDone - 1 && entry.frame?.method === "thread/status/changed") ||
      (i > childDone &&
        i < rootDone &&
        entry.type === "emit_inbound" &&
        (item === "subAgentActivity" || item === "collabAgentToolCall"));
    (late ? moved : kept).push(late ? { ...entry, label: "child-end" } : entry);
  });
  const at = kept.findIndex(isRootDone) + 1;
  kept.splice(at, 0, ...moved);
  // T3 wakes the root agent when its background work ends (a new turn): `simple`'s turn, on
  // the root thread, under the gate label `wake` until its end.
  const simple = readEntries(fixture("simple"));
  const simpleId = simple.find((e) => e.frame?.result?.thread?.id)?.frame.result.thread.id;
  const from = simple.findIndex((e) => e.type === "expect_outbound" && e.frame?.method === "turn/start");
  const to = simple.findIndex((e) => e.frame?.method === "turn/completed");
  const wake = simple.slice(from, to + 1).map((entry) => {
    const copy = JSON.parse(JSON.stringify(entry).split(simpleId).join(rootId));
    return entry.frame?.method === "turn/completed" ? { ...copy, label: "wake" } : copy;
  });
  const exit = kept.findIndex((e) => e.type === "runtime_exit");
  kept.splice(exit === -1 ? kept.length : exit, 0, ...wake);
  return writeEntries("background", kept);
}

// ---------------------------------------------------------------------------------------
// One server pair

const transcriptVersion = (file) => readEntries(file).find((e) => e.type === "transcript_start")?.version;

/** The folder, stub, PATH and stand-in login shell of one server. */
function prepareSide(dir, transcript, gates) {
  const bin = NodePath.join(dir, "bin");
  const gateDir = NodePath.join(dir, "gates");
  for (const d of [bin, gateDir, NodePath.join(dir, "shell")]) NodeFS.mkdirSync(d, { recursive: true });
  const config = NodePath.join(dir, "stub.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      transcript,
      log: NodePath.join(dir, "stub.log"),
      gates,
      gateDir,
      probes: true,
      logEnv: false,
      version: transcriptVersion(transcript),
      lingerMs: 200,
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "codex"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} --stub-config ${JSON.stringify(config)} "$@"\n`,
    { mode: 0o755 },
  );
  // The real `codex` can never be found: the PATH holds the stub and the system folders only.
  const path = `${bin}:/usr/bin:/bin`;
  // Both servers read PATH from the login shell at start (`fixPath`): a stand-in that reads
  // no profile, so neither the user's shell nor its files run.
  const shell = NodePath.join(dir, "shell", "sh");
  NodeFS.writeFileSync(
    shell,
    ["#!/bin/sh", `PATH=${JSON.stringify(path)}; export PATH`, 'for arg; do command="$arg"; done', 'exec /bin/sh -c "$command"', ""].join("\n"),
    { mode: 0o755 },
  );
  const home = NodePath.join(dir, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const project = NodePath.join(dir, "work");
  NodeFS.mkdirSync(project);
  // Git reads no user or system config of this machine.
  const gitEnv = { PATH: path, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: project, env: gitEnv });
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=i", "-c", "user.email=i@i", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: project, env: gitEnv },
  );
  return { dir, path, loginShell: shell, project, gateDir, home };
}

/** Variables neither server may pass to the stub: the T3 server gets none of them either. */
const PROVIDER_VARIABLES = /^(CODEX_\w+|OPENAI_\w+|T3CODE_\w+)$/;

class Side {
  constructor(kind, dir, transcript, gates) {
    this.kind = kind;
    this.name = kind === "ts" ? "T3" : "Conn";
    Object.assign(this, prepareSide(dir, transcript, gates));
    this.out = NodePath.join(dir, "server.out");
    if (kind === "ts") {
      // No provider update check (registry.npmjs.org) and no model-manifest fetch from GitHub.
      const userdata = NodePath.join(dir, "base", "userdata");
      NodeFS.mkdirSync(userdata, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(userdata, "settings.json"), JSON.stringify({ enableProviderUpdateChecks: false }));
    }
  }

  env() {
    const common = { PATH: this.path, SHELL: this.loginShell, GIT_CONFIG_NOSYSTEM: "1" };
    if (this.kind === "ts") {
      const base = NodePath.join(this.dir, "base");
      // No telemetry to ingest.t3.codes (AnalyticsService.ts reads T3CODE_TELEMETRY_ENABLED).
      return {
        ...sealedNodeEnv(this.dir),
        ...common,
        T3CODE_HOME: base,
        T3CODE_NO_BROWSER: "1",
        T3CODE_TELEMETRY_ENABLED: "false",
      };
    }
    const env = Object.fromEntries(
      Object.entries(sealedEnv(this.dir)).filter(([name]) => !PROVIDER_VARIABLES.test(name)),
    );
    return { ...env, ...common };
  }

  command(port) {
    if (this.kind === "ts") {
      return [
        process.execPath,
        [
          GUARD_ARG,
          NodePath.join(MONOREPO, "apps/server/src/bin.ts"),
          // `t3 serve`, as Orbit's `t3.service` starts it: no project from the folder it runs in.
          "serve",
          "--no-browser",
          "--port",
          String(port),
          "--host",
          "127.0.0.1",
          "--base-dir",
          NodePath.join(this.dir, "base"),
        ],
      ];
    }
    return [rustBinary, ["serve", "--listen", `127.0.0.1:${port}`, "--state-dir", NodePath.join(this.dir, "state")]];
  }

  /** `t3 project add <path> --title <name>`, as Orbit's `clone-t3` adds the workspace. */
  addProject() {
    const [command, args] =
      this.kind === "ts"
        ? [process.execPath, [GUARD_ARG, NodePath.join(MONOREPO, "apps/server/src/bin.ts"), "project", "add", this.project, "--title", "work", "--base-dir", NodePath.join(this.dir, "base")]]
        : [rustBinary, ["project", "add", this.project, "--title", "work", "--state-dir", NodePath.join(this.dir, "state")]];
    const out = NodeFS.openSync(this.out, "a");
    try {
      NodeChildProcess.execFileSync(command, args, { cwd: this.project, env: this.env(), stdio: ["ignore", out, out], timeout: 60_000 });
    } finally {
      NodeFS.closeSync(out);
    }
  }

  /** Starts the server; resolves with the startup pairing code (first start) once it answers. */
  async start(needCode = false) {
    this.port = await freePort();
    this.origin = `http://127.0.0.1:${this.port}`;
    const [command, args] = this.command(this.port);
    const out = NodeFS.openSync(this.out, "a");
    const child = NodeChildProcess.spawn(command, args, {
      cwd: this.dir,
      env: this.env(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    NodeFS.closeSync(out);
    servers.add(child);
    this.child = child;
    const before = NodeFS.readFileSync(this.out, "utf8").length;
    const code = () => NodeFS.readFileSync(this.out, "utf8").slice(before).match(/pair#token=([A-Za-z0-9]+)/)?.[1];
    for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(100)) {
      if (child.exitCode !== null) throw new Error(`${this.name} server exited ${child.exitCode}; see ${this.out}`);
      // The first start prints a pairing code; a restart reuses the session it gave.
      if (needCode && code() === undefined) continue;
      try {
        const response = await fetch(`${this.origin}/.well-known/t3/environment`);
        if (response.ok) return code();
      } catch {}
    }
    throw new Error(`${this.name} server did not start in 90 s; see ${this.out}`);
  }

  /** SIGTERM to the server, as a service restart sends it; waits for its exit. */
  async stop() {
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    process.kill(child.pid, "SIGTERM");
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 15_000);
    await exited;
    clearTimeout(timer);
    // Its provider children end with their stdin; give them a moment, then stop the group.
    await sleep(300);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }

  async connect() {
    const code = await this.start(true);
    if (code === undefined) throw new Error(`${this.name}: no pairing code; see ${this.out}`);
    this.bearer = await pairBearer(this.origin, code);
    // T3 accepts only an MCP OAuth client on /mcp; the Conn Server also takes a session.
    const authorization =
      this.kind === "ts" ? `Bearer ${await oauthMcpToken(this.origin, this.bearer)}` : `Bearer ${this.bearer}`;
    this.mcp = new McpSession(this.origin, authorization);
    await this.mcp.initialize();
    this.addProject();
    const projects = await this.tool("t3_project_list", {});
    this.projectId = projects.projects.find((p) => p.title === "work")?.id;
    if (this.projectId === undefined) throw new Error(`${this.name}: project add left no project`);
  }

  async tool(name, input) {
    const reply = await this.mcp.callTool(name, input);
    if (reply.error !== undefined || reply.result?.isError) {
      throw new Error(`${this.name} ${name}: ${JSON.stringify(reply.error ?? reply.result.content)}`);
    }
    return reply.result.structuredContent;
  }

  gateReached(label) {
    return NodeFS.existsSync(NodePath.join(this.gateDir, `gate-${encodeURIComponent(label)}.reached`));
  }

  release(label) {
    NodeFS.writeFileSync(NodePath.join(this.gateDir, `gate-${encodeURIComponent(label)}.release`), "");
  }

  /** The route as Orbit calls it (Laravel's Http client: acceptJson, withToken, the header). */
  async shell(headers) {
    const response = await fetch(`${this.origin}/api/orchestration/shell`, {
      headers: headers ?? {
        accept: "application/json",
        authorization: `Bearer ${this.bearer}`,
        "x-t3-orchestration-protocol": "2",
      },
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { unparsed: text.slice(0, 200) };
    }
    return { status: response.status, contentType: response.headers.get("content-type"), body };
  }
}

// ---------------------------------------------------------------------------------------
// What Orbit reads

/** Run states in which a turn works (`ConnAgentActivity::Working`). */
const WORKING = ["preparing", "queued", "starting", "running"];
/** `ConnAgentActivity::waitsForUser`. */
const waitsForUser = (pending) => pending !== null && (pending.blocking ?? true) !== false;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Exactly the fields `ConnAgentActivity::fromShell` and `ConnThreadIndex::threads` read, with
 * PHP's `??` (null counts as missing), and the verdicts Orbit draws from them. Timestamps are
 * compared by presence and type: their values are the clock's.
 */
function orbitView(body) {
  const threads = body?.threads;
  const archived = body?.archivedThreads ?? [];
  if (!Array.isArray(threads) || !Array.isArray(archived)) return { readable: false };
  const time = (value) => (value === null || value === undefined ? null : typeof value === "string" ? "<time>" : `<${typeof value}>`);
  let turnRuns = false;
  // Orbit reads every row and ignores their order: rows are matched by title.
  const rows = byTitle([...threads, ...archived]).map((thread) => {
    if (!isObject(thread)) return { row: typeof thread };
    const status = thread.status ?? null;
    const pending = isObject(thread.pendingRuntimeRequest) ? thread.pendingRuntimeRequest : null;
    const background = thread.pendingBackgroundTasks ?? [];
    const activity = thread.activityRunStatus ?? null;
    const works =
      WORKING.includes(status) ||
      WORKING.includes(activity) ||
      (thread.blockedOnThreadWait ?? false) === true ||
      (Array.isArray(background) && background.length > 0) ||
      ((status === "waiting" || activity === "waiting") && !waitsForUser(pending));
    turnRuns ||= works;
    return {
      id: typeof thread.id,
      title: thread.title ?? null,
      status,
      activityRunStatus: activity,
      blockedOnThreadWait: thread.blockedOnThreadWait ?? false,
      pendingBackgroundTasks: Array.isArray(background) ? (background.length > 0 ? "non-empty" : "empty") : typeof background,
      pendingRuntimeRequest:
        pending === null ? (thread.pendingRuntimeRequest ?? null) : { createdAt: time(pending.createdAt), waitsForUser: waitsForUser(pending) },
      lastUserMessageAt: time(thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt ?? null),
      latestRunCompletedAt: time(thread.latestRunCompletedAt ?? null),
      works,
    };
  });
  return { readable: true, turnRuns, threads: rows.length - archived.length, archived: archived.length, rows };
}

const byTitle = (list) => [...list].sort((a, b) => String(a?.title).localeCompare(String(b?.title)));

/** The fields Orbit reads, for the `info` lines: these are reported in the Orbit view. */
const ORBIT_FIELDS = new Set([
  "id",
  "title",
  "status",
  "activityRunStatus",
  "blockedOnThreadWait",
  "pendingBackgroundTasks",
  "pendingRuntimeRequest",
  "latestUserAuthoredMessageAt",
  "latestUserMessageAt",
  "latestRunCompletedAt",
]);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ID_KEY = /(^id$|Id$|Ids$|^taskId$)/;

/** Ids become `<id:n>` in first-seen order, timestamps `<time>`, the temp root `<root>`. */
function normalize(value, ids = new Map(), key = "") {
  if (Array.isArray(value)) return value.map((item) => normalize(item, ids, key));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalize(value[k], ids, k)]),
    );
  }
  if (typeof value !== "string") return value;
  if (ISO_TIME.test(value)) return "<time>";
  if (ID_KEY.test(key)) {
    if (!ids.has(value)) ids.set(value, `<id:${ids.size + 1}>`);
    return ids.get(value);
  }
  return value.split(root).join("<root>");
}

/** Paths where two normalized values differ. */
function differences(a, b, path = "") {
  if (isObject(a) && isObject(b)) {
    const out = [];
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(key in a)) out.push(`${path}.${key}: only Conn sends ${JSON.stringify(b[key])}`);
      else if (!(key in b)) out.push(`${path}.${key}: only T3 sends ${JSON.stringify(a[key])}`);
      else out.push(...differences(a[key], b[key], `${path}.${key}`));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((item, i) => differences(item, b[i], `${path}[${i}]`));
  }
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  return x === y ? [] : [`${path}: T3 ${x} / Conn ${y}`];
}

// ---------------------------------------------------------------------------------------
// Reporting

const results = [];
let failures = 0;
const showInfo = argv.includes("--info");

/**
 * Differences in a field Orbit reads that are known, with the reason; each is a defect that
 * waits for its fix. The state then shows `KNOWN` and passes while its FAIL lines stay exactly
 * these. Any other line fails, and so does a known state that turns `same`: remove it here.
 * An `intermittent` difference depends on timing and may not show on a run; then the state
 * passes as `same` with a note, and it is never reported as fixed.
 */
const KNOWN = {
  "a turn being stopped": {
    intermittent: true,
    reason:
      "with the provider's reply to turn/interrupt held, T3 reported the run interrupted " +
      "(cause not proven), while Conn ends a stopped run only on the provider's terminal " +
      "event: it awaits the reply, then up to 10 s for the terminal, and past that marks the " +
      "Stop unresponsive and keeps the run open; seen on a slow CI runner (run 44382517419)",
    lines: [
      'FAIL orbit.rows[0].activityRunStatus: T3 null / Conn "running"',
      'FAIL orbit.rows[0].latestRunCompletedAt: T3 "<time>" / Conn null',
      'FAIL orbit.rows[0].status: T3 "interrupted" / Conn "running"',
      "FAIL orbit.rows[0].works: T3 false / Conn true",
      "FAIL orbit.turnRuns: T3 false / Conn true",
    ],
  },
};

/** Records one comparison and prints it; `summary` describes the T3 server's answer. */
function record(pair, { state, lines, info, notes, summary, orbitSends = true }) {
  // A state the T3 server did not reach is not proven, whatever the answers say.
  const unreached = notes.filter((note) => note.startsWith("T3 "));
  lines.push(...unreached.map((note) => `FAIL ${note}`));
  const known = KNOWN[state];
  // A known difference is excused only in the state it names: a side that missed its gate
  // never reached that state, so it fails, whichever side it is.
  if (known) {
    const missed = notes.filter((note) => note.startsWith("Conn ") && note.includes("did not reach"));
    lines.push(...missed.map((note) => `FAIL ${note}`));
  }
  let verdict;
  if (!orbitSends) verdict = info.length === 0 ? "same" : "info";
  else if (known === undefined) verdict = lines.length === 0 ? "same" : "DIFF";
  else if (lines.length === 0 && known.intermittent) {
    verdict = "same";
    notes = [...notes, `known timing-dependent difference did not show: ${known.reason}`];
  } else if (lines.length === 0) {
    verdict = "FIXED";
    lines.push("FAIL no longer differs: remove it from KNOWN in idle-diff.mjs");
  } else {
    const expected = new Set(known.lines);
    verdict = lines.length === expected.size && lines.every((l) => expected.has(l)) ? "KNOWN" : "DIFF";
  }
  const failed = verdict === "DIFF" || verdict === "FIXED";
  if (failed) failures += 1;
  results.push({ state, verdict, lines, info, notes });
  pair.log(`${verdict} ${state} (T3: ${summary})`);
  if (verdict === "KNOWN") pair.log(`     known: ${known.reason}`);
  const shown = verdict === "KNOWN" ? lines.map((line) => line.replace(/^FAIL /, "diff ")) : lines;
  for (const line of [...notes.map((n) => `note ${n}`), ...shown]) pair.log(`     ${line}`);
  if (showInfo) for (const line of info) pair.log(`     info ${line}`);
  else if (info.length > 0) pair.log(`     (${info.length} info lines; --info lists them)`);
}

/** A read that no longer changes: three equal reads 150 ms apart (at most 6 s). */
async function settled(side) {
  let last;
  let same = 0;
  let read;
  for (const deadline = Date.now() + 6_000; Date.now() < deadline; ) {
    read = await side.shell();
    const key = JSON.stringify(normalize(read.body));
    same = key === last ? same + 1 : 0;
    if (same >= 2) break;
    last = key;
    await sleep(150);
  }
  return read;
}

/** Reads both servers in one state and records the comparison. */
async function compare(pair, state, notes = []) {
  const [ts, conn] = await Promise.all(pair.map(settled));
  const lines = [];
  if (ts.status !== conn.status) lines.push(`FAIL http status: T3 ${ts.status} / Conn ${conn.status}`);
  if (ts.contentType !== conn.contentType) {
    lines.push(`FAIL content-type: T3 ${ts.contentType} / Conn ${conn.contentType}`);
  }
  const views = [orbitView(ts.body), orbitView(conn.body)];
  for (const d of differences(views[0], views[1])) lines.push(`FAIL orbit${d}`);
  const rows = (body) => byTitle([...(body?.threads ?? []), ...(body?.archivedThreads ?? [])]);
  const [a, b] = [rows(ts.body), rows(conn.body)].map((list) => normalize(list));
  const info = differences(a, b).filter((d) => !ORBIT_FIELDS.has(d.match(/^\[\d+\]\.(\w+)/)?.[1] ?? ""));
  const verdict = views[0].readable ? (views[0].turnRuns ? "active" : "idle") : `http ${ts.status}`;
  const status = views[0].rows?.find((row) => row.title === "Idle check")?.status;
  record(pair, { state, lines, info, notes, summary: `${verdict}${status ? `, status ${status}` : ""}` });
}

/**
 * Compares a refused or odd request on both servers: status, content type, `reason`. A request
 * Orbit never sends (`orbitSends: false`) is reported, but its differences are `info`.
 */
async function compareRequest(pair, state, headers, { orbitSends = true } = {}) {
  const [ts, conn] = await Promise.all(pair.map((side) => side.shell(headers(side))));
  const lines = [];
  if (ts.status !== conn.status) lines.push(`FAIL http status: T3 ${ts.status} / Conn ${conn.status}`);
  if (ts.contentType !== conn.contentType) {
    lines.push(`FAIL content-type: T3 ${ts.contentType} / Conn ${conn.contentType}`);
  }
  // Orbit logs `reason` from a refusal (`HttpT3ServerClient::json`).
  const reason = (body) => (typeof body?.reason === "string" ? body.reason : "unknown");
  if (reason(ts.body) !== reason(conn.body)) {
    lines.push(`FAIL reason: T3 ${reason(ts.body)} / Conn ${reason(conn.body)}`);
  }
  const info = differences(normalize(ts.body), normalize(conn.body));
  // A request Orbit never sends: its differences are reported as `info` only.
  if (!orbitSends) info.unshift(...lines.splice(0).map((line) => line.replace(/^FAIL /, "")));
  record(pair, { state, lines, info, notes: [], summary: `http ${ts.status}, reason ${reason(ts.body)}`, orbitSends });
}

async function until(pair, label, predicate, timeoutMs = 20_000) {
  const notes = [];
  await Promise.all(
    pair.map(async (side) => {
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
        if (await predicate(side)) return;
        await sleep(100);
      }
      notes.push(`${side.name} did not reach "${label}" in ${timeoutMs / 1000} s`);
    }),
  );
  return notes;
}
const gate = (pair, label) => until(pair, `gate ${label}`, async (side) => side.gateReached(label));
/** The scenario's own thread: the one it launched. */
const ownThread = async (side) => (await side.shell()).body?.threads?.find((t) => t.id === side.threadId);
const threadWhere = (pair, label, test) =>
  until(pair, label, async (side) => {
    const thread = await ownThread(side);
    return thread !== undefined && test(thread);
  });
const both = (pair, f) => Promise.all(pair.map(f));

// ---------------------------------------------------------------------------------------
// Scenarios: each runs on its own pair and walks its thread through states.

const launch = (side, extra = {}) =>
  side
    .tool("t3_thread_launch", {
      projectId: side.projectId,
      title: "Idle check",
      modelSelection: { instanceId: "codex", model: extra.model ?? "gpt-6-luna" },
      runtimeMode: extra.runtimeMode ?? "full-access",
      interactionMode: extra.interactionMode ?? "default",
      workspaceStrategy: { type: "root" },
      ...(extra.message === undefined ? {} : { message: extra.message }),
      clientRequestId: `idle-${extra.message === undefined ? "empty" : "turn"}`,
    })
    .then((result) => {
      side.threadId = result.threadId;
      return result;
    });
const send = (side, message, mode) =>
  side.tool("t3_thread_send", { threadId: side.threadId, message, ...(mode ? { mode } : {}) });
const terminal = (status) => ["completed", "failed", "interrupted", "cancelled"].includes(status);

const SCENARIOS = [
  {
    name: "turn",
    transcript: () => fixture("queued_turn"),
    gates: ["thread/start", "turn/start", "turn/completed"],
    async run(pair) {
      await compare(pair, "no thread");
      await compareRequest(pair, "no credential", () => ({ accept: "application/json", "x-t3-orchestration-protocol": "2" }));
      await compareRequest(pair, "an unknown bearer token", () => ({
        accept: "application/json",
        authorization: "Bearer idle-diff-not-a-token",
        "x-t3-orchestration-protocol": "2",
      }));
      // Orbit always sends `x-t3-orchestration-protocol: 2`; these two only show the refusal.
      await compareRequest(
        pair,
        "no protocol header (Orbit never sends this)",
        (side) => ({ accept: "application/json", authorization: `Bearer ${side.bearer}` }),
        { orbitSends: false },
      );
      await compareRequest(
        pair,
        "protocol header 1 (Orbit never sends this)",
        (side) => ({
          accept: "application/json",
          authorization: `Bearer ${side.bearer}`,
          "x-t3-orchestration-protocol": "1",
        }),
        { orbitSends: false },
      );
      // A session with too few scopes: a pairing credential with `access:read` only.
      const narrow = await both(pair, async (side) => {
        const response = await fetch(`${side.origin}/api/auth/pairing-token`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${side.bearer}` },
          body: JSON.stringify({ label: "idle-diff narrow", scopes: ["access:read"] }),
        });
        const body = await response.json();
        if (!response.ok) return { error: `${response.status} ${JSON.stringify(body)}` };
        return { bearer: await pairBearer(side.origin, body.credential) };
      });
      if (narrow.some((n) => n.error)) {
        const lines = narrow.map((n, i) => `FAIL cannot issue it on ${pair[i].name}: ${n.error ?? "ok"}`);
        record(pair, { state: "a session with too few scopes", lines, info: [], notes: [], summary: "?" });
      } else {
        await compareRequest(pair, "a session with too few scopes", (side) => ({
          accept: "application/json",
          authorization: `Bearer ${narrow[pair.indexOf(side)].bearer}`,
          "x-t3-orchestration-protocol": "2",
        }));
      }

      await both(pair, (side) => launch(side));
      await compare(pair, "an idle thread");
      await both(pair, (side) => send(side, "Reply with exactly: first"));
      // The provider session is opening: `thread/start` has no answer yet.
      await compare(pair, "a turn that is starting", await gate(pair, "thread/start"));
      await both(pair, (side) => side.release("thread/start"));
      // The turn is sent: `turn/start` has no answer yet.
      await compare(pair, "a turn sent, not yet started", await gate(pair, "turn/start"));
      await both(pair, (side) => side.release("turn/start"));
      await compare(pair, "a running turn", await gate(pair, "turn/completed"));
      await both(pair, (side) => send(side, "Reply with exactly: second", "queue"));
      await compare(pair, "a queued message behind a running turn");
      await both(pair, (side) => side.release("turn/completed"));
      const notes = await threadWhere(pair, "both turns done", (t) => terminal(t.status) && t.activityRunStatus == null);
      await compare(pair, "idle after the queued turn", notes);
    },
  },
  {
    name: "stop",
    transcript: () => fixture("turn_interrupt"),
    gates: ["turn/interrupt"],
    async run(pair) {
      await both(pair, (side) => launch(side, { message: "Count slowly to one hundred." }));
      // The recording waits for `turn/interrupt`: the turn runs until we stop it.
      const notes = await threadWhere(pair, "running", (t) => t.status === "running");
      await compare(pair, "a running turn (before stop)", notes);
      await both(pair, (side) => side.tool("t3_thread_interrupt", { threadId: side.threadId }));
      await compare(pair, "a turn being stopped", await gate(pair, "turn/interrupt"));
      await both(pair, (side) => side.release("turn/interrupt"));
      await compare(pair, "a stopped turn", await threadWhere(pair, "interrupted", (t) => terminal(t.status)));
    },
  },
  {
    name: "approval",
    transcript: () => fixture("tool_call_read_only_on_request"),
    gates: [],
    async run(pair) {
      await both(pair, (side) =>
        launch(side, { message: "Write a file.", model: "gpt-6-sol", runtimeMode: "approval-required" }),
      );
      const notes = await threadWhere(pair, "pending approval", (t) => t.pendingRuntimeRequest != null);
      await compare(pair, "a turn waiting for an approval", notes);
    },
  },
  {
    name: "question",
    transcript: () => fixture("plan_questions"),
    gates: [],
    async run(pair) {
      await both(pair, (side) => launch(side, { message: "Plan it; ask me first.", interactionMode: "plan" }));
      const notes = await threadWhere(pair, "pending question", (t) => t.pendingRuntimeRequest != null);
      await compare(pair, "a turn waiting for a user answer", notes);
    },
  },
  {
    name: "failed",
    transcript: failedTranscript,
    gates: [],
    async run(pair) {
      await both(pair, (side) => launch(side, { message: "Respond with the following text: fixture simple ok" }));
      await compare(pair, "a failed turn", await threadWhere(pair, "failed", (t) => terminal(t.status)));
    },
  },
  {
    name: "background",
    transcript: backgroundTranscript,
    gates: ["child-end", "wake"],
    async run(pair) {
      await both(pair, (side) => launch(side, { message: "Spawn a subagent." }));
      const notes = [...(await gate(pair, "child-end"))];
      notes.push(...(await threadWhere(pair, "root turn ended", (t) => terminal(t.status))));
      await compare(pair, "background work after the turn ended", notes);
      await both(pair, (side) => side.release("child-end"));
      // T3 wakes the agent with a new turn, held at the gate `wake`.
      const ended = await threadWhere(pair, "subagent ended", (t) => (t.pendingBackgroundTasks ?? []).length === 0);
      await sleep(1_000);
      await compare(pair, "the background work ended (T3 wakes the agent)", ended);
      await both(pair, (side) => side.release("wake"));
      const done = await threadWhere(pair, "settled", (t) => terminal(t.status));
      await compare(pair, "after the wake turn", done);
    },
  },
  {
    name: "restart",
    transcript: () => fixture("simple"),
    gates: ["turn/completed"],
    async run(pair) {
      await both(pair, (side) => launch(side, { message: "Respond with the following text: fixture simple ok" }));
      await compare(pair, "a running turn (before restart)", await gate(pair, "turn/completed"));
      await both(pair, async (side) => {
        await side.stop();
        await side.start();
      });
      await compare(pair, "after a restart with a turn that was running");
    },
  },
];

// ---------------------------------------------------------------------------------------

const started = Date.now();
const selected = SCENARIOS.filter((s) => only === undefined || only.includes(s.name));
let next = 0;
async function worker() {
  while (next < selected.length) {
    const scenario = selected[next++];
    const dir = NodePath.join(root, scenario.name);
    const transcript = scenario.transcript();
    const pair = [new Side("ts", NodePath.join(dir, "ts"), transcript, scenario.gates), new Side("rust", NodePath.join(dir, "rust"), transcript, scenario.gates)];
    // Output per scenario, printed whole when it ends, so parallel scenarios do not interleave.
    const lines = [];
    pair.log = (line) => lines.push(line);
    try {
      await both(pair, (side) => side.connect());
      await scenario.run(pair);
    } catch (error) {
      failures += 1;
      lines.push(`FAIL scenario ${scenario.name}: ${error.stack ?? error}`);
    } finally {
      await both(pair, (side) => (side.child ? side.stop() : undefined));
    }
    console.log(`\n## ${scenario.name}\n${lines.join("\n")}`);
  }
}
await Promise.all(Array.from({ length: Math.min(PARALLEL, selected.length) }, worker));
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const known = results.filter((r) => r.verdict === "KNOWN").length;
const tally = `${results.length} comparisons, ${known} known, ${seconds} s`;
console.log(
  failures === 0
    ? `\nidle-diff: no new difference in a field Orbit reads (${tally})`
    : `\nidle-diff: ${failures} failed (${tally})`,
);
process.exit(failures === 0 ? 0 : 1);

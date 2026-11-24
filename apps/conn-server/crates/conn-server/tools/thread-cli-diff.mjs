#!/usr/bin/env node
// The `t3 thread` and `t3 auth session` command lines that Orbit's task turns run
// (`swamp/ansible/task-copy-turn.yml`, `t3_copy_rpc.mjs`), on the T3 server with its own `t3`
// CLI and on the Conn Server with ours. Same settings, same project, same commands; stdout,
// stderr and the exit code are compared after ids, tokens, times and folders are replaced.
//
//   node crates/conn-server/tools/thread-cli-diff.mjs <conn-server> [--keep]
//
// No model is called. Both servers find `codex` through a stand-in login shell whose PATH holds
// only a wrapper around the Codex conformance stub (`crates/conn-provider-codex/tools/codex-stub.mjs`).
// The wrapper answers `--version` and `app-server --help` itself and hands each `app-server`
// process the transcript the check armed, else a start-up transcript (initialize only) for a
// provider probe. Both servers keep one `app-server` for all threads, so each scenario starts
// the server again (state kept) and arms its transcript once the start-up probes are done.
//
// Transcripts: T3's recorded `simple` (a turn that completes), `multi_turn` (start, then send),
// `plan_questions` (a turn that stops at a question), and `simple` turned into a failed turn
// (`deriveFailed`: no assistant message, an `error` notification, `turn/completed` failed).
//
// The question scenario also runs what `t3_copy_rpc.mjs` does, call by call: read
// `server-runtime.json`, `auth session issue --scope … --ttl 1m --json`, a WebSocket ticket,
// `/ws`, `orchestration.getThreadProjection`, `dispatchCommand {run.interrupt}`, and
// `auth session revoke` of the issued session (`orbit-copy-rpc.mjs`).
//
// Differences in KNOWN are printed with their reason and do not fail the check. Any other
// difference exits 1. Every server gets its own temp home, HOME and a free port.
//
// At the end both event logs are read: each event's top-level `providerInstanceId`, keyed by
// event type (and a turn item's type), must be the same set on both servers. A key only one
// server writes is listed, not failed. One known difference is excused row by row
// (`excusedQuestion`).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { monorepo } from "../../../tools/monorepo.mjs";
import { canaryEnv, gitEnv } from "../../../tools/sealed-env.mjs";
import { copyRpc } from "./orbit-copy-rpc.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const binary = argv.find((a) => !a.startsWith("--"));
if (binary === undefined || !NodeFS.existsSync(binary)) {
  console.error("usage: thread-cli-diff.mjs <conn-server> [--keep]");
  process.exit(2);
}
const MONOREPO = monorepo();
const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const STUB = NodePath.resolve(HERE, "../../conn-provider-codex/tools/codex-stub.mjs");
const FIXTURES = NodePath.join(MONOREPO, "apps/server/src/orchestration-v2/testkit/fixtures");
const T3_BIN = NodePath.join(MONOREPO, "apps/server/src/bin.ts");
const NODE = process.execPath;
// A real path: the T3 server keeps a project's path as given, the Conn Server resolves links.
const root = NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "conn-thread-cli-"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/**
 * Differences that do not fail the check, by step and JSON path ("*" any step), with the
 * reason. Each comes from the server's tool results, not from the CLI.
 */
const KNOWN = [
  {
    path: /\.itemCount$/,
    reason:
      "the T3 launch starts its first message deferred (ThreadLaunchService.ts:1209, dispatchMode defer_start) and records a 'Workspace ready' command_execution item (Orchestrator.ts:8000-8025, completed at 11680-11695 by prepared-run.release); this engine starts at once (conn-engine engine.rs, start_immediately) and refuses prepared-run.* (commands.rs:160-163). Orbit reads no itemCount",
  },
];

/**
 * Text that only the T3 server adds, with the reason: removed from T3's text before a text
 * compare. Anything else in the text still has to match byte for byte.
 */
const KNOWN_TEXT = [
  // None: the linked-environment hint on thread_not_found is served since 2026-11-19.
];

// ---------------------------------------------------------------------------------------
// One side: a server, its home, its CLI.

function deriveFailed(source, target) {
  const out = [];
  for (const line of NodeFS.readFileSync(source, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    const method = entry.frame?.method;
    if (method === "item/agentMessage/delta" || entry.frame?.params?.item?.type === "agentMessage") {
      continue;
    }
    if (method === "turn/completed") {
      const params = entry.frame.params;
      const error = {
        message: "stub: the model refused the request",
        codexErrorInfo: null,
        additionalDetails: null,
      };
      out.push({
        type: "emit_inbound",
        label: "error",
        frame: {
          method: "error",
          params: { error, willRetry: false, threadId: params.threadId, turnId: params.turn.id },
        },
      });
      entry.frame = {
        ...entry.frame,
        params: { ...params, turn: { ...params.turn, items: [], status: "failed", error } },
      };
    }
    out.push(entry);
  }
  NodeFS.writeFileSync(target, `${out.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function makeSide(name) {
  const dir = NodePath.join(root, name);
  const base = NodePath.join(dir, "home", ".t3");
  const userdata = NodePath.join(base, "userdata");
  const project = NodePath.join(dir, "workspace");
  const stub = NodePath.join(dir, "stub");
  const bin = NodePath.join(dir, "bin");
  for (const d of [userdata, project, stub, bin, NodePath.join(dir, "shell")]) {
    NodeFS.mkdirSync(d, { recursive: true });
  }
  // As Orbit writes it, plus no model-manifest fetch from GitHub during the check.
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    JSON.stringify({ linkedEnvironmentsEnabled: true, enableProviderUpdateChecks: false }),
  );
  const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd: project, env: gitEnv() });
  git("init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "# workspace\n");
  git("add", ".");
  git("-c", "user.name=o", "-c", "user.email=o@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  // The start-up probe gets the first two lines of a recording: initialize and its answer.
  const probe = NodePath.join(stub, "probe.ndjson");
  NodeFS.writeFileSync(
    probe,
    NodeFS.readFileSync(NodePath.join(FIXTURES, "simple/codex_transcript.ndjson"), "utf8")
      .split("\n")
      .slice(0, 3)
      .join("\n") + "\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "codex"),
    [
      "#!/bin/sh",
      `D=${JSON.stringify(stub)}`,
      'echo "$$ $*" >> "$D/calls.log"',
      'case "$1" in --version) echo "codex-cli 0.166.0"; exit 0;; esac',
      'if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then echo "Usage: codex app-server"; exit 0; fi',
      'if [ "$1" = "app-server" ] && mv "$D/armed" "$D/run-$$.ndjson" 2>/dev/null; then T="$D/run-$$.ndjson"; else T="$D/probe.ndjson"; fi',
      `printf '{"transcript":"%s","log":"%s/log-%s.ndjson","lingerMs":200}' "$T" "$D" "$$" > "$D/config-$$.json"`,
      `exec ${JSON.stringify(NODE)} ${JSON.stringify(STUB)} --stub-config "$D/config-$$.json" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const path = `${bin}:${NodePath.dirname(NODE)}:/usr/bin:/bin`;
  const shell = NodePath.join(dir, "shell", "sh");
  NodeFS.writeFileSync(
    shell,
    [
      "#!/bin/sh",
      `PATH=${JSON.stringify(path)}; export PATH`,
      'for arg; do command="$arg"; done',
      'exec /bin/sh -c "$command"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = {
    SHELL: shell,
    HOME: NodePath.join(dir, "home"),
    USER: NodeOS.userInfo().username,
    PATH: path,
    T3CODE_HOME: base,
    T3CODE_NO_BROWSER: "1",
    LANG: "C.UTF-8",
    // Our server never fetches model-manifest.json; the T3 server's settings turn its fetch off.
    CONN_MODEL_MANIFEST_URL: "off",
    CONN_CLAUDE_STATUS_PROBE: "off",
    // Ours probes no Codex here, as before: the check compares the task-turn commands.
    CONN_CODEX_STATUS_PROBE: "off",
    ...canaryEnv(),
  };
  const isT3 = name === "t3";
  // The T3 server and CLI run with fetch limited to loopback (no-outside-fetch.mjs).
  const command = isT3 ? [NODE, GUARD_ARG, T3_BIN] : [NodePath.resolve(binary)];
  let server = null;
  let port = 0;
  let output = "";
  const steps = [];

  const run = (args, input = "") =>
    new Promise((resolve) => {
      const [cmd, ...pre] = command;
      const child = NodeChildProcess.spawn(cmd, [...pre, ...args], { env, cwd: project });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ stdout, stderr, code }));
      // A CLI that exits before reading stdin closes the pipe; its output and code still compare.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });

  const side = {
    name,
    dir,
    base,
    userdata,
    project,
    env,
    steps,
    get origin() {
      return `http://127.0.0.1:${port}`;
    },
    async step(label, args, input = "") {
      const result = await run(args, input);
      steps.push({ label, args, ...result });
      return result;
    },
    cli: run,
    arm(transcript) {
      NodeFS.copyFileSync(transcript, NodePath.join(stub, "armed"));
    },
    async start() {
      port = await freePort();
      const [cmd, ...pre] = command;
      output = "";
      server = NodeChildProcess.spawn(
        cmd,
        [...pre, "serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
        { env, cwd: project, stdio: ["ignore", "pipe", "pipe"] },
      );
      server.stdout.on("data", (d) => (output += d));
      server.stderr.on("data", (d) => (output += d));
      for (let i = 0; i < 120; i++) {
        const ok = await fetch(`${side.origin}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(1000),
        })
          .then((r) => r.ok)
          .catch(() => false);
        if (ok) break;
        if (server.exitCode !== null) throw new Error(`${name} server exited:\n${output}`);
        await sleep(500);
      }
      // Start-up probes (`codex --version`, `app-server --help`, a probe `app-server`) end
      // before a transcript is armed: wait until the stub's call log is quiet.
      const log = NodePath.join(stub, "calls.log");
      let last = "";
      let quietSince = Date.now();
      for (let i = 0; i < 80 && Date.now() - quietSince < 2500; i++) {
        const now = NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8") : "";
        if (now !== last) {
          last = now;
          quietSince = Date.now();
        }
        await sleep(250);
      }
    },
    async stop() {
      if (server === null || server.exitCode !== null) return;
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      const done = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)]);
      if (!done) server.kill("SIGKILL");
      server = null;
    },
    get serverOutput() {
      return output;
    },
  };
  return side;
}

// ---------------------------------------------------------------------------------------
// The sequence, the same on both sides.

const PROMPT = "Respond with the following text: fixture simple ok";
const startArgs = (side, title, model = "gpt-5.4", provider = "codex") => [
  "thread", "start", "--provider", provider, "--model", model, "--title", title, "--wait", "--json", side.project, "-",
];
const threadIdOf = (result) => {
  try {
    return JSON.parse(result.stdout).threadId;
  } catch {
    return undefined;
  }
};

const failedTranscript = NodePath.join(root, "failed.ndjson");
deriveFailed(NodePath.join(FIXTURES, "simple/codex_transcript.ndjson"), failedTranscript);
const transcript = (name) => NodePath.join(FIXTURES, name, "codex_transcript.ndjson");

async function sequence(side) {
  await side.start();
  await side.step("project add", ["project", "add", side.project, "--title", "Workspace"]);
  await side.step("list, no thread", ["thread", "list", "--project", side.project, "--json"]);

  // `t3_copy_rpc.mjs`'s session, then `task-copy-turn.yml`'s sessions.
  const issued = await side.step("issue --scope --scope --ttl 1m --json", [
    "auth", "session", "issue", "--scope", "orchestration:read", "--scope", "orchestration:operate",
    "--ttl", "1m", "--label", "orbit copy turn", "--json",
  ]);
  const sessionId = JSON.parse(issued.stdout).sessionId;
  await side.step("revoke the issued session", ["auth", "session", "revoke", sessionId]);
  await side.step("revoke it again", ["auth", "session", "revoke", sessionId]);
  await side.step("issue --token-only", ["auth", "session", "issue", "--label", "Orbit Gateway", "--token-only"]);
  await side.step("issue, text", ["auth", "session", "issue", "--scope", "orchestration:read", "--label", "x"]);

  // A turn that completes.
  side.arm(transcript("simple"));
  const completed = await side.step("start --wait --json: completes", startArgs(side, "Orbit task 1 thread 1"), PROMPT);
  const completedId = threadIdOf(completed);
  await side.step("list --json", ["thread", "list", "--project", side.project, "--json"]);
  await side.step("show --messages 200 --json", ["thread", "show", "--messages", "200", "--json", completedId]);
  await side.step("show, text", ["thread", "show", completedId]);

  // A second turn through `send`.
  await side.stop();
  await side.start();
  side.arm(transcript("multi_turn"));
  const first = await side.step("start --wait --json: first of two", startArgs(side, "Orbit task 1 thread 2"), "First turn");
  const sendId = threadIdOf(first);
  await side.step("send --wait --json", ["thread", "send", "--wait", "--json", sendId, "-"], "Second turn");
  await side.step("show after send", ["thread", "show", "--messages", "200", "--json", sendId]);

  // A turn that fails.
  await side.stop();
  await side.start();
  side.arm(failedTranscript);
  await side.step("start --wait --json: fails", startArgs(side, "Orbit task 2 thread 1"), "Fail");

  // A turn that stops at a question; then `t3_copy_rpc.mjs` reads it and stops the run.
  await side.stop();
  await side.start();
  side.arm(transcript("plan_questions"));
  const asked = await side.step("start --wait --json: asks", startArgs(side, "Orbit task 3 thread 1"), "Ask me");
  const waiting = JSON.parse(asked.stdout || "{}");
  // The question the providerInstanceId exception may excuse is this thread's, on this run.
  side.asked = { threadId: waiting.threadId, runId: waiting.runId };
  const read = await copyRpc(side, "read", waiting.threadId);
  side.steps.push({ label: "t3_copy_rpc read", args: [], stdout: JSON.stringify(read.out), stderr: read.stderr, code: read.code });
  const ids = (read.out?.requests ?? []).map((r) => r.request_id).join("\n");
  const stopped = await copyRpc(side, "interrupt", waiting.threadId, waiting.runId, ids);
  side.steps.push({ label: "t3_copy_rpc interrupt", args: [], stdout: JSON.stringify(stopped.out), stderr: stopped.stderr, code: stopped.code });
  side.steps.push({ label: "t3_copy_rpc revoked its session", args: [], stdout: String(stopped.revoked && read.revoked), stderr: "", code: 0 });
  await side.step("list after the stop", ["thread", "list", "--project", side.project, "--json"]);

  // Unknown thread, unknown model, unknown provider, usage errors.
  await side.step("show: unknown thread", ["thread", "show", "--messages", "200", "--json", "mcp:missing"]);
  await side.step("send: unknown thread", ["thread", "send", "--wait", "--json", "mcp:missing", "-"], "hello");
  await side.stop();
  await side.start();
  side.arm(transcript("simple"));
  await side.step("start: unknown model", startArgs(side, "Orbit task 4 thread 1", "gpt-no-such-model"), PROMPT);
  await side.step("start: unknown provider", startArgs(side, "Orbit task 5 thread 1", "x", "nosuch"), PROMPT);
  await side.step("start: provider without model", ["thread", "start", "--provider", "codex", "--json", side.project, "-"], PROMPT);
  await side.step("start: empty message", ["thread", "start", "--json", side.project, "-"], "  \n");
  await side.step("start: unknown project", ["thread", "start", "--json", NodePath.join(side.dir, "elsewhere"), "hi"]);
  await side.step("list, text", ["thread", "list", "--project", side.project]);
  await side.step("list by project id", ["thread", "list", "--json"]);
  await side.stop();
  await side.step("list: no server", ["thread", "list", "--project", side.project, "--json"]);
}

// ---------------------------------------------------------------------------------------
// Normalising and comparing

const ID_KINDS = {
  threadId: "thread", runId: "run", latestRunId: "run", activeRunId: "run", projectId: "project",
  sessionId: "session", messageId: "message", itemId: "item", request_id: "request", id: "id",
};

function collectIds(value, add) {
  if (Array.isArray(value)) value.forEach((v) => collectIds(v, add));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string" && ID_KINDS[key] !== undefined) add(v, ID_KINDS[key]);
      else collectIds(v, add);
    }
  }
}

function normaliser(side) {
  const known = new Map();
  const counters = {};
  const add = (value, kind) => {
    if (value.length < 4 || known.has(value)) return;
    counters[kind] = (counters[kind] ?? 0) + 1;
    known.set(value, `<${kind}${counters[kind]}>`);
  };
  for (const step of side.steps) {
    for (const text of [step.stdout, ...step.stdout.split("\n")]) {
      try {
        collectIds(JSON.parse(text), add);
      } catch {}
    }
    const added = /^Added project (\S+) /.exec(step.stdout);
    if (added) add(added[1], "project");
    const issued = /^Issued bearer access token (\S+)\.$/m.exec(step.stdout);
    if (issued) add(issued[1], "session");
  }
  const tokens = side.steps
    .filter((s) => s.label.startsWith("issue"))
    .flatMap((s) => [...s.stdout.matchAll(/"token": "([^"]+)"|^Token: (\S+)$|^([0-9a-zA-Z_.-]{20,})$/gm)])
    .map((m) => m[1] ?? m[2] ?? m[3]);
  const order = [...known.keys()].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const token of tokens) out = out.split(token).join("<token>");
    for (const id of order) {
      const name = known.get(id);
      out = out.split(encodeURIComponent(id)).join(name).split(id).join(name);
    }
    return out
      .split(side.dir).join("<dir>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
      .replace(/https:\/\/app\.t3\.codes\/threads\/[0-9a-f-]+\//g, "https://app.t3.codes/threads/<environment>/");
  };
}

function jsonDiffs(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((v, i) => jsonDiffs(v, b[i], `${path}[${i}]`));
  }
  if (isObj(a) && isObj(b)) {
    const keysA = Object.keys(a).join(",");
    const keysB = Object.keys(b).join(",");
    const out = keysA === keysB ? [] : [{ path, what: `key order or set: T3 ${keysA} | Conn ${keysB}` }];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key in a && key in b) out.push(...jsonDiffs(a[key], b[key], `${path}.${key}`));
    }
    return out;
  }
  return [{ path, what: `T3 ${JSON.stringify(a)} | Conn ${JSON.stringify(b)}` }];
}

const parseLines = (text) => {
  try {
    return { json: text.trim() === "" ? undefined : JSON.parse(text) };
  } catch {
    return {};
  }
};

function compare(t3, conn) {
  const normT3 = normaliser(t3);
  const normConn = normaliser(conn);
  let failures = 0;
  let known = 0;
  for (let i = 0; i < Math.max(t3.steps.length, conn.steps.length); i++) {
    const a = t3.steps[i];
    const b = conn.steps[i];
    if (a === undefined || b === undefined || a.label !== b.label) {
      console.log(`FAIL step ${i}: ${a?.label} vs ${b?.label}`);
      failures++;
      continue;
    }
    const problems = [];
    const excused = [];
    if (a.code !== b.code) problems.push(`exit code: T3 ${a.code} | Conn ${b.code}`);
    for (const stream of ["stdout", "stderr"]) {
      const x = normT3(a[stream]);
      const y = normConn(b[stream]);
      if (x === y) continue;
      const jx = parseLines(x);
      const jy = parseLines(y);
      // JSON compares by path (key order included); text byte for byte.
      if (jx.json !== undefined && jy.json !== undefined && x.endsWith("\n") === y.endsWith("\n")) {
        const textOrder = JSON.stringify(jx.json) === x.trim() && JSON.stringify(jy.json) === y.trim();
        for (const diff of jsonDiffs(jx.json, jy.json)) {
          const rule = KNOWN.find((k) => k.path.test(diff.path) && (k.step === undefined || k.step === a.label));
          (rule ? excused : problems).push(`${stream} ${diff.path}: ${diff.what}${rule ? ` (known: ${rule.reason})` : ""}`);
        }
        if (!textOrder && JSON.stringify(jx.json, null, 2) !== x.trim() && x.trim() !== y.trim()) {
          problems.push(`${stream} layout differs:\n  T3:   ${JSON.stringify(x)}\n  Conn: ${JSON.stringify(y)}`);
        }
      } else {
        const rule = KNOWN_TEXT.find((k) => x.includes(k.text) && x.replaceAll(k.text, "") === y);
        if (rule) excused.push(`${stream}: T3 adds ${JSON.stringify(rule.text.trim())} (known: ${rule.reason})`);
        else problems.push(`${stream}:\n  T3:   ${JSON.stringify(x)}\n  Conn: ${JSON.stringify(y)}`);
      }
    }
    if (problems.length > 0) {
      failures++;
      console.log(`FAIL ${a.label}`);
      for (const p of problems) console.log(`  ${p}`);
    } else {
      console.log(`ok   ${a.label} (exit ${a.code})`);
    }
    for (const e of excused) {
      known++;
      console.log(`  known ${e}`);
    }
  }
  return { failures, known };
}

// ---------------------------------------------------------------------------------------
// The events' `providerInstanceId`

function findFiles(dir, name) {
  const found = [];
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

/** The side's stored events, in order: type, thread, payload and envelope instance. */
function storedEvents(side) {
  const t3 = side.name === "t3";
  const [file] = findFiles(side.dir, t3 ? "statev2.sqlite" : "engine.sqlite");
  if (file === undefined) throw new Error(`${side.name}: no event store under ${side.dir}`);
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  const rows = t3
    ? db
        .prepare(
          "SELECT event_type AS type, stream_id AS thread, payload_json AS payload, metadata_json AS meta FROM orchestration_events WHERE aggregate_kind = 'thread' ORDER BY sequence",
        )
        .all()
        .map((row) => {
          const meta = JSON.parse(row.meta ?? "{}");
          return { type: row.type, thread: row.thread, run: meta.runId, payload: JSON.parse(row.payload), instance: meta.providerInstanceId };
        })
    : db
        .prepare("SELECT event FROM events ORDER BY seq")
        .all()
        .map((row) => JSON.parse(row.event))
        .map((event) => ({ type: event.type, thread: event.threadId, run: event.runId, payload: event.payload, instance: event.providerInstanceId }));
  db.close();
  return rows;
}

const keyOf = (row) => (row.type === "turn-item.updated" ? `${row.type}:${row.payload?.type}` : row.type);

/**
 * The one known difference, matched row by row. T3's ingestor cancels a pending question when
 * its provider turn ends (`dismissNativeUserInputs`, the session's instance). Conn has no such
 * step: the question stays pending until its session is released, which expires it, and T3's
 * release names no instance. A Conn row is excused only when it is the question the scenario's
 * `asked` step reported on each side: Conn's, on that thread and run, expired right after its
 * own session's release, after the one pending row of its request; T3's, on its own `asked`
 * thread and run, cancelled for the same native request after the one pending row of it.
 */
const REQUEST = "runtime-request.updated";
const runOrdinal = (run) => (typeof run === "string" ? run.slice(run.lastIndexOf(":") + 1) : undefined);
const sameRef = (a, b) => a != null && JSON.stringify(a) === JSON.stringify(b);

function excusedQuestion(rows, index, t3Rows, connAsked, t3Asked) {
  const row = rows[index];
  const before = rows[index - 1];
  if (connAsked?.threadId === undefined || t3Asked?.threadId === undefined) return false;
  const shaped =
    row.type === REQUEST &&
    row.instance === undefined &&
    row.payload?.kind === "user_input" &&
    row.payload?.status === "expired" &&
    row.payload?.responseCapability?.type === "live" &&
    before?.type === "provider-session.updated" &&
    before.thread === row.thread &&
    before.payload?.status === "stopped" &&
    before.payload?.id === row.payload.responseCapability.providerSessionId;
  if (!shaped) return false;
  if (row.thread !== connAsked.threadId) return false;
  const pending = rows.filter(
    (r, i) =>
      i < index &&
      r.type === REQUEST &&
      r.thread === row.thread &&
      r.payload?.id === row.payload.id &&
      r.payload?.status === "pending" &&
      r.instance !== undefined,
  );
  if (
    pending.length !== 1 ||
    pending[0].run !== connAsked.runId ||
    (row.run !== undefined && row.run !== pending[0].run)
  ) {
    return false;
  }
  const cancelled = t3Rows.filter(
    (t) =>
      t.type === REQUEST &&
      t.payload?.kind === "user_input" &&
      t.payload?.status === "cancelled" &&
      t.instance !== undefined &&
      sameRef(t.payload?.nativeRequestRef, row.payload.nativeRequestRef),
  );
  if (cancelled.length !== 1) return false;
  const [match] = cancelled;
  if (match.thread !== t3Asked.threadId || match.run !== t3Asked.runId) return false;
  const matchIndex = t3Rows.indexOf(match);
  const t3Pending = t3Rows.filter(
    (t, i) =>
      i < matchIndex &&
      t.type === REQUEST &&
      t.thread === match.thread &&
      t.run === match.run &&
      t.payload?.id === match.payload.id &&
      t.payload?.status === "pending",
  );
  return t3Pending.length === 1 && runOrdinal(match.run) === runOrdinal(pending[0].run);
}

/** `key -> Set` of the instances (or "(none)") the rows name. */
function instancesByKey(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(row.instance ?? "(none)");
  }
  return byKey;
}

function compareInstances(t3, conn) {
  const t3Rows = storedEvents(t3);
  const connAll = storedEvents(conn);
  const excused = connAll.map((_, i) => excusedQuestion(connAll, i, t3Rows, conn.asked, t3.asked));
  const count = excused.filter(Boolean).length;
  // The scenario asks one question; more matches would hide something else.
  const connRows = count === 1 ? connAll.filter((_, i) => !excused[i]) : connAll;
  if (count === 1) {
    console.log(
      "  known Conn expires its one question at its session's release with no instance; T3 cancels it at the turn's end (dismissNativeUserInputs)",
    );
  } else if (count > 1) {
    console.log(`  ${count} questions match the known difference; none is excused`);
  }
  const a = instancesByKey(t3Rows);
  const b = instancesByKey(connRows);
  let failures = 0;
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(key);
    const y = b.get(key);
    if (x === undefined || y === undefined) {
      console.log(`  only ${x === undefined ? "Conn" : "T3"} writes ${key}`);
      continue;
    }
    const same = x.size === y.size && [...x].every((v) => y.has(v));
    if (same) {
      console.log(`ok   providerInstanceId of ${key}: ${[...x].join(", ")}`);
    } else {
      failures++;
      console.log(`FAIL providerInstanceId of ${key}: T3 ${[...x].join(", ")} | Conn ${[...y].join(", ")}`);
    }
  }
  return failures;
}

const sides = [makeSide("t3"), makeSide("conn")];
let exitCode = 0;
try {
  const results = await Promise.allSettled(sides.map((side) => sequence(side)));
  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.log(`FAIL ${sides[i].name} sequence: ${result.reason?.stack ?? result.reason}`);
      console.log(sides[i].serverOutput.slice(-3000));
      exitCode = 1;
    }
  }
  const { failures, known } = compare(sides[0], sides[1]);
  console.log(
    `\n${sides[0].steps.length} steps, ${failures} differ, ${known} known difference(s)`,
  );
  if (failures > 0) exitCode = 1;
  const instanceFailures = compareInstances(sides[0], sides[1]);
  console.log(`${instanceFailures} event type(s) differ in providerInstanceId`);
  if (instanceFailures > 0) exitCode = 1;
} finally {
  await Promise.all(sides.map((side) => side.stop().catch(() => {})));
  if (keep) console.log(`kept ${root}`);
  else NodeFS.rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);

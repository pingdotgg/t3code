#!/usr/bin/env node
// STUBBED Codex app-server for #15250 runtime evidence. Not real Codex.
//
// Speaks newline-delimited JSON-RPC over stdio like `codex app-server`. The
// fixture comes from the turn prompt (`fixture=<name>`), so one server can run
// every row as its own thread; one process can host several threads, so state
// is kept per parent thread. Frames for a row's threads are appended to
// `$EV_LOG_DIR/req-<fixture>.ndjson`; everything else goes to
// `req-_session-<pid>.ndjson`.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const LOG_DIR = process.env.EV_LOG_DIR ?? "/tmp/ev-22830/raw";
NodeFS.mkdirSync(LOG_DIR, { recursive: true });

const PARENT_TURN_MS = Number(process.env.EV_PARENT_TURN_MS ?? 80_000);
let parentCount = 0;
// parent thread id -> { parent, turn, fixture, child, attempts }
const rows = new Map();
const rowFor = (threadId) =>
  rows.get(threadId) ?? [...rows.values()].find((row) => row.child === threadId);

const log = (row, entry) =>
  NodeFS.appendFileSync(
    `${LOG_DIR}/req-${row?.fixture ?? `_session-${process.pid}`}.ndjson`,
    `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`,
  );
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (row, method, params) => {
  log(row, {
    dir: "out",
    method,
    threadId: params.threadId,
    note: params.item?.kind ?? params.toModel,
  });
  send({ method, params });
};
const err = (id, message) => send({ id, error: { code: -32603, message } });
const nowSec = () => Math.floor(Date.now() / 1000);

const turn = (row, status) => ({
  id: row.turn,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: nowSec(),
  completedAt: status === "inProgress" ? null : nowSec(),
  durationMs: null,
});

const threadRecord = (id, cwd) => ({
  id,
  sessionId: id,
  forkedFromId: null,
  preview: "",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: nowSec(),
  updatedAt: nowSec(),
  status: { type: "idle" },
  path: `/tmp/${id}.jsonl`,
  cwd,
  cliVersion: "0.144.0",
  source: "vscode",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  projectId: null,
  turns: [],
});

const OK_READ = (id) => ({ thread: { id, model: "gpt-6-luna", reasoningEffort: "high" } });
const OK_RESUME = (id) => ({
  thread: { id },
  model: "gpt-6-luna",
  reasoningEffort: "high",
  serviceTier: null,
});
const FAIL_READ = () => ({ err: "rollout is empty" });
const FAIL_RESUME = () => ({ err: "temporary worktree fault" });

// Each fixture maps (method, attempt index) to a child-thread reply; `null`
// never answers. `after` emits a notification once after that reply.
const FIXTURES = {
  // R1: first lookup succeeds.
  "first-ok": { read: (row) => ({ ok: OK_READ(row.child) }), resume: FAIL_RESUME },
  // R2a: attempt 0 read + resume fail, then read succeeds.
  "retry-ok": {
    read: (row, n) => (n === 0 ? FAIL_READ() : { ok: OK_READ(row.child) }),
    resume: FAIL_RESUME,
  },
  // R3: always failing.
  "always-fail": { read: FAIL_READ, resume: FAIL_RESUME },
  // R3b: read never answers.
  "always-hang": { read: () => null, resume: FAIL_RESUME },
  // R4a: failing, and the child is interrupted after attempt 0.
  interrupted: {
    read: FAIL_READ,
    resume: FAIL_RESUME,
    after: { method: "thread/resume", index: 0, delayMs: 200, emit: "interrupt" },
  },
  // R5: failing, and model/rerouted arrives between attempts 0 and 1.
  rerouted: {
    read: FAIL_READ,
    resume: FAIL_RESUME,
    after: { method: "thread/resume", index: 0, delayMs: 200, emit: "reroute" },
  },
  // R6: read reports no model, resume reports it.
  "read-empty-resume-ok": {
    read: (row) => ({ ok: { thread: { id: row.child, model: null } } }),
    resume: (row) => ({ ok: OK_RESUME(row.child) }),
  },
};

const emitAfter = (row, kind) => {
  if (kind === "interrupt") {
    notify(row, "item/completed", {
      threadId: row.parent,
      turnId: row.turn,
      completedAtMs: Date.now(),
      item: {
        type: "subAgentActivity",
        id: "call-ev-interrupt",
        kind: "interrupted",
        agentThreadId: row.child,
        agentPath: "/root/ev_agent",
      },
    });
  } else if (kind === "reroute") {
    notify(row, "model/rerouted", {
      threadId: row.child,
      turnId: row.turn,
      fromModel: "gpt-6-luna",
      toModel: "gpt-5.6-sol",
      reason: "highRiskCyberActivity",
    });
  }
};

const answerChild = (row, id, method) => {
  const index = row.attempts[method]++;
  const script = FIXTURES[row.fixture] ?? FIXTURES["always-fail"];
  const reply = (method === "thread/read" ? script.read : script.resume)(row, index);
  log(row, {
    dir: "reply",
    method,
    threadId: row.child,
    attempt: index,
    reply: reply === null ? "hang" : reply.err ? `err:${reply.err}` : "ok",
  });
  if (reply?.err) err(id, reply.err);
  else if (reply) send({ id, result: reply.ok });
  const after = script.after;
  if (after && after.method === method && after.index === index) {
    setTimeout(() => emitAfter(row, after.emit), after.delayMs);
  }
};

const MODEL = {
  id: "gpt-5.4",
  model: "gpt-5.4",
  displayName: "GPT-5.4 (stub)",
  description: "STUBBED Codex model",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Medium" },
    { reasoningEffort: "high", description: "High" },
  ],
};

const startTurn = (row) => {
  notify(row, "turn/started", { threadId: row.parent, turn: turn(row, "inProgress") });
  setTimeout(
    () =>
      notify(row, "item/completed", {
        threadId: row.parent,
        turnId: row.turn,
        completedAtMs: Date.now(),
        item: {
          type: "subAgentActivity",
          id: "call-ev-spawn",
          kind: "started",
          agentThreadId: row.child,
          agentPath: "/root/ev_agent",
        },
      }),
    100,
  );
  // The parent turn stays open across the whole retry window (~62s), then completes.
  setTimeout(() => {
    notify(row, "item/completed", {
      threadId: row.parent,
      turnId: row.turn,
      completedAtMs: Date.now(),
      item: {
        type: "agentMessage",
        id: "ev-final",
        text: "STUB_DONE",
        phase: "final_answer",
        memoryCitation: null,
      },
    });
    notify(row, "turn/completed", { threadId: row.parent, turn: turn(row, "completed") });
  }, PARENT_TURN_MS);
};

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = frame;
  if (method === undefined) return; // responses to server requests
  const threadId = params?.threadId;
  if (method === "turn/start" && rows.has(threadId)) {
    const row = rows.get(threadId);
    const text = params?.input?.find?.((part) => part.type === "text")?.text ?? "";
    row.fixture = /fixture=([\w-]+)/.exec(text)?.[1] ?? "always-fail";
    row.child = `child-${row.fixture}-${process.pid}`;
  }
  const row = threadId === undefined ? undefined : rowFor(threadId);
  log(row, { dir: "in", method, id, threadId });
  if (id === undefined) return; // notifications such as `initialized`

  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          userAgent: "codex_cli_rs/0.144.0 (STUBBED Codex app-server)",
          codexHome: "/tmp/ev-22830/codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
    case "account/read":
      return send({ id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: false } });
    case "model/list":
      return send({ id, result: { data: [MODEL], nextCursor: null } });
    case "skills/list":
      return send({ id, result: { data: [] } });
    case "config/read":
      return send({ id, result: { config: {} } });
    case "mcpServerStatus/list":
      return send({ id, result: { data: [], nextCursor: null } });
    case "turn/interrupt":
      return send({ id, result: {} });
    case "thread/start": {
      const parent = `parent-${process.pid}-${++parentCount}`;
      rows.set(parent, {
        parent,
        turn: `turn-${parent}`,
        fixture: null,
        child: null,
        attempts: { "thread/read": 0, "thread/resume": 0 },
      });
      const cwd = params?.cwd ?? process.cwd();
      return send({
        id,
        result: {
          thread: threadRecord(parent, cwd),
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd,
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      });
    }
    case "turn/start":
      if (row === undefined) return err(id, "unknown thread");
      send({ id, result: { turn: turn(row, "inProgress") } });
      return startTurn(row);
    case "thread/read":
    case "thread/resume":
      if (row !== undefined && threadId === row.child) return answerChild(row, id, method);
      return send({
        id,
        result: {
          thread: { ...threadRecord(threadId ?? "unknown", process.cwd()), model: "gpt-5.4" },
          model: "gpt-5.4",
          reasoningEffort: "medium",
          serviceTier: null,
        },
      });
    default:
      return send({
        id,
        error: { code: -32601, message: `STUBBED Codex app-server: ${method} unsupported` },
      });
  }
});

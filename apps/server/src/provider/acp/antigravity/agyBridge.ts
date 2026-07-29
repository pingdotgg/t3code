/**
 * ACP compatibility bridge for the Antigravity CLI (`agy`).
 *
 * Antigravity exposes no native agent protocol. This module speaks the slice
 * of ACP that `AcpSessionRuntime` uses over stdio and executes each turn
 * through Antigravity's documented non-interactive `--print` mode, while
 * reconstructing a live event stream from hooks and the trajectory transcript
 * (see `agyEvents.ts` and `agyTranscript.ts`).
 *
 * Runs as a subcommand of the server binary (`t3 agy-acp`) so it ships inside
 * the same bundle rather than as a loose script.
 *
 * @module provider/acp/antigravity/agyBridge
 */
// @effect-diagnostics nodeBuiltinImport:off - Standalone stdio bridge process, not an Effect runtime.
// @effect-diagnostics globalTimers:off - Polls Antigravity hook output outside any Effect runtime.
// @effect-diagnostics globalDate:off - Approval deadlines are measured in the hook subprocess, which has no Clock.
/* eslint-disable t3code/no-global-process-runtime -- Standalone process: there
   is no Effect runtime here to inject HostProcessPlatform from. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import packageJson from "../../../../package.json" with { type: "json" };
import {
  agyHookResponse,
  approvalOutcomeToDecision,
  agyTargetPath,
  agyToolCallId,
  agyToolKind,
  agyToolTitle,
  hookSessionUpdate,
  makeAgyTurnState,
  orderAgySessionUpdates,
  type AgyHookDecision,
  type AgyHookEvent,
  type AgyHookPayload,
  type AgyOrderedSessionUpdate,
  type AgySessionUpdate,
  type AgyTurnState,
} from "./agyEvents.ts";
import {
  AgyTranscriptCursor,
  dropPriorTurnRecords,
  MAX_TRANSCRIPT_LINE_CHARS,
  parseTranscriptLine,
  serializedTranscriptRecordSize,
  transcriptRecordUpdates,
} from "./agyTranscript.ts";

const HOOK_DIR_ENV = "T3_AGY_HOOK_DIR";
const REQUIRE_APPROVAL_ENV = "T3_AGY_REQUIRE_APPROVAL";
/** Suffix of the file the bridge writes to answer a waiting `PreToolUse` hook. */
const DECISION_SUFFIX = ".decision";
/**
 * How long a `PreToolUse` hook blocks waiting for the user. Antigravity's own
 * hook timeout is set above this so the deny below is what actually lands,
 * rather than the CLI abandoning the hook first.
 */
const APPROVAL_WAIT_MS = 10 * 60 * 1000;
const APPROVAL_HOOK_TIMEOUT_SECONDS = 11 * 60;
const APPROVAL_POLL_INTERVAL_MS = 50;
/** Grace period before a cancelled process group is killed outright. */
const KILL_ESCALATION_MS = 5_000;
/** Backstop when a child reports `error` but never follows it with `close`. */
const CHILD_ERROR_CLOSE_GRACE_MS = KILL_ESCALATION_MS + 1_000;
/** Secret shared with hook processes so a decision cannot be forged. */
const HOOK_SECRET_ENV = "T3_AGY_HOOK_SECRET";
const HOOK_POLL_INTERVAL_MS = 50;
/** Total finalization time allowed for stdout to recover from backpressure. */
const STDOUT_DRAIN_GRACE_MS = 1_000;
/**
 * Drains a transcript record waits for the hook that would announce its tool
 * call. Twenty polls is a second — long enough for a hook that is merely late,
 * short enough that a step no hook will ever cover does not stall the stream.
 */
const MAX_DEFERRED_DRAINS = 20;

/**
 * Aggregate ceiling on records held waiting for a tool call to be announced.
 *
 * `MAX_DEFERRED_DRAINS` expires the head of the queue, which is enough when
 * unmatched records are occasional. It is not enough when they arrive faster
 * than one per drain, which is what a transcript full of internal planner steps
 * looks like — hence a cap on the queue as a whole.
 */
const MAX_DEFERRED_RECORDS = 512;
const MAX_DEFERRED_CHARS = 8 * 1024 * 1024;
/**
 * Cap on the `agy` output held in memory per stream. Only the tail is kept:
 * stdout is a fallback used when the transcript streamed nothing, and stderr
 * only needs to explain a failure.
 */
const MAX_CAPTURED_OUTPUT = 256 * 1024;

/**
 * Ceiling on one transcript read. Keeps a single poll from allocating a buffer
 * the size of whatever a tool just wrote; the rest is read by the next poll.
 */
const MAX_TRANSCRIPT_READ_BYTES = 1024 * 1024;

/**
 * Backstop on how many extra passes the final drain will make to consume a
 * transcript tail larger than one read. Set far above any real transcript —
 * this exists so a file being appended to faster than it is read cannot spin
 * the exit path forever, not to bound normal output.
 */
const MAX_FINAL_DRAIN_PASSES = 512;
const DEFAULT_PRINT_TIMEOUT = "2h";
const HOOKS_KEY = "t3code-antigravity-observer";

interface BridgeSession {
  readonly cwd: string;
  systemPrompt: string | undefined;
  conversationId: string | undefined;
  /**
   * Model and effort for the next turn. Seeded from the spawn environment and
   * replaced by `session/set_model`; both are command-line flags on every
   * spawn, so a change takes effect on the following turn without disturbing
   * the conversation it resumes.
   */
  model: string | undefined;
  effort: string | undefined;
}

const sessions = new Map<string, BridgeSession>();

// ── Session id ⇄ Antigravity conversation id ──────────────────────────
//
// `session/new` must return an id before the first turn runs, which is before
// Antigravity has created a trajectory. The mapping is persisted so a later
// `session/load` — potentially in a fresh bridge process — can still resume
// the right conversation.

/**
 * Where Antigravity keeps a conversation's trajectory.
 *
 * Layout confirmed against real conversations:
 * `<appDataDir>/brain/<conversation-uuid>/.system_generated/logs/`.
 */
function transcriptDirFor(conversationId: string): string {
  const appDataDir =
    process.env["T3_AGY_APP_DATA_DIR"]?.trim() ||
    NodePath.join(NodeOS.homedir(), ".gemini", "antigravity-cli");
  return NodePath.join(appDataDir, "brain", conversationId, ".system_generated", "logs");
}

/**
 * Bytes already in a resumed conversation's transcript before this turn runs.
 *
 * A positive baseline, taken before `agy` is spawned, is what makes "records
 * from earlier turns" precise. Inferring the boundary from the last
 * `USER_INPUT` record cannot: the file always contains previous ones, so a
 * poll landing before the new marker is written would treat an earlier turn's
 * output as live. Returns 0 when the file cannot be measured, which falls back
 * to the marker heuristic rather than skipping the turn's own output.
 */
function transcriptBaseline(
  conversationId: string | undefined,
): { readonly path: string; readonly size: number } | undefined {
  if (!conversationId) {
    return undefined;
  }
  // Path and size come from one measurement and are used together. Deciding
  // the file twice would let the condensed transcript appear between the two
  // and apply an offset taken from `transcript_full.jsonl` to a different
  // file — which, if it exceeded that file's size, reads nothing at all.
  const dir = transcriptDirFor(conversationId);
  const condensed = NodePath.join(dir, "transcript.jsonl");
  const full = NodePath.join(dir, "transcript_full.jsonl");
  for (const path of [condensed, full]) {
    try {
      return { path, size: NodeFS.statSync(path).size };
    } catch {
      // Try the sibling, then report nothing measurable.
    }
  }
  return undefined;
}

function stateDirPath(): string {
  const appDataDir =
    process.env["T3_AGY_APP_DATA_DIR"]?.trim() ||
    NodePath.join(NodeOS.homedir(), ".gemini", "antigravity-cli");
  return NodePath.join(appDataDir, "t3code-acp-sessions");
}

/**
 * One file per session rather than a shared map.
 *
 * Several bridge processes can finish turns at once, and a shared map means a
 * read-modify-write: two writers would each rebuild it from their own stale
 * snapshot and the later rename would drop the other's entry, silently losing
 * a thread's conversation. Independent files never contend.
 *
 * Returns undefined for a session id that is not a plain token, since the id
 * becomes a filename and is supplied by the client.
 */
function sessionFilePath(sessionId: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ? NodePath.join(stateDirPath(), `${sessionId}.json`)
    : undefined;
}

function persistConversationId(sessionId: string, conversationId: string): void {
  const target = sessionFilePath(sessionId);
  if (!target) {
    return;
  }
  try {
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    // Written aside and renamed so a reader never sees a partial file.
    const staging = `${target}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
    NodeFS.writeFileSync(staging, JSON.stringify({ conversationId }));
    NodeFS.renameSync(staging, target);
  } catch {
    // Losing the mapping costs conversation continuity on the next resume,
    // which is not worth failing a turn over.
  }
}

/**
 * Map a bridge session id to the Antigravity conversation it should resume.
 *
 * The persisted record is the only authority. Bridge session ids are random
 * UUIDs themselves, so an id that merely looks like a conversation id is
 * indistinguishable from one the bridge minted — falling back to the shape of
 * the string would make `session/load` resume a conversation that never
 * existed. Returning undefined starts a fresh one, which is recoverable.
 */
function lookupConversationId(sessionId: string): string | undefined {
  const target = sessionFilePath(sessionId);
  if (!target) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(target, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    // Validated rather than cast: the bridge does not exclusively own this
    // file, and a non-string value would throw and leave the request that read
    // it unanswered.
    const value = (parsed as { conversationId?: unknown }).conversationId;
    return typeof value === "string" ? value.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

// ── JSON-RPC plumbing ─────────────────────────────────────────────────

/**
 * Set while stdout has reported that it is behind.
 *
 * Node buffers whatever `write` cannot hand over immediately, so ignoring its
 * return value turns a slow reader into unbounded growth inside this process.
 * Polling pauses while this is set. Nothing is lost by waiting: the transcript
 * stays on disk and is read from its own byte offset, so a skipped poll only
 * defers work to the next one.
 */
let stdoutBlocked = false;

function writeMessage(value: unknown): void {
  const flushed = process.stdout.write(`${JSON.stringify(value)}\n`);
  if (!flushed && !stdoutBlocked) {
    stdoutBlocked = true;
    process.stdout.once("drain", () => {
      stdoutBlocked = false;
    });
  }
}

/**
 * Wait for stdout to accept more data, but never past the finalization budget.
 *
 * `writeMessage` remains synchronous: this wait is used only by async turn
 * finalization between transcript drain passes. Its own listener continues to
 * clear `stdoutBlocked`, including when no turn is currently waiting here.
 */
function waitForStdoutDrain(deadline: number): Promise<boolean> {
  if (!stdoutBlocked) {
    return Promise.resolve(false);
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.resolve(stdoutBlocked);
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (timedOut: boolean) => {
      process.stdout.off("drain", onDrain);
      if (timer) {
        clearTimeout(timer);
      }
      resolve(timedOut);
    };
    const onDrain = () => finish(false);
    process.stdout.once("drain", onDrain);
    timer = setTimeout(() => finish(stdoutBlocked), remaining);
  });
}

function sendResult(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id: unknown, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendSessionUpdate(sessionId: string, update: AgySessionUpdate): void {
  writeMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

// ── Outbound requests ─────────────────────────────────────────────────
//
// The bridge is the ACP agent, so asking the client to approve a tool means
// issuing a request in the other direction and correlating the reply.

let nextOutboundId = 1;
const pendingOutbound = new Map<
  number,
  {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    /** Deadline for this request; cleared when it settles. */
    timer?: ReturnType<typeof setTimeout>;
  }
>();

function sendRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
  const id = nextOutboundId;
  nextOutboundId += 1;
  return new Promise((resolve, reject) => {
    const pending: {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    } = { resolve, reject };
    pendingOutbound.set(id, pending);
    if (timeoutMs !== undefined) {
      // A client that never answers would otherwise pin this entry for the
      // life of the bridge process. Held on the entry so an answered request
      // can drop it — `unref` keeps the timer from holding the loop open but
      // still retains the closure until it fires.
      const timer = setTimeout(() => {
        if (pendingOutbound.delete(id)) {
          reject(new Error(`${method} timed out`));
        }
      }, timeoutMs);
      timer.unref?.();
      pending.timer = timer;
    }
    writeMessage({ jsonrpc: "2.0", id, method, params });
  });
}

/**
 * Settle an outbound request from a client reply. Returns false when the id is
 * not one of ours, so the caller can treat the message as a request instead.
 */
function resolveOutbound(message: Record<string, unknown>): boolean {
  const id = message["id"];
  if (typeof id !== "number" || !pendingOutbound.has(id)) {
    return false;
  }
  const pending = pendingOutbound.get(id);
  pendingOutbound.delete(id);
  if (!pending) {
    return false;
  }
  if (pending.timer) {
    clearTimeout(pending.timer);
  }
  const error = message["error"];
  if (isRecord(error)) {
    const detail = typeof error["message"] === "string" ? error["message"] : "request failed";
    pending.reject(new Error(detail));
  } else {
    pending.resolve(message["result"]);
  }
  return true;
}

/** Reject everything still outstanding; used when the client goes away. */
function failPendingOutbound(reason: string): void {
  for (const [, pending] of pendingOutbound) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.reject(new Error(reason));
  }
  pendingOutbound.clear();
}

// ── Hook observer ─────────────────────────────────────────────────────

/**
 * Hook command the bridge registers with Antigravity. Re-invokes this same
 * binary so the observer always matches the running bridge.
 */
function hookCommandFor(event: string): string {
  const entry = process.argv[1];
  const base = entry
    ? `${quoteArg(process.execPath)} ${quoteArg(entry)}`
    : quoteArg(process.execPath);
  return `${base} agy-hook --event ${event}`;
}

function quoteArg(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
}

/**
 * Build a throwaway workspace directory whose only purpose is carrying
 * `.agents/hooks.json`. Antigravity loads `.agents` from every `--add-dir`
 * path, so the observer attaches without writing anything into the user's
 * repository.
 */
function createHookWorkspace(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-hooks-"));
  try {
    return writeHookWorkspace(dir);
  } catch (error) {
    // The caller never received the path, so it cannot clean this up itself.
    cleanupDir(dir);
    throw error;
  }
}

function writeHookWorkspace(dir: string): string {
  const agentsDir = NodePath.join(dir, ".agents");
  NodeFS.mkdirSync(agentsDir, { recursive: true });
  // A gating PreToolUse hook blocks while the user decides, so its timeout has
  // to outlast the bridge's own wait; observation-only hooks stay short.
  const preToolTimeout = approvalRequired() ? APPROVAL_HOOK_TIMEOUT_SECONDS : 10;
  const toolHook = (event: string, timeout: number) => [
    { matcher: "*", hooks: [{ type: "command", command: hookCommandFor(event), timeout }] },
  ];
  NodeFS.writeFileSync(
    NodePath.join(agentsDir, "hooks.json"),
    JSON.stringify(
      {
        [HOOKS_KEY]: {
          PreToolUse: toolHook("pre-tool-use", preToolTimeout),
          PostToolUse: toolHook("post-tool-use", 10),
          Stop: [{ type: "command", command: hookCommandFor("stop"), timeout: 10 }],
        },
      },
      null,
      2,
    ),
  );
  return dir;
}

/** A hook event plus the file it came from, which keys its decision reply. */
interface ObservedHook {
  readonly name: string;
  readonly event: AgyHookEvent;
}

function readHookEvents(hookDir: string, seen: Set<string>): ReadonlyArray<ObservedHook> {
  let entries: Array<string>;
  try {
    entries = NodeFS.readdirSync(hookDir);
  } catch {
    return [];
  }
  const events: Array<ObservedHook> = [];
  for (const name of entries.filter((n) => n.endsWith(".json")).sort()) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    try {
      const raw = NodeFS.readFileSync(NodePath.join(hookDir, name), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as AgyHookEvent;
        // The signed digest and the payload shown to the user must come from
        // the same bytes. Taking the outer `payload` for display while signing
        // `rawPayload` would let an attacker rewrite only the outer copy: the
        // user approves harmless-looking arguments, the hook's digest still
        // matches its untouched stdin, and the original request runs.
        const raw = record.rawPayload;
        if (typeof raw !== "string") {
          continue;
        }
        let payload: AgyHookPayload;
        try {
          const reparsed: unknown = JSON.parse(raw);
          if (typeof reparsed !== "object" || reparsed === null) {
            continue;
          }
          payload = reparsed as AgyHookPayload;
        } catch {
          continue;
        }
        hookPayloadDigests.set(name, digestPayload(raw));
        events.push({ name, event: { ...record, payload } });
        // Reclaimed as soon as its contents are in memory. An edit hook carries
        // the file it is about to change, up to `MAX_CAPTURED_FILE_BYTES` each,
        // and the directory only went away at the end of the turn — so a long
        // turn editing large files held every version of every one of them on
        // disk at once. The waiting hook never reads this file back; it polls
        // for its `.decision` sibling, which is written separately.
        try {
          NodeFS.unlinkSync(NodePath.join(hookDir, name));
        } catch {
          // Losing the reclaim is not worth failing the hook over; the whole
          // directory is removed when the turn ends.
        }
      }
    } catch {
      // A half-written hook file is picked up on the next poll.
      seen.delete(name);
    }
  }
  return events;
}

// ── Tool approval ─────────────────────────────────────────────────────

/**
 * Identity for one `runTurn`, used to bound the lifetime of its approvals.
 *
 * A cancel generation alone is not enough: a hook file first read after the
 * turn ended has no earlier generation to compare against, and a decision
 * banked from a dead turn must not carry into the next one.
 */
interface TurnToken {
  readonly sessionId: string;
  live: boolean;
}

function turnTokenLive(token: TurnToken): boolean {
  return token.live && !cancelledSessions.has(token.sessionId);
}

const APPROVE_OPTION = "allow";
const APPROVE_SESSION_OPTION = "allow-session";
const REJECT_OPTION = "reject";
/**
 * Sessions the user has approved wholesale via "always allow".
 *
 * Without an `allow_always` option the client maps that choice to no option id
 * at all and the reply reads as cancelled — which this gate denies. Offering
 * it and honouring it here is what makes the button mean what it says.
 */
const sessionWideApprovals = new Set<string>();

function approvalRequired(): boolean {
  return process.env[REQUIRE_APPROVAL_ENV]?.trim() === "1";
}

function decisionPath(hookDir: string, hookName: string): string {
  return NodePath.join(hookDir, `${hookName}${DECISION_SUFFIX}`);
}

/**
 * Authenticate a decision so only this bridge can issue one.
 *
 * The decision is a file in a temp directory, and anything running as the user
 * — including a tool the user has just approved — could otherwise drop an
 * `allow` there and have every later tool wave itself through. The secret is
 * generated per bridge process and reaches the hook through its environment,
 * so a forged file fails the check and is treated as no decision at all.
 */
function signDecision(
  secret: string,
  hookName: string,
  decision: AgyHookDecision,
  payloadDigest: string,
): string {
  // The payload digest is part of what is signed, so a decision cannot be
  // lifted onto a different request. Without it, a watcher could swap a
  // dangerous hook payload for a harmless one, let the user approve what they
  // were shown, and have the signed answer authorise the original.
  return NodeCrypto.createHmac("sha256", secret)
    .update(`${hookName}:${decision.decision}:${payloadDigest}`)
    .digest("hex");
}

function digestPayload(raw: string): string {
  return NodeCrypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Digest of each observed hook's raw payload, so a decision can be bound to the
 * exact request the user was shown.
 */
const hookPayloadDigests = new Map<string, string>();

function writeDecision(hookDir: string, hookName: string, decision: AgyHookDecision): void {
  try {
    const target = decisionPath(hookDir, hookName);
    const staging = `${target}.tmp`;
    NodeFS.writeFileSync(
      staging,
      JSON.stringify({
        ...decision,
        mac: signDecision(
          turnHookSecret,
          hookName,
          decision,
          hookPayloadDigests.get(hookName) ?? "",
        ),
      }),
    );
    NodeFS.renameSync(staging, target);
  } catch {
    // The waiting hook falls back to denying when its deadline passes, which
    // is the safe outcome for a permission gate.
  }
}

/**
 * Ask the client to approve one tool call, then hand the answer to the waiting
 * hook process through the shared directory.
 *
 * Fire-and-forget by design: `drain` runs on a timer and must not block the
 * transcript reader while a human decides.
 */
function selectedOptionId(result: unknown): string | undefined {
  const outcome = isRecord(result) ? result["outcome"] : undefined;
  const optionId = isRecord(outcome) ? outcome["optionId"] : undefined;
  return typeof optionId === "string" ? optionId : undefined;
}

function requestToolApproval(input: {
  readonly sessionId: string;
  readonly hookDir: string;
  readonly hookName: string;
  readonly payload: AgyHookPayload;
  /** The turn that asked. Approvals are only valid while it is still running. */
  readonly turnToken: TurnToken;
}): void {
  // Checked before the session-wide fast path, not after: a hook first seen
  // after a cancel would otherwise be waved through by a blanket approval.
  if (!turnTokenLive(input.turnToken)) {
    writeDecision(input.hookDir, input.hookName, {
      decision: "deny",
      reason: "Cancelled before this tool was approved",
    });
    return;
  }
  // Already approved for the whole session: answer without troubling the user.
  if (sessionWideApprovals.has(input.sessionId)) {
    writeDecision(input.hookDir, input.hookName, { decision: "allow" });
    return;
  }
  const toolCall = input.payload.toolCall;
  const stepIdx = typeof input.payload.stepIdx === "number" ? input.payload.stepIdx : 0;

  void sendRequest(
    "session/request_permission",
    {
      sessionId: input.sessionId,
      toolCall: {
        toolCallId: agyToolCallId(input.payload.conversationId, stepIdx),
        title: agyToolTitle(toolCall),
        kind: agyToolKind(toolCall?.name),
        status: "pending",
        rawInput: toolCall?.args ?? null,
        ...(agyTargetPath(toolCall) ? { locations: [{ path: agyTargetPath(toolCall) }] } : {}),
      },
      options: [
        { optionId: APPROVE_OPTION, name: "Allow", kind: "allow_once" },
        {
          optionId: APPROVE_SESSION_OPTION,
          name: "Allow for this session",
          kind: "allow_always",
        },
        { optionId: REJECT_OPTION, name: "Reject", kind: "reject_once" },
      ],
    },
    APPROVAL_WAIT_MS,
  )
    .then((result) => {
      // Re-checked at the moment of answering: the turn may have ended or been
      // cancelled while the user was deciding.
      const decision = !turnTokenLive(input.turnToken)
        ? ({
            decision: "deny",
            reason: "Cancelled before this tool was approved",
          } satisfies AgyHookDecision)
        : approvalOutcomeToDecision(result, [APPROVE_OPTION, APPROVE_SESSION_OPTION]);
      // Only recorded for a still-live turn. A blanket approval banked from a
      // turn that has already ended would silently pre-approve the next one.
      if (decision.decision === "allow" && selectedOptionId(result) === APPROVE_SESSION_OPTION) {
        sessionWideApprovals.add(input.sessionId);
      }
      writeDecision(input.hookDir, input.hookName, decision);
    })
    .catch(() => {
      writeDecision(input.hookDir, input.hookName, {
        decision: "deny",
        reason: "T3 Code could not obtain approval for this tool call",
      });
    });
}

/**
 * Largest file the hook will inline into its event record. A diff of anything
 * bigger is not worth the memory it would cost on both sides.
 */
const MAX_CAPTURED_FILE_BYTES = 2 * 1024 * 1024;

function captureFileText(path: string | undefined): string | null {
  if (!path) {
    return null;
  }
  try {
    const stats = NodeFS.statSync(path);
    if (!stats.isFile() || stats.size > MAX_CAPTURED_FILE_BYTES) {
      return null;
    }
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    // A new file has no prior contents; that is a valid diff with no oldText.
    return null;
  }
}

/** Entry point for `t3 agy-hook <event>`. */
export async function runAgyHook(event: string): Promise<void> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  const hookDir = process.env[HOOK_DIR_ENV]?.trim();
  // When approvals are required this process is a security gate, not an
  // observer. Any failure below — unparseable payload, unwritable hook
  // directory, a bridge that never answers — must deny, because the CLI has
  // already been told to skip its own permission prompts and nothing else
  // stands between the model and the tool.
  const gating = Boolean(hookDir) && approvalRequired() && event === "pre-tool-use";
  if (hookDir) {
    try {
      const payload = JSON.parse(raw) as AgyHookPayload;
      const record: AgyHookEvent = {
        event,
        payload,
        rawPayload: raw,
        // Snapshot the file here, while the hook still brackets the tool call.
        ...(agyToolKind(payload?.toolCall?.name) === "edit"
          ? { capturedFileText: captureFileText(agyTargetPath(payload?.toolCall)) }
          : {}),
      };
      const name = `${process.hrtime.bigint().toString().padStart(24, "0")}-${event}.json`;
      // Write then rename so the poller never observes a partial file.
      const finalPath = NodePath.join(hookDir, name);
      const tempPath = `${finalPath}.tmp`;
      NodeFS.writeFileSync(tempPath, JSON.stringify(record));
      NodeFS.renameSync(tempPath, finalPath);

      // With approvals on, this process is the gate: block until the bridge
      // reports the user's answer. `deny` here genuinely stops the tool —
      // Antigravity reports the reason back to the model.
      if (gating) {
        // Every gating path answers here. A payload without `toolCall` used to
        // fall through to the observation-only response, which allows — so a
        // change in Antigravity's payload shape would have run tools unapproved.
        const decision = payload?.toolCall
          ? await awaitDecision(hookDir, name, digestPayload(raw))
          : ({
              decision: "deny",
              reason: "T3 Code could not identify this tool call for approval",
            } satisfies AgyHookDecision);
        process.stdout.write(JSON.stringify(decision));
        return;
      }
    } catch {
      // Observation is best-effort: a hook must never break a tool call —
      // unless it is the approval gate, handled below.
      if (gating) {
        process.stdout.write(
          JSON.stringify({
            decision: "deny",
            reason: "T3 Code could not record this tool call for approval",
          } satisfies AgyHookDecision),
        );
        return;
      }
    }
  }

  process.stdout.write(JSON.stringify(agyHookResponse(event, Boolean(hookDir))));
}

/**
 * Wait for the bridge's answer to one `PreToolUse` hook.
 *
 * Fails closed: if the bridge dies, the client never answers, or the deadline
 * passes, the tool is denied rather than quietly allowed.
 */
async function awaitDecision(
  hookDir: string,
  hookName: string,
  payloadDigest: string,
): Promise<AgyHookDecision> {
  const target = decisionPath(hookDir, hookName);
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const raw = NodeFS.readFileSync(target, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && (parsed["decision"] === "allow" || parsed["decision"] === "deny")) {
        const decision = { decision: parsed["decision"] } as AgyHookDecision;
        const expected = signDecision(
          process.env[HOOK_SECRET_ENV] ?? "",
          hookName,
          decision,
          payloadDigest,
        );
        const presented = typeof parsed["mac"] === "string" ? parsed["mac"] : "";
        // Length-checked before comparing: `timingSafeEqual` throws on a
        // mismatch, and an unsigned file is a forgery either way.
        if (
          presented.length === expected.length &&
          NodeCrypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
        ) {
          return {
            decision: decision.decision,
            ...(typeof parsed["reason"] === "string" ? { reason: parsed["reason"] } : {}),
          };
        }
        // Unsigned or forged: ignore it and keep waiting, so a planted file
        // cannot allow a tool and cannot short-circuit a real decision either.
      }
    } catch {
      // Not written yet, or written partially; try again.
    }
    if (!NodeFS.existsSync(hookDir)) {
      // The turn is over and its directory reclaimed, so no decision can ever
      // land here. Stop waiting rather than polling a path that will not come
      // back.
      return { decision: "deny", reason: "Antigravity turn ended before approval" };
    }
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_INTERVAL_MS));
  }
  return { decision: "deny", reason: "Timed out waiting for approval in T3 Code" };
}

// ── Turn execution ────────────────────────────────────────────────────

function buildAgyArgs(input: {
  readonly session: BridgeSession;
  readonly hookWorkspace: string;
  readonly attachmentDir: string | undefined;
  readonly promptText: string;
}): Array<string> {
  const { session, hookWorkspace, attachmentDir } = input;
  const args = [
    "--dangerously-skip-permissions",
    "--print-timeout",
    process.env["T3_AGY_PRINT_TIMEOUT"]?.trim() || DEFAULT_PRINT_TIMEOUT,
  ];
  // Per session, not per process: `--model` applies to the turn being spawned
  // and composes with `--conversation`, so the trajectory survives a switch.
  const model = session.model?.trim();
  if (model) {
    args.push("--model", model);
  }
  const effort = session.effort?.trim();
  if (effort) {
    args.push("--effort", effort);
  }
  if (session.conversationId) {
    args.push("--conversation", session.conversationId);
  }
  // Print mode does not infer workspace customizations from cwd alone. The
  // session workspace is registered so its `.agents` skills and rules load;
  // the hook workspace is registered so the observer attaches.
  args.push("--add-dir", session.cwd, "--add-dir", hookWorkspace);
  if (attachmentDir) {
    args.push("--add-dir", attachmentDir);
  }
  args.push("--print", input.promptText);
  return args;
}

/** A local file referenced by a `resource_link` prompt block. */
interface PromptAttachment {
  readonly path: string;
  readonly name: string;
  readonly mimeType: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract local files from `resource_link` blocks.
 *
 * Only `file:` URIs are taken: a remote URL is left in the prompt text for the
 * agent's own fetch tool, and passing one to `--add-dir` would be meaningless.
 */
function collectAttachments(promptBlocks: ReadonlyArray<unknown>): {
  readonly files: ReadonlyArray<PromptAttachment>;
  readonly remoteUris: ReadonlyArray<string>;
} {
  const files: Array<PromptAttachment> = [];
  const remoteUris: Array<string> = [];
  for (const block of promptBlocks) {
    if (!isRecord(block) || block["type"] !== "resource_link") {
      continue;
    }
    const uri = block["uri"];
    if (typeof uri !== "string" || uri.length === 0) {
      continue;
    }
    if (!uri.startsWith("file://")) {
      // `resource_link` is baseline ACP, so a remote link has to reach the
      // agent: it goes into the prompt text for Antigravity's own fetch tool.
      remoteUris.push(uri);
      continue;
    }
    let filePath: string;
    try {
      filePath = NodeURL.fileURLToPath(uri);
    } catch {
      remoteUris.push(uri);
      continue;
    }
    const name = typeof block["name"] === "string" ? block["name"] : NodePath.basename(filePath);
    files.push({
      path: filePath,
      name,
      mimeType: typeof block["mimeType"] === "string" ? block["mimeType"] : undefined,
    });
  }
  return { files, remoteUris };
}

interface RenderedPrompt {
  readonly baseText: string;
  readonly attachments: ReadonlyArray<PromptAttachment>;
  readonly remoteUris: ReadonlyArray<string>;
}

function renderPrompt(session: BridgeSession, promptBlocks: unknown): RenderedPrompt | null {
  if (!Array.isArray(promptBlocks)) {
    return null;
  }
  const text = promptBlocks
    .filter(
      (block): block is { type: string; text: string } =>
        isRecord(block) && block["type"] === "text" && typeof block["text"] === "string",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();

  const { files, remoteUris } = collectAttachments(promptBlocks);
  if (text.length === 0 && files.length === 0 && remoteUris.length === 0) {
    return null;
  }

  const systemPrompt = session.systemPrompt?.trim();
  return {
    baseText: systemPrompt ? `System instructions:\n${systemPrompt}\n\nRequest:\n${text}` : text,
    attachments: files,
    remoteUris,
  };
}

/**
 * Copy this turn's attachments into a throwaway directory.
 *
 * `agy --print` has no attachment flag, so files must be named by path with
 * their directory registered via `--add-dir`. Registering the attachment store
 * itself would hand an auto-approving agent read access to every thread's
 * uploads, so only the files this turn references are staged, and the staging
 * directory dies with the turn.
 */
function stageAttachments(attachments: ReadonlyArray<PromptAttachment>): {
  readonly dir: string | undefined;
  readonly staged: ReadonlyArray<PromptAttachment>;
} {
  if (attachments.length === 0) {
    return { dir: undefined, staged: [] };
  }
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-attach-"));
  const staged: Array<PromptAttachment> = [];
  try {
    stageInto(dir, attachments, staged);
  } catch (error) {
    // Copies that already succeeded are user uploads; leaving them in /tmp
    // because a later one failed would outlive the turn that needed them.
    cleanupDir(dir);
    throw error;
  }
  return { dir, staged };
}

function stageInto(
  dir: string,
  attachments: ReadonlyArray<PromptAttachment>,
  staged: Array<PromptAttachment>,
): void {
  attachments.forEach((attachment, index) => {
    // Index-prefixed and sanitised so two attachments sharing a basename cannot
    // collide and a crafted name cannot escape the staging directory.
    const safeName = `${index}-${NodePath.basename(attachment.name).replace(/[^\w.-]+/g, "_")}`;
    const target = NodePath.join(dir, safeName);
    // Not swallowed: silently dropping an attachment would run the turn
    // against a prompt the user did not write, and an attachment-only request
    // would become an empty prompt that still reports success.
    NodeFS.copyFileSync(attachment.path, target);
    staged.push({ path: target, name: safeName, mimeType: attachment.mimeType });
  });
}

function composePromptText(
  baseText: string,
  staged: ReadonlyArray<PromptAttachment>,
  remoteUris: ReadonlyArray<string>,
): string {
  const blocks: Array<string> = [];
  if (staged.length > 0) {
    const list = staged.map((a) => `- ${a.path}${a.mimeType ? ` (${a.mimeType})` : ""}`).join("\n");
    blocks.push(`Attached files (read them from these paths):\n${list}`);
  }
  if (remoteUris.length > 0) {
    blocks.push(`Attached links (fetch them):\n${remoteUris.map((u) => `- ${u}`).join("\n")}`);
  }
  return [baseText, ...blocks].filter((part) => part.length > 0).join("\n\n");
}

interface TurnOutcome {
  readonly stopReason: "end_turn" | "cancelled";
  readonly failure?: string;
}

/**
 * Secret authenticating this turn's approval decisions.
 *
 * Rotated per turn, not per process. The secret has to reach the hook, the hook
 * is spawned by `agy`, and every tool `agy` runs inherits that environment — so
 * an approved tool can always forge decisions for the turn it is part of.
 * Rotating means it cannot forge for any later turn.
 */
let turnHookSecret = "";

let activeChild: NodeChildProcess.ChildProcess | null = null;

/**
 * Stop the running turn's whole process group, escalating if it lingers.
 *
 * Signalling only the direct child leaves anything it spawned running: a tool
 * mid-write keeps changing the workspace after the user pressed Stop, and its
 * output can still arrive against a turn that has been reported cancelled.
 */
/**
 * Children whose group has been signalled, so a fence and the cancel behind it
 * do not arm two backstops for the same process.
 */
const pendingKills = new Map<
  NodeChildProcess.ChildProcess,
  { readonly pid: number; timer?: ReturnType<typeof setTimeout> }
>();

/**
 * Signal a child's process group — but only while the child is alive.
 *
 * A group id is safe to use only while the leader still holds it. Once the
 * leader has been reaped the number is free for reuse, and a signal sent then
 * can land on whatever inherited it. Every call site is therefore guarded on
 * the leader being alive, and nothing signals a group after its `exit` event.
 *
 * The cost is that a tool which deliberately outlives `agy` is not reaped. That
 * is the same boundary the approval gate draws: code the user has already
 * approved can do what it likes, including backgrounding itself.
 */
function signalGroupOf(
  child: NodeChildProcess.ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    // No process groups; this walks the tree while the leader still anchors it.
    try {
      NodeChildProcess.execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Nothing left to signal.
      }
    }
    return;
  }
  try {
    // Negative pid targets the group, which `detached: true` gave the child.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Nothing left to signal.
    }
  }
}

function clearPendingKill(child: NodeChildProcess.ChildProcess): void {
  const pending = pendingKills.get(child);
  if (pending?.timer) {
    clearTimeout(pending.timer);
  }
  pendingKills.delete(child);
}

/** Release tracking when a child ends, so nothing signals it afterwards. */
function forgetChildOnExit(child: NodeChildProcess.ChildProcess): void {
  child.once("exit", () => {
    clearPendingKill(child);
  });
}

/** Kill every group still being tracked. Used on shutdown. */
function killPendingGroups(): void {
  for (const [child, pending] of pendingKills) {
    signalGroupOf(child, pending.pid, "SIGKILL");
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
  }
  pendingKills.clear();
}

function killActiveChild(options?: { readonly immediate?: boolean }): void {
  const child = activeChild;
  if (!child?.pid) {
    return;
  }
  const { pid } = child;
  // Windows goes through the same guarded helper. A `taskkill` here would run
  // against a numeric pid with no liveness check, and `close` can lag `exit`
  // long enough for Windows to have reused it.
  if (options?.immediate) {
    signalGroupOf(child, pid, "SIGKILL");
    clearPendingKill(child);
    return;
  }
  if (pendingKills.has(child)) {
    // Already signalled — a fence and the cancel behind it both land here. A
    // second timer would be another delayed signal nobody cancels.
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    // Leader already gone: the spawn-time handler has this, or has run.
    signalGroupOf(child, pid, "SIGKILL");
    return;
  }
  signalGroupOf(child, pid, "SIGTERM");
  const pending: { readonly pid: number; timer?: ReturnType<typeof setTimeout> } = { pid };
  pendingKills.set(child, pending);
  // The group is killed when the leader exits by the handler installed at
  // spawn, so nothing needs attaching here.
  //
  // Backstop for a leader that ignores SIGTERM outright. Safe to target by
  // group, because the leader is by definition still alive if this fires.
  const escalation = setTimeout(() => {
    if (pendingKills.get(child) === pending && child.exitCode === null) {
      signalGroupOf(child, pid, "SIGKILL");
    }
    clearPendingKill(child);
  }, KILL_ESCALATION_MS);
  escalation.unref?.();
  pending.timer = escalation;
}
/** Session whose turn is currently running, if any. Gates `session/cancel`. */
let activeTurnSessionId: string | null = null;
/**
 * Set once stdin closes. Queued prompts decline instead of spawning: killing
 * only the running child let the queue advance and start another `agy` after
 * the client had gone, which then ran to the print timeout.
 */
let shuttingDown = false;
const cancelledSessions = new Set<string>();
/**
 * Highest cancelled epoch per session.
 *
 * Each submission carries the adapter's cancel epoch, and an interrupt names
 * the epoch it is cancelling *through*. Everything at or below that is
 * cancelled; anything accepted afterwards has a higher epoch and is untouched.
 *
 * This replaces a set of individual prompt ids. Keying by id needed the set to
 * be bounded, and any eviction policy can drop a fence whose prompt has not
 * arrived yet — which would let exactly the prompt being cancelled run. A
 * single high-water mark per session cannot lose one and cannot grow.
 */
const cancelledThroughEpoch = new Map<string, number>();
/**
 * Sessions whose next queued prompt has been cancelled without an epoch.
 *
 * Only for clients that do not send fences: without an epoch there is nothing
 * to compare a queued prompt against, so a plain `session/cancel` for a
 * session whose turn has not started yet would be dropped and its prompt would
 * run afterwards. Consumed by the next prompt for that session.
 */
const unscopedCancels = new Set<string>();

function cancelledThrough(sessionId: string): number {
  return cancelledThroughEpoch.get(sessionId) ?? -1;
}

/**
 * Prompts accepted for a session but not yet handled, counting only those that
 * carry no epoch. A tagged prompt is already covered by the session's mark and
 * consumes no marker, so banking a cancel on its account would leave an entry
 * that only some later untagged prompt could consume.
 */
const queuedUntaggedCounts = new Map<string, number>();

function queuedUntagged(sessionId: string): number {
  return queuedUntaggedCounts.get(sessionId) ?? 0;
}

/** The adapter's cancel epoch for a submission, carried in `_meta.t3.epoch`. */
function promptEpochOf(params: Record<string, unknown>): number | undefined {
  const meta = params["_meta"];
  const t3 = isRecord(meta) ? meta["t3"] : undefined;
  const epoch = isRecord(t3) ? t3["epoch"] : undefined;
  return typeof epoch === "number" ? epoch : undefined;
}
/**
 * Cancel epoch of the turn currently running, or undefined when its prompt
 * carried no epoch. An untagged client is not using the extension, so it keeps
 * plain `session/cancel` semantics rather than being scoped by a mark it never
 * contributes to.
 */
let activeTurnEpoch: number | undefined;
/**
 * Temp directories the running turn owns.
 *
 * Tracked outside `runTurn` so a signal that ends the process can still remove
 * them: `process.exit` skips the cleanup at the end of the turn, and these hold
 * copies of the user's attachments and file contents captured around edits.
 */
const activeTurnTempDirs = new Set<string>();

function cleanupActiveTurnTempDirs(): void {
  for (const dir of activeTurnTempDirs) {
    cleanupDir(dir);
  }
  activeTurnTempDirs.clear();
}
/** Token of that turn, retired when its epoch is cancelled. */
let activeTurnToken: TurnToken | undefined;

/**
 * Drain everything Antigravity has produced so far and emit it as ACP updates.
 *
 * Hooks are ingested first so transcript records can match tool calls, then
 * both sources are emitted in Antigravity step order.
 */
function drain(input: {
  readonly sessionId: string;
  readonly hookDir: string;
  readonly seenHooks: Set<string>;
  readonly state: AgyTurnState;
  readonly cursor: AgyTranscriptCursor;
  readonly decoder: NodeStringDecoder.StringDecoder;
  readonly transcriptOffset: { value: number };
  readonly assistantText: { emitted: boolean };
  readonly turnToken: TurnToken;
  readonly final: boolean;
  /** Defaults to true; set false to run hook and terminal cleanup only. */
  readonly readTranscript?: boolean;
}): boolean {
  const bufferedUpdates: Array<AgyOrderedSessionUpdate> = [];
  const approvals: Array<{ readonly name: string; readonly payload: AgyHookPayload }> = [];
  for (const { name, event: hook } of readHookEvents(input.hookDir, input.seenHooks)) {
    // Diffing the file contents each hook captured, rather than the arguments
    // of the edit, keeps this correct across tools whose argument shapes
    // differ (`replace_file_content` sends a fragment, `write_to_file` sends
    // the whole file).
    const fileText = hook.capturedFileText ?? undefined;
    const update = hookSessionUpdate(hook, input.state, fileText);
    if (update) {
      const stepIdx = hook.payload?.stepIdx;
      if (
        hook.event === "post-tool-use" &&
        typeof stepIdx === "number" &&
        !input.state.transcriptSeenSteps.has(stepIdx)
      ) {
        // Held back rather than sent: the transcript record carrying this
        // step's real output is usually read later in this same pass, and a
        // completed call can no longer take content. Once that record has been
        // seen there is nothing left to wait for — and nothing to wait on,
        // since the transcript is read once by byte offset.
        input.state.pendingTerminal.set(stepIdx, update);
      } else {
        bufferedUpdates.push({
          stepIdx,
          phase: hook.event === "pre-tool-use" ? "pre" : "terminal",
          update,
        });
      }
    }
    // The hook process is blocked until a decision file appears, so this has
    // to be started for every announced tool call.
    if (approvalRequired() && hook.event === "pre-tool-use" && hook.payload?.toolCall) {
      if (input.final) {
        // The child has exited, so nothing will consume an approval — but the
        // hook subprocess may still be polling, and its directory is about to
        // be removed. Deny explicitly so it stops now instead of spinning until
        // its own timeout with no possible answer.
        writeDecision(input.hookDir, name, {
          decision: "deny",
          reason: "Antigravity turn ended before this tool was approved",
        });
      } else {
        approvals.push({ name, payload: hook.payload });
      }
    }
  }

  const transcriptPath =
    input.readTranscript === false ? undefined : resolveTranscriptPath(input.state);
  let moreTranscript = false;
  if (transcriptPath) {
    let chunk = "";
    try {
      const stats = NodeFS.statSync(transcriptPath);
      if (stats.size > input.transcriptOffset.value) {
        const fd = NodeFS.openSync(transcriptPath, "r");
        try {
          // Capped rather than sized to the whole unread region: a tool that
          // writes a very large record would otherwise have the bridge
          // allocate a buffer as big as its output in one go, which the 256
          // KiB stdout cap does nothing to prevent. Whatever is left is picked
          // up by the next poll, and the final drain loops until it is gone.
          const length = Math.min(
            stats.size - input.transcriptOffset.value,
            MAX_TRANSCRIPT_READ_BYTES,
          );
          const buffer = Buffer.alloc(length);
          // `readSync` may return fewer bytes than asked for. Decoding the
          // whole buffer would feed the zero-filled tail through as content
          // and skip the real bytes for good. Read until the measured range is
          // filled rather than relying on the next poll — the final drain has
          // no next poll, and would lose the tail along with whatever partial
          // record the cursor is about to flush.
          let bytesRead = 0;
          while (bytesRead < length) {
            const read = NodeFS.readSync(
              fd,
              buffer,
              bytesRead,
              length - bytesRead,
              input.transcriptOffset.value + bytesRead,
            );
            if (read <= 0) {
              break;
            }
            bytesRead += read;
          }
          // Decoded through the turn's streaming decoder, not `toString`: a
          // write can land mid-multibyte-character, and decoding each slice
          // independently would replace the partial sequence with U+FFFD and
          // advance past it, silently corrupting non-ASCII output.
          chunk = bytesRead > 0 ? input.decoder.write(buffer.subarray(0, bytesRead)) : "";
          input.transcriptOffset.value += bytesRead;
          moreTranscript = stats.size > input.transcriptOffset.value && bytesRead > 0;
        } finally {
          NodeFS.closeSync(fd);
        }
      }
    } catch {
      chunk = "";
    }

    const lines = chunk.length > 0 ? input.cursor.push(chunk) : [];
    let allLines = input.final ? [...lines, ...input.cursor.flush()] : lines;
    // Reading always starts at byte 0, so the first batch of a resumed
    // conversation carries every prior turn. Trim once, then stream.
    if (!input.state.transcriptPrimed && allLines.length > 0) {
      const trimmed = dropPriorTurnRecords(allLines);
      const foundBoundary = trimmed.length !== allLines.length;
      if (foundBoundary) {
        // A boundary observed after an overflow makes its suffix eligible
        // again: everything retained from here belongs after that input, while
        // text discarded before it remains permanently excluded.
        input.state.transcriptPrimingOverflowed = false;
      }
      if (input.state.resumedConversation && !input.final && moreTranscript) {
        // Still short of the end of the file, so no `USER_INPUT` seen so far can
        // be trusted to be this turn's: the current turn's opening record may
        // sit in bytes not yet read. Reads are capped, so this is the ordinary
        // case for a long transcript rather than an edge one.
        //
        // What is held back is `trimmed`, not the whole batch — history is
        // discarded as it is scanned, which is both what the turn wants and
        // what keeps the hold bounded to a single turn's output.
        if (
          !input.state.transcriptPrimingOverflowed &&
          !input.cursor.retainWithinLimit(trimmed, MAX_TRANSCRIPT_LINE_CHARS)
        ) {
          // Complete retained history is discarded, but a bounded partial line
          // at the read cutoff is preserved because it may be this turn's
          // USER_INPUT. Suppression remains active until that boundary is
          // observed, so a historical record completed from the carry is still
          // never emitted as current-turn output.
          input.state.transcriptPrimingOverflowed = true;
        }
        allLines = [];
      } else {
        // Overflow discarded an unknown part of the candidate turn. Without a
        // later input boundary, the remaining tail is just as likely to be old
        // history and must not be surfaced as current-turn output.
        allLines = input.state.transcriptPrimingOverflowed ? [] : [...trimmed];
        input.state.transcriptPrimed = true;
      }
    }
    // Records held from an earlier pass go first: their hook may have arrived
    // since, and they are older than anything read just now.
    const carried = input.state.deferredRecords.splice(0, input.state.deferredRecords.length);
    let remainingRecordChars = input.state.deferredRecordChars;
    input.state.deferredRecordChars = 0;
    const records = [
      ...carried,
      ...allLines.flatMap((line) => {
        const record = parseTranscriptLine(line);
        if (record === null) {
          return [];
        }
        const deferred = {
          record,
          serializedChars: serializedTranscriptRecordSize(record),
        };
        remainingRecordChars += deferred.serializedChars;
        return [deferred];
      }),
    ];

    // A deferral is a barrier, not a skip: everything after it is held too.
    // Emitting later records while an earlier one waits would put a tool's
    // output after text that followed it, and replay it out of order next pass.
    //
    // Bounded, because Antigravity emits steps for its own internal work that
    // no hook ever announces. Past the limit the held records are released in
    // order and any still unmatched are dropped, so an unhookable step costs
    // its own output rather than stalling everything behind it.
    const held = input.state.deferredRecords;
    // Only the record that actually waited out the bound is given up on, and
    // only while it is still at the head. Applying its age to the whole batch
    // would discard a record read moments ago that has had no chance at all.
    const agedHead = carried.length > 0 && input.state.deferredDrains >= MAX_DEFERRED_DRAINS;
    for (let index = 0; index < records.length; index += 1) {
      const deferredRecord = records[index];
      if (deferredRecord === undefined) {
        continue;
      }
      const record = deferredRecord.record;
      const result = transcriptRecordUpdates(record, input.state);
      if (!result.deferred) {
        // Something matched, so whatever was blocking the queue has cleared.
        input.state.deferredDrains = 0;
      } else if (input.final) {
        // Nothing further is coming; holding it would only lose it silently.
        remainingRecordChars -= deferredRecord.serializedChars;
        continue;
      } else if (index === 0 && agedHead) {
        // Waited its full budget with no hook. Drop just this one and let the
        // rest of the batch start over with a fresh budget.
        input.state.deferredDrains = 0;
        remainingRecordChars -= deferredRecord.serializedChars;
        continue;
      } else {
        held.push(...records.slice(index).filter((entry) => entry !== undefined));
        input.state.deferredRecordChars = remainingRecordChars;
        input.state.deferredDrains += 1;
        // Aged out one at a time, but refilled by every poll. Antigravity emits
        // internal steps far faster than one record per drain interval, so on a
        // transcript with unhookable steps the queue grows no matter how
        // patiently the head expires.
        //
        // Overflow is consumed rather than discarded: a record stuck behind an
        // unmatchable one may have had its own hook arrive in the meantime, and
        // dropping it unexamined would lose that tool's output for good. Each is
        // offered again on the way out; only those still unmatched are dropped.
        let heldChars = input.state.deferredRecordChars;
        let trimmed = false;
        while (held.length > MAX_DEFERRED_RECORDS || heldChars > MAX_DEFERRED_CHARS) {
          const candidate = held.shift();
          if (candidate === undefined) {
            break;
          }
          trimmed = true;
          heldChars -= candidate.serializedChars;
          const retried = transcriptRecordUpdates(candidate.record, input.state);
          if (retried.deferred) {
            continue;
          }
          for (const update of retried.updates) {
            bufferedUpdates.push({
              stepIdx: candidate.record.step_index,
              phase: "transcript",
              update,
            });
          }
          if (retried.emittedAssistantText) {
            input.assistantText.emitted = true;
          }
          const retriedStep = candidate.record.step_index;
          if (typeof retriedStep === "number") {
            const terminal = takeTerminal(input.state, retriedStep);
            if (terminal) {
              bufferedUpdates.push({
                stepIdx: retriedStep,
                phase: "terminal",
                update: terminal,
              });
            }
          }
        }
        input.state.deferredRecordChars = heldChars;
        if (trimmed) {
          // The head that had been accruing age is gone, so its budget must not
          // carry over to whatever is now in front — that record would expire
          // without ever having waited.
          input.state.deferredDrains = 0;
        }
        break;
      }
      for (const update of result.updates) {
        bufferedUpdates.push({
          stepIdx: record.step_index,
          phase: "transcript",
          update,
        });
      }
      if (result.emittedAssistantText) {
        input.assistantText.emitted = true;
      }
      // This step's output is out; the call can be completed now.
      const stepIndex = record.step_index;
      if (typeof stepIndex === "number") {
        const terminal = takeTerminal(input.state, stepIndex);
        if (terminal) {
          bufferedUpdates.push({
            stepIdx: stepIndex,
            phase: "terminal",
            update: terminal,
          });
        }
      }
      remainingRecordChars -= deferredRecord.serializedChars;
    }
  }

  // Nothing more will arrive, so anything still waiting on a transcript record
  // that never came is completed without output rather than left spinning.
  if (input.final) {
    const remaining = [...input.state.pendingTerminal];
    input.state.pendingTerminal.clear();
    for (const [stepIdx, terminal] of remaining) {
      bufferedUpdates.push({ stepIdx, phase: "terminal", update: terminal });
    }
  }

  for (const update of orderAgySessionUpdates(bufferedUpdates)) {
    sendSessionUpdate(input.sessionId, update);
  }
  for (const approval of approvals) {
    requestToolApproval({
      sessionId: input.sessionId,
      hookDir: input.hookDir,
      hookName: approval.name,
      payload: approval.payload,
      turnToken: input.turnToken,
    });
  }

  return moreTranscript;
}

function takeTerminal(state: AgyTurnState, stepIdx: number): AgySessionUpdate | undefined {
  const terminal = state.pendingTerminal.get(stepIdx);
  if (!terminal) {
    return undefined;
  }
  state.pendingTerminal.delete(stepIdx);
  return terminal;
}

/**
 * Hooks report `transcript_full.jsonl`; the sibling `transcript.jsonl` holds
 * the same steps without internal model chatter and is the better stream to
 * render.
 *
 * The choice is pinned for the rest of the turn. `transcriptOffset` and the
 * line cursor are byte positions into whichever file was picked, so switching
 * once the condensed file appears would resume reading at an offset that means
 * nothing in the new file — skipping records, or re-emitting ones already
 * streamed from the other one.
 */
function resolveTranscriptPath(state: AgyTurnState): string | undefined {
  if (state.resolvedTranscriptPath) {
    return state.resolvedTranscriptPath;
  }
  const reported = state.transcriptPath;
  if (!reported) {
    return undefined;
  }
  const condensed = reported.replace(/transcript_full\.jsonl$/, "transcript.jsonl");
  state.resolvedTranscriptPath = NodeFS.existsSync(condensed) ? condensed : reported;
  return state.resolvedTranscriptPath;
}

/**
 * Thrown when a cancel lands in the window between claiming the turn and
 * spawning `agy`. Carries no message: it never surfaces to the client, it only
 * unwinds setup through the same path a spawn failure takes.
 */
class TurnCancelledBeforeSpawn extends Error {}

async function runTurn(
  sessionId: string,
  session: BridgeSession,
  prompt: RenderedPrompt,
  promptEpoch: number | undefined,
): Promise<TurnOutcome> {
  // A cancel that raced the end of an earlier turn must not decide this one.
  cancelledSessions.delete(sessionId);

  // Claimed before any setup work: spawning `agy` takes long enough that a
  // cancel can land first, and cancels are only honoured for the session
  // holding this claim. Leaving it unset until after the spawn would silently
  // drop those, letting an auto-approving child run on past a cancelled turn.
  activeTurnSessionId = sessionId;
  // Claimed together. Setting the epoch later left a window where this turn
  // looked untagged, and an untagged turn is cancelled unconditionally — so a
  // late cancel carrying an older epoch would kill a turn it does not cover.
  activeTurnEpoch = promptEpoch;
  // Rotated before the spawn, so the child is handed this turn's secret: a tool
  // approved in an earlier turn holds that turn's, and cannot sign anything
  // this one will accept.
  turnHookSecret = NodeCrypto.randomBytes(32).toString("hex");
  // Measured before `agy` starts: whatever the transcript already holds
  // belongs to earlier turns of the conversation being resumed.
  const baseline = transcriptBaseline(session.conversationId);
  let hookDir: string | undefined;
  let hookWorkspace: string | undefined;
  let attachmentDir: string | undefined;
  let child: NodeChildProcess.ChildProcess;
  try {
    hookDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-hookout-"));
    activeTurnTempDirs.add(hookDir);
    hookWorkspace = createHookWorkspace();
    activeTurnTempDirs.add(hookWorkspace);
    const attachments = stageAttachments(prompt.attachments);
    attachmentDir = attachments.dir;
    if (attachmentDir) {
      activeTurnTempDirs.add(attachmentDir);
    }
    // Yielded to the event loop once, with the claim held and the directories
    // staged, before anything is spawned.
    //
    // Everything above this point is synchronous, so a `t3/fence` or
    // `session/cancel` already sitting in the stdin buffer could not be parsed
    // until after `agy` was running: the turn the user stopped still reached
    // the model, and was only killed afterwards. One turn of the event loop is
    // enough for the reader to deliver it, and the recheck below then declines
    // to spawn at all.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (
      shuttingDown ||
      cancelledSessions.has(sessionId) ||
      (promptEpoch !== undefined && promptEpoch <= cancelledThrough(sessionId))
    ) {
      throw new TurnCancelledBeforeSpawn();
    }

    const rawCommand = process.env["T3_AGY_COMMAND"]?.trim() || "agy";
    const spawnCommand = Effect.runSync(
      resolveSpawnCommand(
        rawCommand,
        buildAgyArgs({
          session,
          hookWorkspace,
          attachmentDir,
          promptText: composePromptText(prompt.baseText, attachments.staged, prompt.remoteUris),
        }),
      ),
    );
    child = NodeChildProcess.spawn(
      spawnCommand.command,
      spawnCommand.args,
      {
        cwd: session.cwd,
        env: { ...process.env, [HOOK_DIR_ENV]: hookDir, [HOOK_SECRET_ENV]: turnHookSecret },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so cancelling can reach the tools `agy`
        // spawned rather than only `agy` itself. A tool left running keeps
        // modifying the workspace after Stop.
        detached: true,
        shell: spawnCommand.shell,
      },
    );
  } catch (error) {
    // Setup failed or the turn was cancelled before it started, so no turn is
    // running: release the claim and reclaim the directories, or repeated
    // failures would leak one set each time.
    activeTurnSessionId = null;
    activeTurnEpoch = undefined;
    cleanupDir(hookDir);
    cleanupDir(hookWorkspace);
    cleanupDir(attachmentDir);
    if (hookDir) activeTurnTempDirs.delete(hookDir);
    if (hookWorkspace) activeTurnTempDirs.delete(hookWorkspace);
    if (attachmentDir) activeTurnTempDirs.delete(attachmentDir);
    if (error instanceof TurnCancelledBeforeSpawn) {
      // Nothing ran, so there is nothing to report but the cancellation. The
      // flag is consumed here because no later stage will reach the drain that
      // normally clears it.
      cancelledSessions.delete(sessionId);
      return { stopReason: "cancelled" };
    }
    throw error;
  }

  const state = makeAgyTurnState(session.conversationId);
  const seenHooks = new Set<string>();
  const cursor = new AgyTranscriptCursor();
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  const transcriptOffset = { value: baseline?.size ?? 0 };
  if (baseline && baseline.size > 0) {
    // Reading starts past every earlier turn, so there is no prior-turn
    // content left for the `USER_INPUT` heuristic to guess at. The turn is
    // pinned to the exact file the baseline was measured from.
    state.transcriptPrimed = true;
    state.resolvedTranscriptPath = baseline.path;
  }
  const assistantText = { emitted: false };
  const turnToken: TurnToken = { sessionId, live: true };
  // Published so an out-of-band fence covering this epoch can retire the turn
  // rather than being recorded for an arrival that already happened.
  activeTurnToken = turnToken;
  activeChild = child;
  if (child.pid !== undefined) {
    // Tracking is released the moment it ends, so nothing ever signals a group
    // id that is no longer ours.
    forgetChildOnExit(child);
  }
  // A cancel during startup had no process to signal; deliver it now.
  if (cancelledSessions.has(sessionId)) {
    killActiveChild();
  }

  // Both are kept as bounded tails. A turn that prints a large file — or a tool
  // that loops — would otherwise grow these strings for the whole run and take
  // the bridge's heap with it, turning a noisy turn into a dead provider.
  // stdout is only ever a fallback for when the transcript produced nothing,
  // and stderr only has to carry enough to explain a failure.
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const appendBounded = (current: string, chunk: string): [string, boolean] => {
    const combined = current + chunk;
    return combined.length <= MAX_CAPTURED_OUTPUT
      ? [combined, false]
      : [combined.slice(combined.length - MAX_CAPTURED_OUTPUT), true];
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const [next, dropped] = appendBounded(stdout, chunk);
    stdout = next;
    stdoutTruncated = stdoutTruncated || dropped;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const [next, dropped] = appendBounded(stderr, chunk);
    stderr = next;
    stderrTruncated = stderrTruncated || dropped;
  });

  const poller = setInterval(() => {
    // Skipped rather than queued behind a reader that is already behind.
    // `writeMessage` clears the flag on `drain`, so a later interval resumes
    // only after stdout has accepted its buffered data.
    if (stdoutBlocked) {
      return;
    }
    drain({
      sessionId,
      hookDir,
      seenHooks,
      state,
      cursor,
      decoder,
      transcriptOffset,
      assistantText,
      turnToken,
      final: false,
    });
  }, HOOK_POLL_INTERVAL_MS);

  let childError: Error | undefined;
  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    let missingCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (missingCloseTimer) {
        clearTimeout(missingCloseTimer);
      }
      resolve(code);
    };
    child.on("error", (error) => {
      childError = error;
      // An error can report a failed kill while the process is still alive.
      // The turn continues to own and poll the child until `close`; arm the
      // normal escalation rather than releasing its directories underneath it.
      if (
        activeChild === child &&
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        killActiveChild();
      }
      // Node normally follows `error` with `close`, including failed spawns.
      // Keep that path intact, but do not let a platform/runtime that omits
      // `close` pin the turn and its temp directories forever. The grace
      // outlasts the ordinary process-group escalation above.
      missingCloseTimer ??= setTimeout(() => settle(child.exitCode), CHILD_ERROR_CLOSE_GRACE_MS);
    });
    child.once("close", settle);
  });

  clearInterval(poller);
  activeChild = null;
  activeTurnSessionId = null;
  // Each pass reads at most `MAX_TRANSCRIPT_READ_BYTES`, so the tail of a large
  // transcript needs several. Only the last one runs as `final`: flushing the
  // cursor while bytes remain would emit a half-written record as if it were
  // whole, and leave the rest of that line to be read as a fragment.
  const stdoutDrainDeadline = Date.now() + STDOUT_DRAIN_GRACE_MS;
  let finalPasses = 0;
  let transcriptRemains: boolean;
  do {
    transcriptRemains = drain({
      sessionId,
      hookDir,
      seenHooks,
      state,
      cursor,
      decoder,
      transcriptOffset,
      assistantText,
      turnToken,
      final: false,
    });
    finalPasses += 1;
    if (!transcriptRemains || finalPasses >= MAX_FINAL_DRAIN_PASSES) {
      break;
    }
    const stdoutDrainTimedOut = await waitForStdoutDrain(stdoutDrainDeadline);
    if (stdoutDrainTimedOut) {
      break;
    }
  } while (transcriptRemains);
  if (transcriptRemains) {
    // Final draining stopped with bytes still unread. Flushing the cursor now
    // would present a half-written line as a whole record and then abandon the
    // rest in silence, so the partial line is dropped and the shortfall is said
    // out loud instead.
    cursor.flush();
    await waitForStdoutDrain(stdoutDrainDeadline);
    sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "[Transcript truncated: Antigravity produced more output than this turn could read.]",
      },
    });
  }
  await waitForStdoutDrain(stdoutDrainDeadline);
  drain({
    sessionId,
    hookDir,
    seenHooks,
    state,
    cursor,
    decoder,
    transcriptOffset,
    assistantText,
    turnToken,
    final: true,
    // Reading more after announcing truncation would emit records that follow
    // the notice, and abandon everything past that one extra read just as
    // silently. Once truncation is declared the transcript is closed; this pass
    // exists only to flush hooks and any terminal state still owed.
    readTranscript: !transcriptRemains,
  });

  // Any tool still open at exit would otherwise render as spinning forever.
  for (const [, call] of state.toolCalls) {
    if (call.completed) {
      continue;
    }
    sendSessionUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: call.toolCallId,
      status: "failed",
      rawOutput: { isError: true, error: "Antigravity exited before the tool reported completion" },
    });
  }
  state.toolCalls.clear();

  if (state.conversationId) {
    session.conversationId = state.conversationId;
    persistConversationId(sessionId, state.conversationId);
  }

  // Retired before the directories are reclaimed: any approval still in flight
  // now resolves to a denial rather than writing into a vanishing directory or
  // banking a blanket approval for the next turn.
  turnToken.live = false;
  // Scoped to the turn: every hook of every turn would otherwise stay in here
  // for the life of the bridge.
  hookPayloadDigests.clear();
  activeTurnEpoch = undefined;
  activeTurnToken = undefined;
  cleanupDir(hookDir);
  cleanupDir(hookWorkspace);
  cleanupDir(attachmentDir);
  activeTurnTempDirs.delete(hookDir);
  activeTurnTempDirs.delete(hookWorkspace);
  if (attachmentDir) {
    activeTurnTempDirs.delete(attachmentDir);
  }

  const cancelled = cancelledSessions.delete(sessionId);

  // The transcript already streamed the assistant text. stdout is only used
  // when transcript observation produced nothing, so the reply is never
  // duplicated.
  //
  // Emitted before the cancelled check, not after: a turn stopped mid-reply is
  // exactly the case where the transcript may not have been discovered yet,
  // and the partial answer already captured from stdout is the only record of
  // what the model said. A nonzero exit is excluded because it reports the same
  // bytes as its failure detail.
  if ((cancelled || exitCode === 0) && !assistantText.emitted && stdout.trim().length > 0) {
    // Says so when it is only the tail. Presenting a suffix as the whole reply
    // reads as a complete answer that happens to begin mid-sentence, which is
    // worse than admitting the beginning was dropped.
    const text = stdoutTruncated
      ? `[Earlier output dropped: the reply exceeded ${Math.floor(MAX_CAPTURED_OUTPUT / 1024)} KiB.]\n\n${stdout.trim()}`
      : stdout.trim();
    sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  }

  if (cancelled) {
    return { stopReason: "cancelled" };
  }
  if (exitCode !== 0 || childError !== undefined) {
    const processError = childError?.message.trim() ?? "";
    const processOutput = stderr.trim() || stdout.trim();
    const captured = [processError, processOutput].filter((part) => part.length > 0).join("\n");
    const truncated = stderr.trim() ? stderrTruncated : stdoutTruncated;
    const detail = captured
      ? truncated
        ? `[earlier output dropped] ${captured}`
        : captured
      : `agy exited with code ${exitCode}`;
    return { stopReason: "end_turn", failure: detail };
  }

  return { stopReason: "end_turn" };
}

function cleanupDir(dir: string | undefined): void {
  if (!dir) {
    return;
  }
  try {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp directories are reclaimed by the OS.
  }
}

// ── Request dispatch ──────────────────────────────────────────────────

async function handleRequest(message: Record<string, unknown>): Promise<void> {
  const method = typeof message["method"] === "string" ? message["method"] : undefined;
  const id = message["id"];
  const params = (message["params"] ?? {}) as Record<string, unknown>;

  if (!method) {
    return;
  }

  switch (method) {
    case "initialize": {
      const requested =
        typeof params["protocolVersion"] === "number" ? params["protocolVersion"] : 1;
      sendResult(id, {
        protocolVersion: Math.min(requested, 1),
        agentCapabilities: {
          loadSession: true,
          // Images ride in as `resource_link` blocks (an ACP baseline type)
          // rather than inline base64, so the `image` capability stays off.
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        authMethods: [],
        // The bridge has no version of its own; it ships with the server, so
        // that is the version worth reporting. The Antigravity CLI version is
        // reported separately by the provider snapshot (`agy --version`).
        agentInfo: { name: "Antigravity", version: packageJson.version },
      });
      return;
    }
    // Antigravity manages its own Google sign-in; there is nothing for the
    // client to authenticate against, but the handshake still requires a
    // successful reply.
    case "authenticate": {
      sendResult(id, {});
      return;
    }
    case "session/new":
    case "session/load": {
      const cwd = typeof params["cwd"] === "string" ? params["cwd"] : "";
      if (!cwd || !NodePath.isAbsolute(cwd)) {
        sendError(id, -32602, `${method} requires an absolute cwd`);
        return;
      }
      const requestedSessionId =
        typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
      const sessionId =
        method === "session/load" && requestedSessionId
          ? requestedSessionId
          : NodeCrypto.randomUUID();
      sessions.set(sessionId, {
        cwd,
        systemPrompt:
          typeof params["systemPrompt"] === "string" ? params["systemPrompt"] : undefined,
        conversationId: requestedSessionId ? lookupConversationId(requestedSessionId) : undefined,
        model: process.env["T3_AGY_MODEL"]?.trim() || undefined,
        effort: process.env["T3_AGY_EFFORT"]?.trim() || undefined,
      });
      sendResult(id, method === "session/load" ? {} : { sessionId });
      return;
    }
    // `--model` is a per-spawn flag that composes with `--conversation`, so a
    // switch applies from the next turn while the trajectory carries over.
    case "session/set_model": {
      const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        sendError(id, -32602, "unknown sessionId");
        return;
      }
      const modelId = typeof params["modelId"] === "string" ? params["modelId"].trim() : "";
      if (modelId.length === 0) {
        sendError(id, -32602, "session/set_model requires a modelId");
        return;
      }
      session.model = modelId;
      sendResult(id, {});
      return;
    }
    case "session/prompt": {
      const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!sessionId || !session) {
        sendError(id, -32602, "unknown sessionId");
        return;
      }
      if (shuttingDown) {
        // The client is gone; starting `agy` now would leave it running with
        // nobody to read its output.
        sendResult(id, { stopReason: "cancelled" });
        return;
      }
      // Compared against the session's cancelled high-water mark. A cancel
      // that outran this prompt raised that mark, and anything the user sends
      // afterwards carries a higher epoch and is unaffected.
      //
      // A prompt without an epoch is from a client that does not send fences,
      // so there is no mark it could be measured against — refusing it would
      // reject every prompt such a client ever sends once a mark exists.
      const promptEpoch = promptEpochOf(params);
      // One-shot, and only reachable for a client that sends no epochs.
      const unscopedCancelled = promptEpoch === undefined && unscopedCancels.delete(sessionId);
      if (
        unscopedCancelled ||
        (promptEpoch !== undefined && promptEpoch <= cancelledThrough(sessionId))
      ) {
        // Cancelled before it could start; never spawn `agy` for it.
        sendResult(id, { stopReason: "cancelled" });
        return;
      }
      const prompt = renderPrompt(session, params["prompt"]);
      if (prompt === null) {
        sendError(id, -32602, "session/prompt requires at least one text block");
        return;
      }
      const outcome = await runTurn(sessionId, session, prompt, promptEpoch);
      if (outcome.failure) {
        sendError(id, -32000, `Antigravity turn failed: ${outcome.failure}`);
        return;
      }
      sendResult(id, { stopReason: outcome.stopReason });
      return;
    }
    // Sent by the adapter immediately before it cancels, naming the epoch it
    // is cancelling through. Handled out of band: queued, it would sit behind
    // the very prompt it is meant to stop. Notifications carry no id, so
    // nothing is replied.
    case "t3/fence": {
      const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
      const epoch = typeof params["epoch"] === "number" ? params["epoch"] : undefined;
      if (!sessionId || epoch === undefined) {
        return;
      }
      cancelledThroughEpoch.set(sessionId, Math.max(cancelledThrough(sessionId), epoch));
      // A turn already running under a cancelled epoch has nothing left to
      // stop on arrival, so it is stopped here. Retiring the token is what
      // makes an approval still in flight deny, including one the client
      // would auto-approve.
      if (
        activeTurnToken?.sessionId === sessionId &&
        activeTurnEpoch !== undefined &&
        activeTurnEpoch <= epoch
      ) {
        activeTurnToken.live = false;
        cancelledSessions.add(sessionId);
        killActiveChild();
      }
      return;
    }
    case "session/cancel": {
      const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        return;
      }
      // Recorded before anything else. A cancel bypasses the request queue and
      // its prompt does not, so the two can arrive together with the prompt
      // still waiting — and returning early below would drop the epoch and let
      // that prompt spawn `agy` after the Stop that was meant to catch it.
      const cancelEpoch = typeof params["epoch"] === "number" ? params["epoch"] : undefined;
      if (cancelEpoch !== undefined) {
        cancelledThroughEpoch.set(sessionId, Math.max(cancelledThrough(sessionId), cancelEpoch));
      }
      if (sessionId !== activeTurnSessionId) {
        // No turn running for it yet. An untagged prompt has no epoch to be
        // measured against, so it needs a marker — banked only when one is
        // genuinely waiting, or a cancel that merely arrived after its own turn
        // finished would sit here and stop something sent much later.
        if (queuedUntagged(sessionId) > 0) {
          unscopedCancels.add(sessionId);
        }
        return;
      }
      // Only the turn actually running is stopped, and only when its epoch has
      // been cancelled: a prompt accepted after the fence carries a higher one
      // and must survive this notification, which the runtime forks and can
      // therefore deliver late. A turn whose prompt carried no epoch cannot be
      // scoped by a mark it never contributed to, so it takes plain ACP
      // semantics.
      if (activeTurnEpoch === undefined || activeTurnEpoch <= cancelledThrough(sessionId)) {
        cancelledSessions.add(sessionId);
        killActiveChild();
      }
      return;
    }
    default: {
      if (id !== undefined) {
        sendError(id, -32601, `method not found: ${method}`);
      }
    }
  }
}

/** Entry point for `t3 agy-acp`. */
export async function runAgyBridge(): Promise<void> {
  // `detached: true` means the child outlives this process unless it is told
  // otherwise. Losing the bridge — a signal, a crashing parent — would
  // otherwise leave `agy` and its tools running against the user's workspace
  // with nothing left to stop them.
  // Shutdown kills outright rather than scheduling an escalation: `process.exit`
  // runs no timers, so a graceful SIGTERM here would leave a tool that ignores
  // it alive in its own detached group with the bridge already gone.
  const stopChildOnExit = () => {
    shuttingDown = true;
    killActiveChild({ immediate: true });
    // The turn's own cleanup never runs when the process is going down, and
    // these hold copies of the user's attachments and captured file contents.
    cleanupActiveTurnTempDirs();
    // Groups whose leader already exited are known only to their pending
    // escalation, and `process.exit` runs no timers.
    killPendingGroups();
  };
  process.once("SIGTERM", () => {
    stopChildOnExit();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    stopChildOnExit();
    process.exit(0);
  });
  process.once("exit", stopChildOnExit);

  let buffer = "";
  // Requests are handled strictly in order: a turn holds the agent busy, and
  // ACP clients do not pipeline prompts for one session.
  let queue: Promise<void> = Promise.resolve();

  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (line.trim().length === 0) {
        continue;
      }

      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) {
          continue;
        }
        message = parsed as Record<string, unknown>;
      } catch {
        sendError(null, -32700, "invalid JSON");
        continue;
      }

      // A reply to one of the bridge's own requests (tool approval) carries an
      // id but no method, and must never enter the request queue — the turn
      // holding that queue is exactly what is waiting on the answer.
      if (message["method"] === undefined && resolveOutbound(message)) {
        continue;
      }

      // Handled out of band alongside cancel. Queued, it would sit behind the
      // very prompt it is meant to stop and only be recorded once that prompt
      // had already run.
      if (message["method"] === "t3/fence") {
        void handleRequest(message);
        continue;
      }

      // Cancellation must interrupt an in-flight turn, so it bypasses the
      // queue that would otherwise make it wait for that turn to finish.
      if (message["method"] === "session/cancel") {
        void handleRequest(message);
        continue;
      }
      const pending = message;
      // Counted from acceptance to handling, so a cancel can tell "a prompt is
      // waiting" from "nothing is outstanding".
      const queuedParams =
        pending["method"] === "session/prompt"
          ? (pending["params"] as Record<string, unknown> | undefined)
          : undefined;
      const queuedSessionId =
        queuedParams && promptEpochOf(queuedParams) === undefined
          ? queuedParams["sessionId"]
          : undefined;
      if (typeof queuedSessionId === "string") {
        queuedUntaggedCounts.set(queuedSessionId, queuedUntagged(queuedSessionId) + 1);
      }
      queue = queue
        .then(() => handleRequest(pending))
        .finally(() => {
          if (typeof queuedSessionId === "string") {
            const remaining = queuedUntagged(queuedSessionId) - 1;
            if (remaining > 0) {
              queuedUntaggedCounts.set(queuedSessionId, remaining);
            } else {
              queuedUntaggedCounts.delete(queuedSessionId);
              // Nothing untagged is waiting any more, so a marker banked for
              // one cannot be consumed and must not outlive it.
              unscopedCancels.delete(queuedSessionId);
            }
          }
        })
        .catch((error: unknown) => {
          // Every request must be answered. Swallowing a handler failure would
          // leave the client blocked on a response that never arrives.
          if (pending["id"] !== undefined) {
            const detail = error instanceof Error ? error.message : String(error);
            sendError(pending["id"], -32603, `internal bridge error: ${detail}`);
          }
        });
    }
  }

  // Recorded before anything else so queued prompts see it and decline.
  shuttingDown = true;
  // stdin closed: no approval can still be answered, so unblock the hooks
  // waiting on them (they fail closed) rather than letting them time out.
  failPendingOutbound("T3 Code disconnected before approving this tool call");
  // Killed before awaiting the queue, not after: an in-flight `session/prompt`
  // only resolves when `agy` exits, so waiting first would keep the bridge and
  // its child alive for the whole print timeout — hours — after the client
  // disconnected.
  killActiveChild();
  await queue;
}

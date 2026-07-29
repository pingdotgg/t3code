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
  type AgyHookDecision,
  type AgyHookEvent,
  type AgyHookPayload,
  type AgySessionUpdate,
  type AgyTurnState,
} from "./agyEvents.ts";
import {
  AgyTranscriptCursor,
  dropPriorTurnRecords,
  parseTranscriptLine,
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
const HOOK_POLL_INTERVAL_MS = 50;
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
interface TranscriptBaselines {
  readonly transcript: number;
  readonly transcriptFull: number;
}
function transcriptBaselines(conversationId: string | undefined): TranscriptBaselines {
  const result = { transcript: 0, transcriptFull: 0 };
  if (!conversationId) return result;
  const dir = transcriptDirFor(conversationId);
  try {
    result.transcript = NodeFS.statSync(NodePath.join(dir, "transcript.jsonl")).size;
  } catch {}
  try {
    result.transcriptFull = NodeFS.statSync(NodePath.join(dir, "transcript_full.jsonl")).size;
  } catch {}
  return result;
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

function writeMessage(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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
  { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
>();

function sendRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
  const id = nextOutboundId;
  nextOutboundId += 1;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    pendingOutbound.set(id, {
      resolve: (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      },
    });
    if (timeoutMs !== undefined) {
      // A client that never answers would otherwise pin this entry for the
      // life of the bridge process.
      timer = setTimeout(() => {
        if (pendingOutbound.delete(id)) {
          reject(new Error(`${method} timed out`));
        }
      }, timeoutMs);
      timer.unref?.();
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
        events.push({ name, event: parsed as AgyHookEvent });
      }
    } catch {
      // A half-written hook file is picked up on the next poll.
      seen.delete(name);
    }
  }
  return events;
}

// ── Tool approval ─────────────────────────────────────────────────────

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

function writeDecision(hookDir: string, hookName: string, decision: AgyHookDecision): void {
  try {
    const target = decisionPath(hookDir, hookName);
    const staging = `${target}.tmp`;
    NodeFS.writeFileSync(staging, JSON.stringify(decision));
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
}): void {
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
      const decision = approvalOutcomeToDecision(result, [APPROVE_OPTION, APPROVE_SESSION_OPTION]);
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
          ? await awaitDecision(hookDir, name)
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
async function awaitDecision(hookDir: string, hookName: string): Promise<AgyHookDecision> {
  const target = decisionPath(hookDir, hookName);
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const raw = NodeFS.readFileSync(target, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && (parsed["decision"] === "allow" || parsed["decision"] === "deny")) {
        return parsed as unknown as AgyHookDecision;
      }
    } catch {
      // Not written yet, or written partially; try again.
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

let activeChild: NodeChildProcess.ChildProcess | null = null;
/** Session whose turn is currently running, if any. Gates `session/cancel`. */
let activeTurnSessionId: string | null = null;
const cancelledSessions = new Set<string>();
/**
 * Cancels seen per session, counted rather than flagged.
 *
 * A prompt records this value when it is queued. If the count has moved by the
 * time the prompt reaches the front, a cancel arrived while it waited and the
 * prompt must not run — turns are serialized, so a steer queued behind a long
 * turn would otherwise start executing tools after the user pressed Stop. A
 * counter rather than a flag is what keeps this from also swallowing a cancel
 * that lands harmlessly between two turns.
 */
const cancelGenerations = new Map<string, number>();
/** Cancel generation captured when each queued prompt was accepted, by JSON-RPC id. */
const queuedPromptGenerations = new Map<unknown, number>();

function cancelGeneration(sessionId: string): number {
  return cancelGenerations.get(sessionId) ?? 0;
}

/**
 * Drain everything Antigravity has produced so far and emit it as ACP updates.
 *
 * Hooks are read first so a tool call is always announced before the
 * transcript record carrying its output is matched against it.
 */
function drain(input: {
  readonly sessionId: string;
  readonly hookDir: string;
  readonly seenHooks: Set<string>;
  readonly state: AgyTurnState;
  readonly cursor: AgyTranscriptCursor;
  readonly decoder: NodeStringDecoder.StringDecoder;
  readonly transcriptBaselines: TranscriptBaselines;
  readonly transcriptOffset: { value: number };
  readonly assistantText: { emitted: boolean };
  readonly final: boolean;
}): void {
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
        sendSessionUpdate(input.sessionId, update);
      }
    }
    // The hook process is blocked until a decision file appears, so this has
    // to be started for every announced tool call.
    // Not during the final drain: the child has already exited, so no tool is
    // waiting on the answer and the request would never be settled.
    if (
      !input.final &&
      approvalRequired() &&
      hook.event === "pre-tool-use" &&
      hook.payload?.toolCall
    ) {
      requestToolApproval({
        sessionId: input.sessionId,
        hookDir: input.hookDir,
        hookName: name,
        payload: hook.payload,
      });
    }
  }

  const transcriptPath = resolveTranscriptPath(input.state);
  if (transcriptPath) {
    if (input.transcriptOffset.value === -1) {
      input.transcriptOffset.value = transcriptPath.endsWith("transcript_full.jsonl")
        ? input.transcriptBaselines.transcriptFull
        : input.transcriptBaselines.transcript;
    }
    let chunk = "";
    try {
      const stats = NodeFS.statSync(transcriptPath);
      if (stats.size > input.transcriptOffset.value) {
        const fd = NodeFS.openSync(transcriptPath, "r");
        try {
          const length = stats.size - input.transcriptOffset.value;
          const buffer = Buffer.alloc(length);
          NodeFS.readSync(fd, buffer, 0, length, input.transcriptOffset.value);
          // Decoded through the turn's streaming decoder, not `toString`: a
          // write can land mid-multibyte-character, and decoding each slice
          // independently would replace the partial sequence with U+FFFD and
          // advance past it, silently corrupting non-ASCII output.
          chunk = input.decoder.write(buffer);
          input.transcriptOffset.value = stats.size;
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
      if (trimmed.length === allLines.length && input.state.resumedConversation && !input.final) {
        // Resuming, and this batch holds no `USER_INPUT` — so the current
        // turn's opening record has not been written yet and everything here
        // belongs to a previous turn. Emitting it would replay old output;
        // hold off and re-examine once more has been appended.
        input.cursor.retain(allLines);
        allLines = [];
      } else {
        allLines = [...trimmed];
        input.state.transcriptPrimed = true;
      }
    }
    for (const line of allLines) {
      const record = parseTranscriptLine(line);
      if (!record) {
        continue;
      }
      const result = transcriptRecordUpdates(record, input.state);
      for (const update of result.updates) {
        sendSessionUpdate(input.sessionId, update);
      }
      if (result.emittedAssistantText) {
        input.assistantText.emitted = true;
      }
      // This step's output is out; the call can be completed now.
      const stepIndex = record.step_index;
      if (typeof stepIndex === "number") {
        flushTerminal(input.sessionId, input.state, stepIndex);
      }
    }
  }

  // Nothing more will arrive, so anything still waiting on a transcript record
  // that never came is completed without output rather than left spinning.
  if (input.final) {
    const remaining = [...input.state.pendingTerminal.values()];
    input.state.pendingTerminal.clear();
    for (const terminal of remaining) {
      sendSessionUpdate(input.sessionId, terminal);
    }
  }
}

function flushTerminal(sessionId: string, state: AgyTurnState, stepIdx: number): void {
  const terminal = state.pendingTerminal.get(stepIdx);
  if (!terminal) {
    return;
  }
  state.pendingTerminal.delete(stepIdx);
  sendSessionUpdate(sessionId, terminal);
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

async function runTurn(
  sessionId: string,
  session: BridgeSession,
  prompt: RenderedPrompt,
): Promise<TurnOutcome> {
  // A cancel that raced the end of an earlier turn must not decide this one.
  cancelledSessions.delete(sessionId);
  // Claimed before any setup work: spawning `agy` takes long enough that a
  // cancel can land first, and cancels are only honoured for the session
  // holding this claim. Leaving it unset until after the spawn would silently
  // drop those, letting an auto-approving child run on past a cancelled turn.
  activeTurnSessionId = sessionId;
  // Measured before `agy` starts: whatever the transcript already holds
  // belongs to earlier turns of the conversation being resumed.
  const baselines = transcriptBaselines(session.conversationId);
  let hookDir: string | undefined;
  let hookWorkspace: string | undefined;
  let attachmentDir: string | undefined;
  let child: NodeChildProcess.ChildProcess;
  try {
    hookDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-hookout-"));
    hookWorkspace = createHookWorkspace();
    const attachments = stageAttachments(prompt.attachments);
    attachmentDir = attachments.dir;
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
        env: { ...process.env, [HOOK_DIR_ENV]: hookDir },
        stdio: ["ignore", "pipe", "pipe"],
        shell: spawnCommand.shell,
      },
    );
  } catch (error) {
    // Setup failed, so no turn is running: release the claim and reclaim the
    // directories, or repeated failures would leak one set each time.
    activeTurnSessionId = null;
    cleanupDir(hookDir);
    cleanupDir(hookWorkspace);
    cleanupDir(attachmentDir);
    throw error;
  }

  const state = makeAgyTurnState(session.conversationId);
  const seenHooks = new Set<string>();
  const cursor = new AgyTranscriptCursor();
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  const transcriptOffset = { value: -1 };
  if (baselines.transcript > 0 || baselines.transcriptFull > 0) {
    // Reading starts past every earlier turn, so there is no prior-turn
    // content left for the `USER_INPUT` heuristic to guess at.
    state.transcriptPrimed = true;
  }
  const assistantText = { emitted: false };
  activeChild = child;
  // A cancel during startup had no process to signal; deliver it now.
  if (cancelledSessions.has(sessionId)) {
    child.kill("SIGTERM");
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const poller = setInterval(() => {
    drain({
      sessionId,
      hookDir,
      seenHooks,
      state,
      cursor,
      decoder,
      transcriptBaselines: baselines,
      transcriptOffset,
      assistantText,
      final: false,
    });
  }, HOOK_POLL_INTERVAL_MS);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  clearInterval(poller);
  activeChild = null;
  activeTurnSessionId = null;
  drain({
    sessionId,
    hookDir,
    seenHooks,
    state,
    cursor,
    decoder,
    transcriptBaselines: baselines,
    transcriptOffset,
    assistantText,
    final: true,
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

  cleanupDir(hookDir);
  cleanupDir(hookWorkspace);
  cleanupDir(attachmentDir);

  if (cancelledSessions.delete(sessionId)) {
    return { stopReason: "cancelled" };
  }
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `agy exited with code ${exitCode}`;
    return { stopReason: "end_turn", failure: detail };
  }

  // The transcript already streamed the assistant text. stdout is only used
  // when transcript observation produced nothing, so the reply is never
  // duplicated.
  if (!assistantText.emitted && stdout.trim().length > 0) {
    sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: stdout.trim() },
    });
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
      const queuedAt = queuedPromptGenerations.get(id);
      queuedPromptGenerations.delete(id);
      if (queuedAt !== undefined && queuedAt !== cancelGeneration(sessionId)) {
        // Cancelled while it sat in the queue; never spawn `agy` for it.
        sendResult(id, { stopReason: "cancelled" });
        return;
      }
      const prompt = renderPrompt(session, params["prompt"]);
      if (prompt === null) {
        sendError(id, -32602, "session/prompt requires at least one text block");
        return;
      }
      const outcome = await runTurn(sessionId, session, prompt);
      if (outcome.failure) {
        sendError(id, -32000, `Antigravity turn failed: ${outcome.failure}`);
        return;
      }
      sendResult(id, { stopReason: outcome.stopReason });
      return;
    }
    case "session/cancel": {
      const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
      if (sessionId) {
        // Always recorded, so prompts already queued for this session can see
        // that a cancel happened and refuse to start.
        cancelGenerations.set(sessionId, cancelGeneration(sessionId) + 1);
        // Only a cancel aimed at the turn actually running decides its stop
        // reason. Cancels bypass the request queue, so one arriving after a
        // turn finished — or targeting an idle session — must not sit in the
        // set and mark the next successful turn cancelled.
        if (sessionId === activeTurnSessionId) {
          cancelledSessions.add(sessionId);
          activeChild?.kill("SIGTERM");
        }
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

      // Cancellation must interrupt an in-flight turn, so it bypasses the
      // queue that would otherwise make it wait for that turn to finish.
      if (message["method"] === "session/cancel") {
        void handleRequest(message);
        continue;
      }
      const pending = message;
      // Captured now, not when the turn starts: the gap between the two is
      // exactly the window a cancel has to arrive in while this prompt waits.
      if (pending["method"] === "session/prompt") {
        const target = (pending["params"] as Record<string, unknown> | undefined)?.["sessionId"];
        if (typeof target === "string" && pending["id"] !== undefined) {
          queuedPromptGenerations.set(pending["id"], cancelGeneration(target));
        }
      }
      queue = queue
        .then(() => handleRequest(pending))
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

  // stdin closed: no approval can still be answered, so unblock the hooks
  // waiting on them (they fail closed) rather than letting them time out.
  failPendingOutbound("T3 Code disconnected before approving this tool call");
  await queue;
  activeChild?.kill("SIGTERM");
}

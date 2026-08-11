/**
 * AetherAdapter — session core for the Aether cloud-task driver.
 *
 * T2–T6 slice: startSession/listSessions/hasSession/readThread/stopSession/
 * stopAll over the REST client, the event pipeline (build items 5+6: passive
 * WS attach, 13-kind live union through `eventMapper`, durable delta
 * reconciliation), and the turn surface (build items 7+8):
 *   - sendTurn creates the cloud task on the first turn (the ONE path that
 *     may pass `start=true` to the workspace connect), responds on later
 *     turns, and defers `turn.started` for a mid-turn steer until the remote
 *     queue picks the message up;
 *   - every turn settle flows through the mirror sync engine
 *     (`aether/mirrorSync.ts`): verify → fetch+reset+clean onto the diff's
 *     own baseRef → apply the full cumulative diff → `turn.diff.updated` →
 *     `turn.completed`;
 *   - interruptTurn stops with `discard_queued_messages: true`, surfaces any
 *     discarded driver-queued message text, and settles `interrupted` only
 *     after read-side confirmation.
 * The questions/plans slice (build item 9):
 *   - respondToUserInput answers a pending ask_user via `POST /respond`
 *     `tool_response {tool_name:"ask_user", data:{answers, customAnswers}}`,
 *     mapping option labels → raw option indices and free-typed text → the
 *     `-1` custom sentinel (apitypes/tasks.go askUserToolResponseSchema);
 *   - a sendTurn that lands while a plan is pending IS the accept/reject
 *     verb: interactionMode default → `propose_plan {approved:true}` +
 *     interaction_mode 'default', plan → `{approved:false, feedback}` +
 *     interaction_mode 'plan' (t3 routes plan acceptance as a fresh turn —
 *     ChatView sends thread.turn.start with interactionMode 'default').
 * rollbackThread is a deliberate typed refusal in v1: the local checkout is
 * a one-way mirror, and reverting a cloud session locally would desync it.
 *
 * Design invariants (docs/aether-driver-plumbing-spec.md §2.3):
 *   - startSession NEVER creates a task — the task is created on the first
 *     sendTurn. It preflights the local checkout (clean tree on a pushed,
 *     in-sync branch for a FRESH thread; a resumed thread's mirror is dirty
 *     by design and is guarded by the sync fingerprint instead), resolves
 *     the cwd's origin remote to exactly one linked Aether project, and
 *     validates a resume cursor's task still exists remotely.
 *   - stopSession / stopAll are PURE DISCONNECTS: the cloud task keeps
 *     running and the VM idles itself out. `/stop` is never called there.
 *   - resumeCursor = `{schemaVersion: 1, taskId, latestSequence,
 *     mirrorFingerprint?, turnLedger?}`; replay safety comes from the
 *     mapper's deterministic event IDs, not cursor freshness.
 *   - turnLedger records the turn→messageId pairs (turn 1's id harvested
 *     from the timeline, every later own send from the respond 202, and the
 *     WHOLE ledger rebuilt from the conversation page on resume — resolved
 *     note 7) — the future revert slice consumes the pairs, and build item
 *     13 uses the ledger to classify unledgered user rows as
 *     remote-originated turns.
 *
 * @module provider/Layers/AetherAdapter
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  TurnId,
  type ChatAttachment,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { GitCommandError } from "@t3tools/contracts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import type {
  ExecuteGitInput,
  ExecuteGitResult,
  GitStatusDetails,
} from "../../vcs/GitVcsDriver.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import {
  CloudTerminalTransportError,
  CloudTerminalUnavailableError,
  type CloudTerminalConnectError,
  type CloudTerminalConnector,
} from "../CloudTerminalConnector.ts";
import { AETHER_API_KEY_ENV_VAR } from "./AetherProvider.ts";
import {
  makeAetherEventMapper,
  type AetherAnswerableQuestion,
  type AetherEventMapper,
} from "./aether/eventMapper.ts";
import { makeAetherMirrorSync, type AetherMirrorSyncEngine } from "./aether/mirrorSync.ts";
import { buildAetherPreviewUrl } from "./aether/portPreview.ts";
import type { AetherRestClient } from "./aether/restClient.ts";
import type {
  AetherPromptAttachment,
  AetherProject,
  AetherTask,
  AetherTimelineMessage,
} from "./aether/restSchemas.ts";
import { toolLifecycleItemTypeFromAether } from "./aether/vendored/canonicalItemType.ts";
import {
  AETHER_AGENT_TYPES,
  reasoningEffortsForModel,
  type AetherAgentType,
} from "./aether/vendored/catalog.ts";
import { parseFileChanges } from "./aether/vendored/toolDisplay.ts";
import {
  openAetherTerminalConnection,
  type AetherTerminalConnectError,
} from "./aether/terminalConnection.ts";
import {
  runAetherAgentStream,
  type AetherAgentConnection,
  type AetherStreamTiming,
  type AetherWebSocketFactory,
} from "./aether/workspaceSocket.ts";

const PROVIDER = ProviderDriverKind.make("aether");

/**
 * Version tag stamped into the Aether resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors OPENCODE_RESUME_VERSION).
 */
const AETHER_RESUME_VERSION = 1 as const;

/**
 * One driver-originated turn: the t3 TurnId and the wire message id that
 * opened it (identical strings modulo the `aether-turn-` prefix — the wire
 * turn id IS the opening user message id). Recorded per send/harvest so the
 * future revert slice can map "N turns back" → the `git restore` messageId,
 * and so build item 13 can classify user rows the driver never sent.
 */
export interface AetherTurnLedgerEntry {
  readonly turnId: string;
  readonly messageId: string;
}

export interface AetherResumeCursor {
  readonly schemaVersion: typeof AETHER_RESUME_VERSION;
  readonly taskId: string;
  readonly latestSequence: number;
  /**
   * The mirror sync engine's last-synced content fingerprint. On resume it
   * is the expected state of the local checkout; a mismatch pauses sync
   * loudly instead of resetting over unknown local work.
   */
  readonly mirrorFingerprint?: string;
  /** The driver's own turn→messageId pairs, oldest first. */
  readonly turnLedger?: ReadonlyArray<AetherTurnLedgerEntry>;
}

/**
 * Parse a persisted ledger. Any malformed entry drops the WHOLE ledger (a
 * partial ledger would misclassify the dropped turns as remote-originated) —
 * the session still resumes, matching the cursor parser's lenient contract.
 */
function parseTurnLedger(raw: unknown): ReadonlyArray<AetherTurnLedgerEntry> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const entries: Array<AetherTurnLedgerEntry> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.turnId !== "string" ||
      record.turnId.length === 0 ||
      typeof record.messageId !== "string" ||
      record.messageId.length === 0
    ) {
      return undefined;
    }
    entries.push({ turnId: record.turnId, messageId: record.messageId });
  }
  return entries;
}

/**
 * Decode a persisted resume cursor. Anything that isn't a current-version
 * cursor with a non-empty taskId and a finite latestSequence means "no
 * resume" rather than an error (t3 then starts a fresh session — the same
 * contract every other adapter's cursor parser follows).
 */
export function parseAetherResume(raw: unknown): AetherResumeCursor | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== AETHER_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.taskId !== "string" || record.taskId.trim().length === 0) {
    return undefined;
  }
  if (typeof record.latestSequence !== "number" || !Number.isFinite(record.latestSequence)) {
    return undefined;
  }
  const turnLedger = parseTurnLedger(record.turnLedger);
  return {
    schemaVersion: AETHER_RESUME_VERSION,
    taskId: record.taskId.trim(),
    latestSequence: record.latestSequence,
    ...(typeof record.mirrorFingerprint === "string" && record.mirrorFingerprint.length > 0
      ? { mirrorFingerprint: record.mirrorFingerprint }
      : {}),
    ...(turnLedger !== undefined ? { turnLedger } : {}),
  };
}

/**
 * The two git reads the session preflight needs, structurally satisfied by
 * `GitVcsDriver`. Narrowed so unit tests can fake it without the full
 * driver surface.
 */
export interface AetherSessionGit {
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  /** Raw git executor — the mirror sync engine's only git surface. */
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
}

/**
 * The adapter's git dependency as an Effect requirement: the driver provides
 * `GitVcsDriver` here, unit tests provide a narrowed fake.
 */
export class AetherSessionGitService extends Context.Service<
  AetherSessionGitService,
  AetherSessionGit
>()("t3/provider/Layers/AetherAdapter/AetherSessionGitService") {}

/** Transport coordinates for the workspace WS attach (build item 5). */
export interface AetherAdapterSocketOptions {
  /** Same origin the REST client talks to; the wss URL derives from it. */
  readonly apiBaseUrl: string;
  /** The instance's `AETHER_API_KEY` — the socket authenticates with it. */
  readonly apiKey: string;
  /** Test seam; defaults to the Node global WebSocket. */
  readonly webSocketFactory?: AetherWebSocketFactory;
  /** Test seam for poll/reconnect pacing. */
  readonly timing?: Partial<AetherStreamTiming>;
}

/** Server-side ownership registry hook (build item 8a's guard source of truth). */
export interface AetherMirrorRegistration {
  readonly register: (cwd: string, key: string) => Effect.Effect<void>;
  readonly deregister: (cwd: string, key: string) => Effect.Effect<void>;
}

/**
 * The adapter's mirror-ownership dependency as an Effect requirement: the
 * driver provides `AetherMirrorRegistry` here, unit tests provide a fake.
 */
export class AetherMirrorRegistrationService extends Context.Service<
  AetherMirrorRegistrationService,
  AetherMirrorRegistration
>()("t3/provider/Layers/AetherAdapter/AetherMirrorRegistrationService") {}

/** Turn-engine pacing knobs (injectable so tests never sleep real time). */
export interface AetherTurnTiming {
  /** REST backstop poll cadence while a turn is active (spec ~3s). */
  readonly settlePollMs: number;
  /** Cadence + budget for harvesting the first user row after create. */
  readonly harvestPollMs: number;
  readonly harvestMaxAttempts: number;
  /** Cadence + budget for read-side confirmation after /stop. */
  readonly interruptPollMs: number;
  readonly interruptMaxAttempts: number;
}

const DEFAULT_TURN_TIMING: AetherTurnTiming = {
  settlePollMs: 3_000,
  harvestPollMs: 250,
  harvestMaxAttempts: 40,
  interruptPollMs: 500,
  interruptMaxAttempts: 60,
};

export interface AetherAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  /** Fallback session cwd when the start input carries none (ServerConfig.cwd). */
  readonly defaultCwd: string;
  /** Attachment blob store root (ServerConfig.attachmentsDir). */
  readonly attachmentsDir: string;
  /**
   * Undefined when the instance has no `AETHER_API_KEY` — startSession then
   * fails loudly with the remediation instead of the driver failing create().
   */
  readonly restClient: AetherRestClient | undefined;
  /**
   * Undefined only when `restClient` is (keyless instance) or in REST-only
   * unit tests; the driver always passes it alongside a real client.
   */
  readonly socket?: AetherAdapterSocketOptions | undefined;
  readonly turnTiming?: Partial<AetherTurnTiming>;
}

interface AetherActiveTurn {
  readonly wireTurnId: string;
  readonly turnId: TurnId;
}

interface AetherDeferredTurn extends AetherActiveTurn {
  /** The queued message text — re-offered in a warning card if a Stop discards it. */
  readonly text: string;
}

interface AetherSessionContext {
  session: ProviderSession;
  readonly cwd: string;
  readonly projectId: string;
  /** The branch preflighted at startSession — the task's base_branch. */
  readonly baseBranch: string | undefined;
  /** Undefined until the first sendTurn creates the cloud task. */
  taskId: string | undefined;
  /**
   * True between a successful createTask and the completed first-turn
   * bring-up (harvest + attach). A retry while pending re-enters the
   * first-turn path — skipping the create AND the respond — so a transient
   * harvest failure can never double-send the prompt as a second message.
   */
  firstTurnPending: boolean;
  /**
   * Fingerprint of EVERY dispatch-relevant input of the pending created
   * task (prompt, resolved slug, effort, interaction mode, attachments):
   * a retry must match all of them — matching only the text would silently
   * discard changed attachments or model selection.
   */
  firstTurnFingerprint: string | undefined;
  latestSequence: number;
  /** The driver's own turn→messageId pairs, oldest first (see AetherResumeCursor). */
  turnLedger: Array<AetherTurnLedgerEntry>;
  /**
   * Every `client_message_id` this session issued, registered BEFORE the
   * respond call goes out — the second half of the own-send classification.
   * The server commits the user row before returning the 202, so a
   * settle-poll reconcile can observe the fresh row while sendTurn still
   * awaits the response (the row is not yet in `turnLedger`); the
   * pre-registered id keeps that window from misclassifying the driver's
   * own send as remote-originated. In-memory only: across a restart the
   * classification is covered by the ledger rebuild from the conversation
   * page at startSession instead.
   */
  readonly issuedClientMessageIds: Set<string>;
  /** Remote-originated user rows already surfaced as warnings (build item 13). */
  readonly warnedRemoteRows: Set<string>;
  /**
   * Wire turns a live frame revealed that this adapter never issued — each
   * triggers exactly ONE eager durable reconcile so the build-item-13
   * warning precedes the remote turn's live output (see
   * eagerRemoteTurnReconcile).
   */
  readonly remoteTurnSyncs: Set<string>;
  /** Owns the attach pump, socket and turn poll; closed on stopSession/stopAll. */
  sessionScope: Scope.Closeable | undefined;
  /** The session's event mapper; its latestSequence() is the live cursor. */
  mapper: AetherEventMapper | undefined;
  /** The mirror sync engine — active from startSession for the thread's life. */
  mirror: AetherMirrorSyncEngine | undefined;
  /** Live WS connection handle (undefined while detached). */
  connection: AetherAgentConnection | undefined;
  /** Cloud port-preview token (from the connect transport); set on attach. */
  previewToken: string | undefined;
  /** The workspace id backing this session (port-preview subdomain prefix). */
  workspaceId: string | undefined;
  /** Ports already surfaced as `port.opened`, to dedupe snapshot re-syncs. */
  readonly emittedPorts: Set<number>;
  /** The durable reconciliation — the settle backstop the turn poll drives. */
  reconcile: Effect.Effect<void> | undefined;
  /** True while an attach pump fiber runs for this session. */
  pumpRunning: boolean;
  /** `session.started` is emitted once per session, across pump restarts. */
  sessionStartedEmitted: boolean;
  /** The wire turn currently running remotely (driver-tracked). */
  activeTurn: AetherActiveTurn | undefined;
  /**
   * One-shot: the session resumed onto a task that was ALREADY processing,
   * so the in-flight wire turn is unknown until a reconcile observes
   * `activeProcessingTurn`. The first observation adopts it — activeTurnId,
   * turn.started and the settle backstop poll — per spec §2.3 (reconstruct
   * activeTurnId from status=processing). Cleared by the first adoption or
   * by the user's own next sendTurn.
   */
  adoptActiveTurn: boolean;
  /** Steer messages queued remotely, their turn.starteds deferred until pickup (FIFO). */
  deferredTurns: Array<AetherDeferredTurn>;
  /** Guards against stacking settle-poll fibers. */
  pollRunning: boolean;
  /** Ordinal for deterministic client_message_ids (one per own send). */
  sentCount: number;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function buildAetherResumeCursor(context: AetherSessionContext): AetherResumeCursor | undefined {
  const mirrorFingerprint = context.mirror?.lastSyncedFingerprint();
  return context.taskId === undefined
    ? undefined
    : {
        schemaVersion: AETHER_RESUME_VERSION,
        taskId: context.taskId,
        latestSequence: context.latestSequence,
        ...(mirrorFingerprint !== undefined ? { mirrorFingerprint } : {}),
        ...(context.turnLedger.length > 0 ? { turnLedger: [...context.turnLedger] } : {}),
      };
}

// ---------------------------------------------------------------------------
// Turn helpers (pure)
// ---------------------------------------------------------------------------

const AETHER_TURN_ID_PREFIX = "aether-turn-";

const turnIdForWire = (wireTurnId: string): TurnId =>
  TurnId.make(`${AETHER_TURN_ID_PREFIX}${wireTurnId}`);

/** Recover the wire turn id from a mapper-stamped t3 TurnId. */
function wireIdFromTurnId(turnId: TurnId): string | undefined {
  const raw = String(turnId);
  return raw.startsWith(AETHER_TURN_ID_PREFIX)
    ? raw.slice(AETHER_TURN_ID_PREFIX.length)
    : undefined;
}

/**
 * Deterministic, RFC-4122-shaped id for `client_message_id`: stable per
 * (taskId, session epoch, send ordinal) — the driver-side stand-in for
 * "(taskId, t3 turnId)", since the t3 TurnId for a respond derives from the
 * very message_id the call returns. The session epoch keeps ordinals from a
 * RESUMED session from colliding with an earlier session's sends (the server
 * dedupes on client_message_id via ON CONFLICT — a collision would silently
 * swallow the new message).
 */
export function deterministicClientMessageId(input: {
  readonly taskId: string;
  readonly sessionEpoch: string;
  readonly sendOrdinal: number;
}): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`aether:${input.taskId}:${input.sessionEpoch}:send:${input.sendOrdinal}`)
    .digest("hex");
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Resolve a composite `<agent_type>/<model>` slug into the create/respond
 * dispatch pair. Catalog agent types dispatch natively; anything else is an
 * Aether free-typed custom model, dispatched as agent_type `opencode` with
 * the FULL slug as the model string (spec §2.5 custom-models row).
 */
export function resolveAetherModelSlug(slug: string): {
  readonly agentType: string;
  readonly model: string;
  readonly catalogAgentType: AetherAgentType | undefined;
} {
  const separator = slug.indexOf("/");
  if (separator > 0) {
    const prefix = slug.slice(0, separator);
    const known = AETHER_AGENT_TYPES.find((agentType) => agentType === prefix);
    if (known !== undefined) {
      return { agentType: known, model: slug.slice(separator + 1), catalogAgentType: known };
    }
  }
  return { agentType: "opencode", model: slug, catalogAgentType: undefined };
}

/**
 * The custom-answer sentinel: Aether's ask_user wire marks a free-typed
 * answer as `answers[q] = [-1]` paired with `customAnswers[q]` (apitypes/
 * tasks.go askUserToolResponseSchema documents `-1`; the web composer's
 * serializeResponse in packages/conversation question-drafts.ts emits it).
 */
const AETHER_CUSTOM_ANSWER_SENTINEL = -1;

/**
 * Map t3's ProviderUserInputAnswers (question id → answer label(s) / typed
 * text) onto the aether-exact ask_user data payload: answers keyed by the
 * question's RAW wire index, option labels resolved to raw option indices,
 * one free-typed answer per question via the `-1` sentinel + customAnswers.
 * Pure and total: every unrepresentable submission returns a named issue.
 */
export function buildAskUserToolResponse(
  questions: ReadonlyArray<AetherAnswerableQuestion>,
  answers: ProviderUserInputAnswers,
):
  | {
      readonly data: {
        readonly answers: Readonly<Record<string, ReadonlyArray<number>>>;
        readonly customAnswers?: Readonly<Record<string, string>>;
      };
    }
  | { readonly issue: string } {
  const answerRecord: Record<string, ReadonlyArray<number>> = {};
  const customAnswers: Record<string, string> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    const question = questions.find((candidate) => candidate.id === questionId);
    if (question === undefined) {
      return { issue: `The answer targets an unknown question '${questionId}'.` };
    }
    const texts = normalizeUserInputAnswer(value);
    if (texts === undefined) {
      return {
        issue: `The answer for question '${questionId}' has an unsupported shape (expected a string, an array of strings, or {answers: string[]}).`,
      };
    }
    const trimmed = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (trimmed.length === 0) {
      continue;
    }
    const indices: Array<number> = [];
    const unmatched: Array<string> = [];
    for (const text of trimmed) {
      const option = question.options.find((candidate) => candidate.label === text);
      if (option !== undefined) {
        indices.push(option.rawIndex);
      } else {
        unmatched.push(text);
      }
    }
    const key = String(question.rawIndex);
    if (unmatched.length === 0) {
      answerRecord[key] = indices;
      continue;
    }
    if (unmatched.length === 1 && indices.length === 0) {
      answerRecord[key] = [AETHER_CUSTOM_ANSWER_SENTINEL];
      customAnswers[key] = unmatched[0]!;
      continue;
    }
    return {
      issue: `The answer for question '${questionId}' mixes free-typed text with option selections; Aether accepts either option labels or exactly one custom answer.`,
    };
  }
  if (Object.keys(answerRecord).length === 0) {
    return { issue: "The submission carries no answers." };
  }
  return {
    data: {
      answers: answerRecord,
      ...(Object.keys(customAnswers).length > 0 ? { customAnswers } : {}),
    },
  };
}

/** The three answer-value shapes t3 submits (mirrors the Codex adapter). */
function normalizeUserInputAnswer(value: unknown): ReadonlyArray<string> | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.every((entry): entry is string => typeof entry === "string") ? value : undefined;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "answers" in value &&
    Array.isArray((value as { answers: unknown }).answers) &&
    (value as { answers: Array<unknown> }).answers.every((entry) => typeof entry === "string")
  ) {
    return (value as { answers: Array<string> }).answers;
  }
  return undefined;
}

/** The platform attachment allowlist (libs/go/promptattachment, kept in sync). */
const AETHER_ATTACHMENT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/** 5 MiB decoded per attachment (promptattachment.MaxBytes). */
const AETHER_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Verify the local checkout is a safe mirror base for a cloud thread: a git
 * repo, on a branch, with a clean tree, pushed, and in sync with its origin
 * counterpart (spec §2.2 — thread start REQUIRES a clean tree on a pushed
 * branch). Every failure names its exact remediation.
 */
function preflightIssue(status: GitStatusDetails, cwd: string): string | undefined {
  if (!status.isRepo) {
    return `'${cwd}' is not a git repository. Aether cloud tasks need a git checkout of the linked repository.`;
  }
  if (status.branch === null) {
    return "The working tree is on a detached HEAD. Check out a branch and push it before starting an Aether cloud task.";
  }
  if (status.hasWorkingTreeChanges) {
    return `The working tree has uncommitted changes. Commit or stash them, then push '${status.branch}', before starting an Aether cloud task — the local checkout becomes a one-way mirror of the cloud workspace.`;
  }
  if (!status.hasUpstream) {
    return `Branch '${status.branch}' has no upstream. Push it first (git push -u origin ${status.branch}) so the cloud task starts from the same base.`;
  }
  if (status.aheadCount > 0) {
    return `Branch '${status.branch}' is ahead of its upstream by ${status.aheadCount} commit(s). Push it before starting an Aether cloud task.`;
  }
  if (status.behindCount > 0) {
    return `Branch '${status.branch}' is behind its upstream by ${status.behindCount} commit(s). Sync it (git pull --ff-only) before starting an Aether cloud task.`;
  }
  return undefined;
}

/**
 * Structural-only preflight for a RESUMED thread: its mirror is dirty by
 * design (reset-to-base + applied cumulative diff), so the clean/pushed
 * checks do not apply — the sync engine's fingerprint verify guards content.
 */
function resumePreflightIssue(status: GitStatusDetails, cwd: string): string | undefined {
  if (!status.isRepo) {
    return `'${cwd}' is not a git repository. Aether cloud tasks need a git checkout of the linked repository.`;
  }
  if (status.branch === null) {
    return "The working tree is on a detached HEAD. Check out the thread's branch before resuming this Aether cloud task.";
  }
  return undefined;
}

/**
 * Structural-only preflight for a driver-owned, per-thread worktree: it is
 * created clean from origin/{base} and only the driver writes to it, so the
 * clean-tree/pushed/in-sync checks do not apply (its temp branch has no
 * upstream by design). Only the structural checks that the mirror engine
 * itself relies on remain.
 */
function managedWorktreePreflightIssue(status: GitStatusDetails, cwd: string): string | undefined {
  if (!status.isRepo) {
    return `'${cwd}' is not a git repository. Aether cloud tasks need a git checkout of the linked repository.`;
  }
  if (status.branch === null) {
    return "The Aether worktree is on a detached HEAD. This should not happen for a managed worktree.";
  }
  return undefined;
}

/** Snapshot item for a timeline row — minimal, per t3's opaque snapshot type. */
function snapshotItemFromMessage(row: AetherTimelineMessage): unknown {
  if (row.role === "user") {
    return { type: "user_message", id: row.id, content: row.content };
  }
  switch (row.variant) {
    case "text":
      return { type: "assistant_message", id: row.id, content: row.content };
    case "thinking":
      return { type: "reasoning", id: row.id, content: row.content };
    case "seam":
      return { type: "seam", id: row.id, reason: row.seam.reason };
    case "tool": {
      const itemType = toolLifecycleItemTypeFromAether(row.tool.itemType ?? "unknown");
      const files =
        itemType === "file_change"
          ? parseFileChanges(row.tool.input, row.tool.result)
              .map((change) => change.path)
              .filter((path): path is string => path !== null)
          : [];
      return {
        type: "tool",
        id: row.tool.id,
        itemType,
        name: row.tool.name,
        status: row.tool.status,
        label: row.tool.display.label,
        ...(files.length > 0 ? { files } : {}),
      };
    }
  }
}

/**
 * Group timeline rows into turn snapshots: each user row opens a turn (its
 * durable row id keys the TurnId, so snapshots are stable across reads);
 * rows arriving before any user row open a synthetic leading turn.
 */
export function snapshotTurnsFromMessages(
  messages: ReadonlyArray<AetherTimelineMessage>,
): ReadonlyArray<ProviderThreadTurnSnapshot> {
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  for (const row of messages) {
    if (row.role === "user" || turns.length === 0) {
      turns.push({ id: TurnId.make(`aether-turn-${row.id}`), items: [] });
    }
    turns[turns.length - 1]?.items.push(snapshotItemFromMessage(row));
  }
  return turns;
}

export const makeAetherAdapter = Effect.fn("makeAetherAdapter")(function* (
  options: AetherAdapterOptions,
): Effect.fn.Return<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Scope.Scope
  | AetherSessionGitService
  | AetherMirrorRegistrationService
> {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* AetherSessionGitService;
  const mirrorRegistry = yield* AetherMirrorRegistrationService;
  const turnTiming = { ...DEFAULT_TURN_TIMING, ...options.turnTiming };
  // Scope-owned so registry teardown shuts the stream down with the instance.
  const runtimeEvents = yield* Effect.acquireRelease(
    Queue.unbounded<ProviderRuntimeEvent>(),
    Queue.shutdown,
  );
  const sessions = new Map<ThreadId, AetherSessionContext>();

  const registryKey = (threadId: ThreadId) => `${options.instanceId}:${threadId}`;

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const randomEventId = crypto.randomUUIDv4.pipe(
    Effect.map(EventId.make),
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Aether runtime identifier.",
          cause,
        }),
    ),
  );

  const requireRestClient = (method: string) =>
    options.restClient !== undefined
      ? Effect.succeed(options.restClient)
      : Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: `No Aether API key configured. Add a sensitive ${AETHER_API_KEY_ENV_VAR} environment variable to this provider instance.`,
          }),
        );

  const toGitRequestError = (method: string) => (cause: GitCommandError) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: `Git preflight failed: ${cause.detail}`,
      cause,
    });

  const toRestRequestError = (method: string) => (cause: { readonly message: string }) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: cause.message,
      cause,
    });

  const ensureContext = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context !== undefined
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const closeSessionScope = (context: AetherSessionContext) =>
    context.sessionScope === undefined
      ? Effect.void
      : Effect.ignore(Scope.close(context.sessionScope, Exit.void));

  // Registry/instance teardown must also stop every attach pump (delete =
  // full teardown) AND release every mirror-guard registration — a torn-down
  // adapter must never leave a cwd locked. Registered AFTER the queue's
  // acquireRelease so it runs FIRST on close: pumps stop emitting, then the
  // queue shuts down.
  yield* Effect.acquireRelease(Effect.void, () =>
    Effect.gen(function* () {
      for (const [threadId, context] of sessions.entries()) {
        yield* closeSessionScope(context);
        yield* mirrorRegistry.deregister(context.cwd, registryKey(threadId));
      }
    }),
  );

  // Stream-pump callbacks must be infallible (a failing callback would kill
  // the socket loop); crypto id generation dying is the only acceptable
  // defect here.
  const freshEventId = Effect.orDie(randomEventId);

  const baseEvent = (context: AetherSessionContext) =>
    Effect.gen(function* () {
      return {
        eventId: yield* freshEventId,
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.session.threadId,
        createdAt: yield* nowIso,
      };
    });

  /**
   * Run the mirror sync for one settling turn and emit its surface events
   * (spec build item 8: sync completes BEFORE turn.completed goes out).
   */
  const syncMirrorForSettle = (context: AetherSessionContext, turnId: TurnId | undefined) =>
    Effect.gen(function* () {
      const mirror = context.mirror;
      if (mirror === undefined) {
        return;
      }
      const outcome = yield* mirror.syncAtSettle(context.connection);
      const wireId = turnId !== undefined ? wireIdFromTurnId(turnId) : undefined;
      switch (outcome._tag) {
        case "synced":
          yield* Effect.logDebug("aether.mirror.synced", {
            taskId: context.taskId,
            fileCount: outcome.fileCount,
          });
          if (outcome.modeOnlySkipped.length > 0) {
            // The wire diff carries no file-mode information, so a
            // chmod-only change cannot be mirrored — say so instead of
            // silently dropping it (or worse, pausing the whole sync).
            yield* emit({
              ...(yield* baseEvent(context)),
              type: "runtime.warning",
              payload: {
                message:
                  `The cloud workspace changed only the file MODE of ${outcome.modeOnlySkipped.join(", ")}; ` +
                  "mode changes cannot be mirrored into the local checkout (the diff protocol carries no mode bits).",
              },
            });
          }
          yield* emit({
            ...(yield* baseEvent(context)),
            ...(context.taskId !== undefined && wireId !== undefined
              ? { eventId: EventId.make(`aether:${context.taskId}:turn:${wireId}:diff`) }
              : {}),
            ...(turnId !== undefined ? { turnId } : {}),
            type: "turn.diff.updated",
            payload: { unifiedDiff: outcome.unifiedDiff },
          });
          return;
        case "skipped-detached":
          // Expected while detached: the turn settles with an empty
          // checkpoint and the next successful sync captures the combined
          // delta (lazy catch-up). No card.
          yield* Effect.logInfo("aether.mirror.skipped-detached", {
            taskId: context.taskId,
            reason: outcome.reason,
          });
          return;
        case "skipped-transport":
          yield* emit({
            ...(yield* baseEvent(context)),
            type: "runtime.warning",
            payload: {
              message: `The workspace diff sync did not complete for this turn; the next sync catches up. ${outcome.reason}`,
            },
          });
          return;
        case "paused":
          if (outcome.firstPause) {
            yield* emit({
              ...(yield* baseEvent(context)),
              type: "runtime.error",
              payload: {
                message: `Aether mirror sync is paused: ${outcome.reason}`,
                class: "provider_error",
              },
            });
          } else {
            yield* emit({
              ...(yield* baseEvent(context)),
              type: "runtime.warning",
              payload: {
                message: `Aether mirror sync remains paused; this turn settled without syncing. ${outcome.reason}`,
              },
            });
          }
          return;
      }
    });

  /** Emit one deferred steer turn's `turn.started` and promote it to active. */
  const emitDeferredStarted = (context: AetherSessionContext, wireTurnId: string) =>
    Effect.gen(function* () {
      const index = context.deferredTurns.findIndex(
        (candidate) => candidate.wireTurnId === wireTurnId,
      );
      if (index === -1) {
        return;
      }
      const deferred = context.deferredTurns[index]!;
      context.deferredTurns.splice(index, 1);
      context.activeTurn = { wireTurnId: deferred.wireTurnId, turnId: deferred.turnId };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: deferred.turnId,
        updatedAt: yield* nowIso,
      };
      yield* emit({
        ...(yield* baseEvent(context)),
        ...(context.taskId !== undefined
          ? {
              eventId: EventId.make(`aether:${context.taskId}:turn:${deferred.wireTurnId}:started`),
            }
          : {}),
        turnId: deferred.turnId,
        type: "turn.started",
        payload: {},
      });
    });

  /** Bookkeeping when a terminal settle for `turnId` has just been emitted. */
  const onTurnSettled = (context: AetherSessionContext, turnId: TurnId | undefined) =>
    Effect.gen(function* () {
      if (turnId === undefined) {
        return;
      }
      context.deferredTurns = context.deferredTurns.filter(
        (candidate) => candidate.turnId !== turnId,
      );
      if (context.activeTurn?.turnId === turnId) {
        context.activeTurn = undefined;
      }
      const nextActive =
        context.activeTurn?.turnId ??
        context.deferredTurns[context.deferredTurns.length - 1]?.turnId;
      const session: ProviderSession = {
        ...context.session,
        status: nextActive !== undefined ? "running" : "ready",
        updatedAt: yield* nowIso,
      };
      // `activeTurnId` is optional — rebuild without the key when cleared.
      if (nextActive !== undefined) {
        context.session = { ...session, activeTurnId: nextActive };
      } else {
        const { activeTurnId: _cleared, ...rest } = session;
        context.session = rest;
      }
      const resumeCursor = buildAetherResumeCursor(context);
      if (resumeCursor !== undefined) {
        context.session = { ...context.session, resumeCursor };
      }
    });

  /**
   * Adapter-side delta inspection, run BEFORE the mapper consumes the batch
   * so its emissions precede the turn's own output:
   *   - build item 14: a driver-queued steer the remote unqueued (web
   *     unqueue, remote stop with discard) will never be picked up — settle
   *     its deferred turn and re-offer the text, or the session stays wedged
   *     on a turn the remote no longer knows. The ONLY wire signal for this
   *     is `removedMessageIds`: cancelled user rows never cross the
   *     conversation wire (the timeline queries select only delivery_status
   *     queued|processing|processed), but the cancel bumps the revision
   *     sequence, which lands the id in the delta's removed set;
   *   - build item 13: user rows the driver never sent (id not in the turn
   *     ledger, clientMessageId not issued here) are remote-originated turns
   *     — surface the injected prompt as a warning card, since t3 persists
   *     user bubbles only from its own thread.turn.start.
   */
  const inspectDeltaRows = (
    context: AetherSessionContext,
    delta: {
      readonly messages: ReadonlyArray<AetherTimelineMessage>;
      readonly removedMessageIds: ReadonlyArray<string>;
    },
    afterSequence: number,
  ) =>
    Effect.gen(function* () {
      const taskId = context.taskId;
      if (taskId === undefined) {
        return;
      }
      for (const removedId of delta.removedMessageIds) {
        const deferredIndex = context.deferredTurns.findIndex(
          (candidate) => candidate.wireTurnId === removedId,
        );
        if (deferredIndex === -1) {
          continue;
        }
        const discarded = context.deferredTurns[deferredIndex]!;
        context.deferredTurns.splice(deferredIndex, 1);
        yield* emit({
          ...(yield* baseEvent(context)),
          eventId: EventId.make(`aether:${taskId}:turn:${discarded.wireTurnId}:cancelled`),
          type: "runtime.warning",
          payload: {
            message: `Your queued message was removed on the Aether side before the agent picked it up. You can send it again:\n\n${discarded.text}`,
          },
        });
        yield* emit({
          ...(yield* baseEvent(context)),
          eventId: EventId.make(`aether:${taskId}:turn:${discarded.wireTurnId}:settled`),
          turnId: discarded.turnId,
          type: "turn.completed",
          payload: { state: "interrupted" },
        });
        yield* onTurnSettled(context, discarded.turnId);
      }
      for (const row of delta.messages) {
        if (row.role !== "user" || row.sequence <= afterSequence) {
          continue;
        }
        const ledgered =
          context.turnLedger.some((entry) => entry.messageId === row.id) ||
          (row.clientMessageId !== undefined &&
            context.issuedClientMessageIds.has(row.clientMessageId));
        if (ledgered || context.warnedRemoteRows.has(row.id)) {
          continue;
        }
        context.warnedRemoteRows.add(row.id);
        yield* emit({
          ...(yield* baseEvent(context)),
          eventId: EventId.make(`aether:${taskId}:remote:${row.id}`),
          type: "runtime.warning",
          payload: {
            message: `This task was driven from the Aether app: ${row.content}`,
          },
        });
      }
    });

  /**
   * Remote-turn eager reconcile (build item 13, idle path): while the session
   * sits idle on a healthy WS, NOTHING else triggers the durable reconcile —
   * a turn injected from the Aether app would stream its whole output live
   * with the warning card arriving only at the next sendTurn/reconnect,
   * violating the warning-before-output contract (spec resolved note 9).
   *
   * Runs on the LIVE FRAME'S OWN wire turn, BEFORE the frame is mapped: the
   * durable feed is authoritative (`inspectDeltaRows` emits the warning, then
   * the delta's rows flow through the mapper), so the frame is mapped against
   * a mapper that has already absorbed everything durable. A frame whose
   * durable twin the reconcile just ingested is then swallowed by the
   * mapper's own gates instead of trailing the reconcile's events as a stale
   * replay — which is exactly what a socket backlog delivers on reconnect.
   * The guard set is populated BEFORE the reconcile so its own
   * processMapperEvents cannot re-enter; a transiently failed reconcile warns
   * loudly through the reconcile's own catch, and the warning then lands on a
   * later reconcile beat.
   *
   * The id on the frame is the LIVE per-dispatch id (a fresh randomUUID per
   * prompt — never the durable user-row id), so the durable-id comparisons
   * below can never match it on their own: every own frame would read as a
   * remote injection and fire a reconcile whose REST backstop can settle the
   * in-flight durable turn (an awaiting_input/processing read) before the live
   * id ever binds to it. The mapper owns the live→durable attribution, so it
   * answers own-vs-remote here; the durable comparisons stay for the ids that
   * ARE durable (a live frame stamped with a durable turn id, the ledger, a
   * deferred steer).
   */
  const eagerRemoteTurnReconcile = (
    context: AetherSessionContext,
    mapper: AetherEventMapper,
    wireTurnId: string | undefined,
  ) =>
    Effect.gen(function* () {
      if (
        wireTurnId === undefined ||
        // A resumed in-flight turn belongs to the adoption path (spec §2.3),
        // not to a remote injection — its opening row predates the resume
        // snapshot, so no warning is owed for it.
        context.adoptActiveTurn ||
        mapper.isOwnLiveTurnId(wireTurnId) ||
        context.activeTurn?.wireTurnId === wireTurnId ||
        context.deferredTurns.some((candidate) => candidate.wireTurnId === wireTurnId) ||
        context.turnLedger.some((entry) => entry.messageId === wireTurnId) ||
        context.remoteTurnSyncs.has(wireTurnId)
      ) {
        return;
      }
      context.remoteTurnSyncs.add(wireTurnId);
      yield* context.reconcile ?? Effect.void;
    });

  /**
   * THE event funnel: every mapper output batch flows through here. The
   * mapper stays pure — its `turn.completed` IS the pre-settle signal, and
   * this funnel turns it into sync-then-settle when a mirror is active. It
   * also owns the deferred steer `turn.started` ordering: strictly after the
   * predecessor's `turn.completed`, strictly before the new turn's first
   * event (spec §2.1 queued/steering row).
   */
  const processMapperEvents = (
    context: AetherSessionContext,
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) =>
    Effect.gen(function* () {
      // Resume-onto-processing adoption (spec §2.3): the session resumed
      // while a turn was already in flight, so the first observation of the
      // active wire turn reconstructs activeTurnId, emits its turn.started
      // (BEFORE the batch's own events) and arms the settle backstop poll —
      // Stop and the mandatory dual-path settle work immediately, not only
      // after the next sendTurn.
      const adoptWire = context.mapper?.activeWireTurnId();
      if (
        context.adoptActiveTurn &&
        adoptWire !== undefined &&
        context.activeTurn === undefined &&
        !context.deferredTurns.some((candidate) => candidate.wireTurnId === adoptWire)
      ) {
        context.adoptActiveTurn = false;
        const adopted: AetherActiveTurn = {
          wireTurnId: adoptWire,
          turnId: turnIdForWire(adoptWire),
        };
        context.activeTurn = adopted;
        yield* emitTurnStarted(context, adopted, {});
        yield* startSettlePoll(context);
      }
      for (const event of events) {
        const deferredMatch =
          event.turnId !== undefined
            ? context.deferredTurns.find((candidate) => candidate.turnId === event.turnId)
            : undefined;
        if (deferredMatch !== undefined) {
          // Remote pickup observed (an event of the deferred turn — possibly
          // its own settle): start the turn before forwarding it. The
          // predecessor's turn.completed already flowed earlier in this
          // batch (the mapper settles a displaced turn first).
          yield* emitDeferredStarted(context, deferredMatch.wireTurnId);
        }
        if (event.type === "turn.completed") {
          yield* syncMirrorForSettle(context, event.turnId);
          yield* emit(event);
          yield* onTurnSettled(context, event.turnId);
        } else {
          yield* emit(event);
        }
      }
      // Pickup can also surface as a bare `activeProcessingTurn` flip in the
      // delta (no rows for the new turn yet).
      const activeWire = context.mapper?.activeWireTurnId();
      if (
        activeWire !== undefined &&
        context.deferredTurns.some((candidate) => candidate.wireTurnId === activeWire)
      ) {
        yield* emitDeferredStarted(context, activeWire);
      }
    });

  /**
   * The session scope, mapper and durable reconciliation — everything the
   * turn engine needs BEFORE any transport exists. Split out of
   * `ensureTaskPipeline` on purpose: sendTurn must be able to record its new
   * turn (mapper + activeTurn + `turn.started`) while nothing can observe a
   * settle yet, and the pump fork is exactly what starts observing.
   */
  const ensureTaskMapper = Effect.fn("ensureAetherTaskMapper")(function* (
    context: AetherSessionContext,
    restClient: AetherRestClient,
    taskId: string,
  ) {
    if (context.sessionScope === undefined) {
      context.sessionScope = yield* Scope.make();
    }
    const sessionScope = context.sessionScope;
    const threadId = context.session.threadId;

    if (context.mapper === undefined) {
      const mapper = makeAetherEventMapper({
        provider: PROVIDER,
        instanceId: options.instanceId,
        threadId,
        taskId,
        initialSequence: context.latestSequence,
      });
      context.mapper = mapper;
      // The durable reconciliation — also the settle backstop the turn poll
      // drives. A transient REST failure warns loudly and leaves the cursor
      // untouched, so the next beat retries the exact same range.
      context.reconcile = Effect.gen(function* () {
        const afterSequence = mapper.latestSequence();
        const delta = yield* restClient.getConversationDelta(taskId, afterSequence);
        // Inspect BEFORE the mapper: remote-originated warnings and
        // superseded-steer settles must precede the batch's own output.
        yield* inspectDeltaRows(context, delta, afterSequence);
        const events = mapper.reconcileDelta(delta, yield* nowIso);
        context.latestSequence = mapper.latestSequence();
        yield* processMapperEvents(context, events);
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("aether.reconcile.failed", { taskId, error: String(error) });
            yield* emit({
              ...(yield* baseEvent(context)),
              type: "runtime.warning",
              payload: {
                message: `Could not reconcile the Aether conversation feed: ${error.message}`,
              },
            });
          }),
        ),
      );
    }
    return { mapper: context.mapper, sessionScope };
  });

  /**
   * Ensure the mapper exists and (when transport options exist) fork the WS
   * attach pump into the session scope. Idempotent per (session, task):
   * re-invoked by sendTurn to restart an ended pump with the one-shot
   * `start=true` permission.
   *
   * CALL ORDER: every caller that is about to start a turn must record that
   * turn FIRST — the attach's `onConnected` reconcile runs on the forked
   * fiber and can settle it immediately.
   */
  const ensureTaskPipeline = Effect.fn("ensureAetherTaskPipeline")(function* (
    context: AetherSessionContext,
    restClient: AetherRestClient,
    taskId: string,
    input: { readonly allowStart: boolean },
  ) {
    const { mapper, sessionScope } = yield* ensureTaskMapper(context, restClient, taskId);
    const reconcile = context.reconcile ?? Effect.void;

    const socket = options.socket;
    if (socket === undefined) {
      // No transport configured. Reachable ONLY from the unit harness: the
      // driver derives `restClient` and `socket` from the same API key
      // (AetherDriver.create), and startSession fails loudly without a
      // restClient — so any session that reaches here in the product has a
      // socket. Nothing to fork, and deliberately no reconcile: a session
      // with no transport also has no feed to reconcile against.
      return;
    }
    // One pump per session at a time. A running pump reconnects by itself;
    // a pump that ENDED (durable-only mode, terminal failure) is restarted
    // here on the next sendTurn — with the one-shot start permission.
    if (context.pumpRunning) {
      return;
    }
    context.pumpRunning = true;

    let sessionStartedEmitted = context.sessionStartedEmitted;
    let slashCommandsLogged = false;
    // Degradation warning: once per failure streak, reset on reconnect.
    let connectRetryWarned = false;

    yield* runAetherAgentStream({
      restClient,
      apiBaseUrl: socket.apiBaseUrl,
      apiKey: socket.apiKey,
      taskId,
      ...(socket.webSocketFactory !== undefined
        ? { webSocketFactory: socket.webSocketFactory }
        : {}),
      ...(socket.timing !== undefined ? { timing: socket.timing } : {}),
      ...(input.allowStart ? { startOnFirstAttach: true } : {}),
      onConnected: (connection) =>
        Effect.gen(function* () {
          connectRetryWarned = false;
          context.connection = connection;
          context.previewToken = connection.previewToken;
          context.workspaceId = connection.workspaceId;
          if (!sessionStartedEmitted) {
            sessionStartedEmitted = true;
            context.sessionStartedEmitted = true;
            yield* emit({
              ...(yield* baseEvent(context)),
              type: "session.started",
              payload: { message: "Attached to the Aether workspace stream." },
            });
          }
          yield* reconcile;
        }),
      onPortsMessage: (message) =>
        Effect.gen(function* () {
          // Best-effort cloud port previews. A port only surfaces once (deduped
          // across snapshot re-syncs); a close re-arms it so a re-open re-emits.
          const previewToken = context.previewToken;
          const workspaceId = context.workspaceId;
          if (previewToken === undefined || workspaceId === undefined) {
            return;
          }
          if (message._tag === "change" && message.action === "close") {
            context.emittedPorts.delete(message.port);
            return;
          }
          const ports = message._tag === "snapshot" ? message.ports : [message.port];
          for (const port of ports) {
            if (context.emittedPorts.has(port)) {
              continue;
            }
            const url = buildAetherPreviewUrl({
              apiBaseUrl: socket.apiBaseUrl,
              workspaceId,
              port,
              previewToken,
            });
            if (url === undefined) {
              continue;
            }
            context.emittedPorts.add(port);
            yield* emit({
              ...(yield* baseEvent(context)),
              type: "port.opened",
              payload: { port, url },
            });
          }
        }),
      onDisconnected: () =>
        Effect.sync(() => {
          context.connection = undefined;
        }),
      onEvent: (event) =>
        Effect.gen(function* () {
          if (event.kind === "slash_commands.updated" && !slashCommandsLogged) {
            // No t3 slash-command surface for cloud sessions yet; log once.
            slashCommandsLogged = true;
            yield* Effect.logInfo("aether.slash-commands.ignored", { taskId });
          }
          // STRICTLY before the frame is mapped — see eagerRemoteTurnReconcile.
          yield* eagerRemoteTurnReconcile(
            context,
            mapper,
            "turnId" in event ? event.turnId : undefined,
          );
          const events = mapper.mapWsEvent(event, yield* nowIso);
          context.latestSequence = mapper.latestSequence();
          yield* processMapperEvents(context, events);
          // Durable-authoritative settlement: for a grounded turn the mapper
          // suppresses the live terminal frame's settle (no turn.completed in
          // `events`). Use the frame as a TRIGGER to fire the durable reconcile
          // NOW, so the durable settle (and its mirror sync via
          // processMapperEvents) emits promptly instead of waiting for the ~3s
          // settle poll. In the cold path the live settle already produced a
          // turn.completed, so this no-ops. reconcile is idempotent
          // (settledTurns/latestSequence guards), so firing before the task row
          // has flipped is harmless — the settle poll backstop still catches it.
          if (
            (event.kind === "turn.completed" ||
              event.kind === "turn.failed" ||
              event.kind === "turn.awaiting_input") &&
            !events.some((mapped) => mapped.type === "turn.completed")
          ) {
            yield* reconcile;
          }
        }),
      onFrameDropped: (problem) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("aether.frame.dropped", { taskId, ...problem });
          yield* emit({
            ...(yield* baseEvent(context)),
            type: "runtime.warning",
            payload: {
              message:
                "Dropped an Aether live event t3 could not parse; the durable feed remains authoritative.",
              detail: problem,
            },
          });
        }),
      onConnectRetry: (failure) =>
        Effect.gen(function* () {
          // The attach never reached subscribe, so onConnected's reconcile
          // will not run — surface the degradation ONCE per failure streak
          // and drive the durable backstop from this retry beat instead
          // (REST-delta-only degrade, spec §3.11): live turn settles are
          // unrecoverable except through this reconcile while opens fail.
          yield* Effect.logWarning("aether.stream.connect-retry", { taskId, ...failure });
          if (!connectRetryWarned) {
            connectRetryWarned = true;
            yield* emit({
              ...(yield* baseEvent(context)),
              type: "runtime.warning",
              payload: {
                message:
                  "Cannot reach the Aether workspace's live stream; retrying. The transcript keeps updating from the durable feed meanwhile.",
                detail: failure,
              },
            });
          }
          yield* reconcile;
        }),
      onDurableOnly: (reason) =>
        Effect.gen(function* () {
          // Stable end state for this attach: replay the durable feed once
          // so the transcript catches up; the next sendTurn re-attaches.
          yield* Effect.logInfo("aether.stream.durable-only", { taskId, reason });
          yield* reconcile;
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("aether.stream.failed", { taskId, error: String(error) });
          const isTaskErrored = error._tag === "AetherTaskErroredError";
          yield* emit({
            // The task-errored surface shares the mapper's deterministic id
            // so a REST-side projection of the same failure collides
            // (idempotent) instead of duplicating.
            ...(yield* baseEvent(context)),
            ...(isTaskErrored ? { eventId: EventId.make(`aether:${taskId}:errored`) } : {}),
            type: "runtime.error",
            payload: {
              message: error.message,
              class: isTaskErrored ? "provider_error" : "transport_error",
            },
          });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          context.pumpRunning = false;
          context.connection = undefined;
        }),
      ),
      Effect.forkIn(sessionScope),
    );
  });

  /**
   * The REST settle backstop (spec build item 7): while a turn is active,
   * poll the durable feed every ~settlePollMs — turn.completed/failed are
   * live-only, so this is the ONLY settle recovery while the socket is down.
   * Also drives the user-activity keep-alive so the VM's interactive idle
   * hold survives a long turn.
   */
  const startSettlePoll = Effect.fn("startAetherSettlePoll")(function* (
    context: AetherSessionContext,
  ) {
    if (context.pollRunning || context.sessionScope === undefined) {
      return;
    }
    context.pollRunning = true;
    yield* Effect.gen(function* () {
      while (context.activeTurn !== undefined || context.deferredTurns.length > 0) {
        yield* Effect.sleep(Duration.millis(turnTiming.settlePollMs));
        if (context.connection !== undefined) {
          yield* context.connection.sendUserActivity().pipe(Effect.ignore);
        }
        yield* context.reconcile ?? Effect.void;
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          context.pollRunning = false;
        }),
      ),
      Effect.forkIn(context.sessionScope),
    );
  });

  /**
   * Fetch the FULL conversation timeline, oldest row first, walking
   * `hasMoreOlder` back to the first turn — the endpoint serves the NEWEST
   * page first. Shared by readThread (snapshot) and the startSession ledger
   * rebuild. The cursor must advance every page and must exist whenever more
   * rows are claimed — either violation is a contract break, surfaced loudly
   * instead of looping forever or silently truncating.
   */
  const fetchFullTimeline = Effect.fn("fetchAetherFullTimeline")(function* (
    restClient: AetherRestClient,
    taskId: string,
    method: string,
  ): Effect.fn.Return<ReadonlyArray<AetherTimelineMessage>, ProviderAdapterError> {
    let page = yield* restClient
      .getConversationMessages(taskId)
      .pipe(Effect.mapError(toRestRequestError(method)));
    const rows: Array<AetherTimelineMessage> = [...page.messages];
    while (page.hasMoreOlder) {
      const beforeSequence = page.oldestSequenceLoaded;
      const beforeSortTimestamp = page.oldestSortTimestampLoaded;
      if (beforeSequence === null || beforeSortTimestamp === null) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Aether conversation page for task '${taskId}' reports more older rows but carries no older-page cursor.`,
        });
      }
      page = yield* restClient
        .getConversationMessages(taskId, {
          sequence: beforeSequence,
          sortTimestamp: beforeSortTimestamp,
        })
        .pipe(Effect.mapError(toRestRequestError(method)));
      if (page.oldestSequenceLoaded !== null && page.oldestSequenceLoaded >= beforeSequence) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Aether conversation paging for task '${taskId}' did not advance past sequence ${beforeSequence}.`,
        });
      }
      rows.unshift(...page.messages);
    }
    return rows;
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
    "startSession",
  )(function* (input) {
    const restClient = yield* requireRestClient("startSession");
    const cwd = input.cwd ?? options.defaultCwd;

    if (
      input.modelSelection !== undefined &&
      input.modelSelection.instanceId !== options.instanceId
    ) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Aether model selection is bound to instance '${input.modelSelection.instanceId}', expected '${options.instanceId}'.`,
      });
    }

    // (1) Mirror preflight. A FRESH thread on the shared "Current checkout"
    // requires a clean tree on a pushed, in-sync branch — the mirror's base
    // state — because that mode can clobber the user's uncommitted work. A
    // RESUMED thread's mirror is dirty BY DESIGN (it holds the applied
    // cumulative diff), so only the structural checks apply; content integrity
    // is enforced by the sync engine's fingerprint verify instead. A driver-
    // owned per-thread worktree (input.managedWorktree) is created clean from
    // origin/{base} and only the driver writes to it, so the clean-tree checks
    // are unnecessary there and are skipped.
    const resume = parseAetherResume(input.resumeCursor);
    const isResume = resume !== undefined;
    const status = yield* git
      .statusDetails(cwd)
      .pipe(Effect.mapError(toGitRequestError("startSession")));
    const issue =
      input.managedWorktree === true
        ? managedWorktreePreflightIssue(status, cwd)
        : isResume
          ? resumePreflightIssue(status, cwd)
          : preflightIssue(status, cwd);
    if (issue !== undefined) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue,
      });
    }
    // (1b) Task base branch — the ref a NEW cloud task clones and fetches. Only
    // the first send (non-resume) creates a task and sends base_branch; a resume
    // reattaches to an existing task and never sends it, so the requirement below
    // is gated on !isResume (else a resumed managed worktree whose config is
    // missing — an old thread or a repaired checkout — would fail to reattach).
    // For "Current checkout" the local branch IS the pushed base (preflight
    // enforces it), so status.branch is correct. A driver-owned worktree instead
    // sits on a LOCAL scratch branch that was never pushed; the cloud must base
    // on the branch it was FORKED from, which createWorktree recorded in
    // `branch.<head>.gh-merge-base`. Passing the scratch branch is exactly what
    // fails cloud startup with remote_ref_missing (404).
    let baseBranch = status.branch ?? undefined;
    if (!isResume && input.managedWorktree === true && status.branch !== null) {
      const recordedBase = (yield* git
        .readConfigValue(cwd, `branch.${status.branch}.gh-merge-base`)
        .pipe(Effect.mapError(toGitRequestError("startSession"))))?.trim();
      if (!recordedBase) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `The Aether worktree branch '${status.branch}' has no recorded base branch (branch.${status.branch}.gh-merge-base). The cloud task needs a base that exists on the remote — recreate the thread so its worktree records a fork base.`,
        });
      }
      baseBranch = recordedBase;
    }
    // The mirror baseline: for a never-synced thread the expected pre-sync
    // state is "clean tree at this HEAD".
    const baselineHeadSha = yield* git
      .execute({
        operation: "aether.startSession.baseline",
        cwd,
        args: ["rev-parse", "HEAD"],
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.mapError(toGitRequestError("startSession")),
      );

    // (2) Repo → project resolution via the canonical owner/repo key.
    const originUrl = yield* git
      .readConfigValue(cwd, "remote.origin.url")
      .pipe(Effect.mapError(toGitRequestError("startSession")));
    if (originUrl === null || originUrl.trim().length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `'${cwd}' has no 'origin' remote. Aether cloud tasks run against a repository linked in Aether, matched by the origin remote URL.`,
      });
    }
    const repoKey = normalizeGitRemoteUrl(originUrl);
    const projects = yield* restClient
      .listProjects()
      .pipe(Effect.mapError(toRestRequestError("startSession")));
    const matches = projects.filter(
      (project): project is AetherProject & { readonly repo_url: string } =>
        typeof project.repo_url === "string" && normalizeGitRemoteUrl(project.repo_url) === repoKey,
    );
    if (matches.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `No Aether project is linked to '${originUrl.trim()}'. Link or import the repository in Aether first, then retry.`,
      });
    }
    if (matches.length > 1) {
      const candidates = matches.map((project) => `'${project.name}' (${project.id})`).join(", ");
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Multiple Aether projects are linked to '${originUrl.trim()}': ${candidates}. Archive the duplicates in Aether or start the task from Aether directly.`,
      });
    }
    const project = matches[0]!;

    // (3) Resume validation: the cursor's task must still exist remotely AND
    // belong to the project the cwd just resolved to — a persisted cursor is
    // untrusted input, and binding a foreign project's task here would later
    // mirror that repo's diffs onto this checkout.
    let taskId: string | undefined;
    let latestSequence = 0;
    let turnLedger: Array<AetherTurnLedgerEntry> = [];
    let resumedTask: AetherTask | undefined;
    if (resume !== undefined) {
      const task = yield* restClient.getTask(resume.taskId).pipe(
        Effect.mapError((cause) =>
          cause._tag === "AetherApiNotFoundError"
            ? new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
                cause,
              })
            : toRestRequestError("startSession")(cause),
        ),
      );
      if (task.project_id !== project.id) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Resumed Aether task '${resume.taskId}' belongs to project '${task.project_id}', but '${cwd}' resolves to project '${project.name}' (${project.id}). The checkout and the thread's cloud task have diverged — start the thread from the task's repository checkout, or start a fresh thread here.`,
        });
      }
      taskId = resume.taskId;
      resumedTask = task;
      // Keep the CURSOR's sequence, not the task row's: it is the safe
      // replay point — fast-forwarding here would skip never-ingested rows.
      latestSequence = resume.latestSequence;
      // Rebuild the WHOLE turn ledger from the conversation page rather than
      // trusting the cursor snapshot (spec build item 10, resolved note 7):
      // the persisted ledger is stale by up to a turn after a crash (a
      // respond's entry lives only in memory until the next cursor
      // snapshot), and an unledgered own row would be misclassified as
      // remote-originated. Every user row IS a turn (the wire turn id is the
      // opening user row's id), so remote-turn warnings (build item 13)
      // apply only to rows arriving AFTER this snapshot — exactly the set
      // the readThread snapshot cannot already render as real turns.
      const timeline = yield* fetchFullTimeline(restClient, resume.taskId, "startSession");
      turnLedger = timeline
        .filter((row) => row.role === "user")
        .map((row) => ({ turnId: String(turnIdForWire(row.id)), messageId: row.id }));
    }

    // (4) Session record. Model precedence: explicit selection, else the
    // project's task defaults as the composite `<agent_type>/<model>` slug.
    const model =
      input.modelSelection?.model ??
      `${project.task_defaults.agent_type}/${project.task_defaults.model}`;
    const createdAt = yield* nowIso;
    const context: AetherSessionContext = {
      session: {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        model,
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      },
      cwd,
      projectId: project.id,
      baseBranch,
      taskId,
      latestSequence,
      turnLedger,
      issuedClientMessageIds: new Set<string>(),
      warnedRemoteRows: new Set<string>(),
      remoteTurnSyncs: new Set<string>(),
      sessionScope: undefined,
      mapper: undefined,
      mirror: makeAetherMirrorSync({
        cwd,
        git,
        baselineHeadSha,
        persistedFingerprint: resume?.mirrorFingerprint,
        // Lazily reads the surrounding context: the first sendTurn fills the
        // task id in before any turn can settle.
        getTaskId: () => context.taskId,
      }),
      connection: undefined,
      previewToken: undefined,
      workspaceId: undefined,
      emittedPorts: new Set<number>(),
      reconcile: undefined,
      pumpRunning: false,
      sessionStartedEmitted: false,
      activeTurn: undefined,
      adoptActiveTurn: resumedTask?.status === "processing",
      deferredTurns: [],
      pollRunning: false,
      sentCount: 0,
      firstTurnPending: false,
      firstTurnFingerprint: undefined,
    };
    const resumeCursor = buildAetherResumeCursor(context);
    if (resumeCursor !== undefined) {
      context.session = { ...context.session, resumeCursor };
    }
    // A re-entrant start (mode change, worktree hop) replaces the previous
    // attach: tear its socket down before binding the new one.
    const previous = sessions.get(input.threadId);
    if (previous !== undefined) {
      yield* closeSessionScope(previous);
      yield* mirrorRegistry.deregister(previous.cwd, registryKey(input.threadId));
    }
    sessions.set(input.threadId, context);
    // The fork-side write guard owns this cwd for the thread's lifetime.
    yield* mirrorRegistry.register(cwd, registryKey(input.threadId));

    // (5) Stream attach: a resumed live task starts streaming immediately
    // (PASSIVE — never boots a VM). No task yet (fresh thread) → nothing to
    // attach until the first sendTurn creates one.
    if (taskId !== undefined) {
      yield* ensureTaskPipeline(context, restClient, taskId, { allowStart: false });
    }
    return context.session;
  });

  // Shared pure-disconnect teardown: the cloud task keeps running and the VM
  // idles itself out (spec §2.3 reaper-safety) — never POST /tasks/{id}/stop.
  // Closing the scope interrupts the attach pump and its finalizer closes the
  // WS; ingestion relies on one graceful session.exited per thread to clear
  // active-turn/liveness state, so every disconnect path emits it.
  const disconnectSession = Effect.fn("disconnectSession")(function* (
    threadId: ThreadId,
    context: AetherSessionContext,
  ) {
    yield* closeSessionScope(context);
    sessions.delete(threadId);
    // Release the fork-side write guard: the cwd is an ordinary local
    // checkout again the moment the Aether thread lets go of it.
    yield* mirrorRegistry.deregister(context.cwd, registryKey(threadId));
    yield* emit({
      eventId: yield* randomEventId,
      provider: PROVIDER,
      // Ingestion rewrites the thread session from this event and preserves
      // instance identity only when the event carries it.
      providerInstanceId: options.instanceId,
      threadId,
      createdAt: yield* nowIso,
      type: "session.exited",
      payload: {
        reason:
          context.taskId === undefined
            ? "Disconnected from Aether."
            : "Disconnected from Aether; the cloud task keeps running.",
        recoverable: true,
        exitKind: "graceful",
      },
    });
  });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = Effect.fn(
    "stopSession",
  )(function* (threadId) {
    const context = yield* ensureContext(threadId);
    yield* disconnectSession(threadId, context);
  });

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = Effect.fn(
    "readThread",
  )(function* (threadId) {
    const context = yield* ensureContext(threadId);
    if (context.taskId === undefined) {
      // No task yet — the thread has no remote conversation until the first
      // sendTurn creates one.
      return { threadId, turns: [] } satisfies ProviderThreadSnapshot;
    }
    const restClient = yield* requireRestClient("readThread");
    // A snapshot missing older turns would be silent data loss — walk the
    // whole timeline back to the first turn.
    const rows = yield* fetchFullTimeline(restClient, context.taskId, "readThread");
    return {
      threadId,
      turns: snapshotTurnsFromMessages(rows),
    } satisfies ProviderThreadSnapshot;
  });

  // -- turn lifecycle (build item 7) ----------------------------------------

  /** Validate + encode t3 chat attachments into Aether prompt attachments. */
  const buildPromptAttachments = Effect.fn("buildAetherAttachments")(function* (
    attachments: ReadonlyArray<ChatAttachment>,
  ): Effect.fn.Return<ReadonlyArray<AetherPromptAttachment> | undefined, ProviderAdapterError> {
    if (attachments.length === 0) {
      return undefined;
    }
    const built: Array<AetherPromptAttachment> = [];
    for (const attachment of attachments) {
      // Aether validates a lowercase, parameter-free media type against its
      // platform allowlist — reject locally BEFORE any API call.
      const mediaType = (attachment.mimeType.split(";")[0] ?? "").trim().toLowerCase();
      if (!AETHER_ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Attachment '${attachment.name}' has media type '${mediaType}', which Aether does not accept. Supported: ${[...AETHER_ATTACHMENT_MEDIA_TYPES].sort().join(", ")}.`,
        });
      }
      if (attachment.sizeBytes > AETHER_ATTACHMENT_MAX_BYTES) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Attachment '${attachment.name}' is ${attachment.sizeBytes} bytes; Aether accepts at most ${AETHER_ATTACHMENT_MAX_BYTES} bytes (5 MiB) per attachment.`,
        });
      }
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: options.attachmentsDir,
        attachment,
      });
      if (attachmentPath === null) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Could not read attachment '${attachment.name}': ${cause.message}`,
              cause,
            }),
        ),
      );
      if (bytes.length > AETHER_ATTACHMENT_MAX_BYTES) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Attachment '${attachment.name}' decodes to ${bytes.length} bytes; Aether accepts at most ${AETHER_ATTACHMENT_MAX_BYTES} bytes (5 MiB) per attachment.`,
        });
      }
      built.push({
        filename: attachment.name,
        mediaType,
        data: Buffer.from(bytes).toString("base64"),
      });
    }
    return built;
  });

  /**
   * Reasoning effort from the model selection's option descriptor selection.
   * Catalog models validate against their selectable set — Aether 422s
   * non-selectable values, so an invalid selection fails HERE, loudly.
   */
  const resolveEffortSelection = (
    selection:
      | {
          readonly options?: ReadonlyArray<{
            readonly id: string;
            readonly value: string | boolean;
          }>;
        }
      | undefined,
    resolved: ReturnType<typeof resolveAetherModelSlug>,
  ): Effect.Effect<string | undefined, ProviderAdapterValidationError> =>
    Effect.gen(function* () {
      const raw = selection?.options?.find((option) => option.id === "reasoningEffort")?.value;
      if (raw === undefined) {
        return undefined;
      }
      if (typeof raw !== "string") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Reasoning effort selection must be a string, got ${typeof raw}.`,
        });
      }
      if (resolved.catalogAgentType !== undefined) {
        const allowed = reasoningEffortsForModel(resolved.catalogAgentType, resolved.model);
        if (!allowed.includes(raw)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Reasoning effort '${raw}' is not selectable for ${resolved.catalogAgentType}/${resolved.model}. Selectable: ${allowed.join(", ") || "(none)"}.`,
          });
        }
      }
      return raw;
    });

  /**
   * Turn 1's wire turn id is the first user row's id — `POST /tasks` returns
   * `{id, name}` only, so it is harvested from the conversation delta
   * (spec resolved note 7).
   */
  const harvestFirstUserRowId = Effect.fn("harvestAetherFirstUserRow")(function* (
    restClient: AetherRestClient,
    taskId: string,
  ): Effect.fn.Return<string, ProviderAdapterError> {
    for (let attempt = 1; attempt <= turnTiming.harvestMaxAttempts; attempt++) {
      const delta = yield* restClient
        .getConversationDelta(taskId, 0)
        .pipe(Effect.mapError(toRestRequestError("sendTurn")));
      const userRow = [...delta.messages]
        .filter((row) => row.role === "user")
        .sort((left, right) => left.sequence - right.sequence)[0];
      if (userRow !== undefined) {
        return userRow.id;
      }
      yield* Effect.sleep(Duration.millis(turnTiming.harvestPollMs));
    }
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "sendTurn",
      detail: `Created Aether task '${taskId}' but its first user message row never appeared in the conversation feed.`,
    });
  });

  const emitTurnStarted = (
    context: AetherSessionContext,
    turn: AetherActiveTurn,
    payload: { readonly model?: string; readonly effort?: string },
  ) =>
    Effect.gen(function* () {
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turn.turnId,
        updatedAt: yield* nowIso,
      };
      const resumeCursor = buildAetherResumeCursor(context);
      if (resumeCursor !== undefined) {
        context.session = { ...context.session, resumeCursor };
      }
      yield* emit({
        ...(yield* baseEvent(context)),
        ...(context.taskId !== undefined
          ? { eventId: EventId.make(`aether:${context.taskId}:turn:${turn.wireTurnId}:started`) }
          : {}),
        turnId: turn.turnId,
        type: "turn.started",
        payload: {
          ...(payload.model !== undefined ? { model: payload.model } : {}),
          ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
        },
      });
    });

  /**
   * Shared post-202 bookkeeping for a respond that dispatches IMMEDIATELY
   * (idle follow-up, plan accept/reject, question answer): ledger the new
   * wire turn, (re)attach the pipeline with the one-shot start permission,
   * register + announce the turn, and arm the settle backstop.
   */
  const activateRespondedTurn = Effect.fn("activateAetherRespondedTurn")(function* (
    context: AetherSessionContext,
    restClient: AetherRestClient,
    taskId: string,
    wireTurnId: string,
  ): Effect.fn.Return<AetherActiveTurn, ProviderAdapterError> {
    const turn: AetherActiveTurn = { wireTurnId, turnId: turnIdForWire(wireTurnId) };
    context.turnLedger.push({ turnId: String(turn.turnId), messageId: wireTurnId });
    // RECORD THE TURN FIRST (T6 invariant): the attach below forks a pump
    // whose onConnected reconcile can settle this very turn on its first
    // beat — attaching before the turn exists strands activeTurn state.
    const { mapper } = yield* ensureTaskMapper(context, restClient, taskId);
    context.activeTurn = turn;
    yield* processMapperEvents(context, mapper.noteTurnStarted(wireTurnId, yield* nowIso));
    yield* emitTurnStarted(context, turn, {});
    yield* ensureTaskPipeline(context, restClient, taskId, { allowStart: true });
    yield* startSettlePoll(context);
    return turn;
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn("sendTurn")(
    function* (input) {
      const context = yield* ensureContext(input.threadId);
      const restClient = yield* requireRestClient("sendTurn");
      if (
        input.modelSelection !== undefined &&
        input.modelSelection.instanceId !== options.instanceId
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Aether model selection is bound to instance '${input.modelSelection.instanceId}', expected '${options.instanceId}'.`,
        });
      }
      const message = input.input?.trim();
      if (message === undefined || message.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Aether requires a non-empty text prompt for every turn.",
        });
      }
      // Attachments validate + encode BEFORE any API call.
      const attachments = yield* buildPromptAttachments(input.attachments ?? []);
      const promptContext = attachments !== undefined ? { attachments } : undefined;

      // -- first turn: create the cloud task --------------------------------
      if (context.taskId === undefined || context.firstTurnPending) {
        const slug = input.modelSelection?.model ?? context.session.model;
        if (slug === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "The session carries no model slug; cannot dispatch an Aether task.",
          });
        }
        const resolved = resolveAetherModelSlug(slug);
        const effort = yield* resolveEffortSelection(input.modelSelection, resolved);
        // Length-prefixed, control-char-delimited — deterministic without
        // JSON (repo lint prefers Schema codecs for real serialization; this
        // string is only ever compared, never parsed).
        const dispatchFingerprint = [
          `${message.length}:${message}`,
          slug,
          effort ?? "",
          input.interactionMode ?? "default",
          ...(attachments ?? []).map(
            (attachment) =>
              `${attachment.filename}\u0000${attachment.mediaType}\u0000${attachment.data.length}:${attachment.data}`,
          ),
        ].join("\u0001");
        if (context.taskId === undefined) {
          const created = yield* restClient
            .createTask({
              project_id: context.projectId,
              prompt: message,
              ...(context.baseBranch !== undefined ? { base_branch: context.baseBranch } : {}),
              ...(promptContext !== undefined ? { context: promptContext } : {}),
              agent_type: resolved.agentType,
              model: resolved.model,
              interaction_mode: input.interactionMode ?? "default",
              ...(effort !== undefined ? { reasoning_effort: effort } : {}),
              auto_fix_ci: false,
              auto_fix_pr_comments: false,
              auto_rebase: false,
            })
            .pipe(Effect.mapError(toRestRequestError("sendTurn")));
          context.taskId = created.id;
          context.sentCount = 1;
          context.firstTurnPending = true;
          context.firstTurnFingerprint = dispatchFingerprint;
        } else if (context.firstTurnFingerprint !== dispatchFingerprint) {
          // The created task already carries the first dispatch; a retry
          // with different text, attachments, model or mode would silently
          // discard one of the two. Refuse.
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue:
              "The first prompt was already dispatched to Aether but its turn is still being brought up. Retry with exactly the same input, or wait for the turn to appear and send the change as a follow-up.",
          });
        }
        const taskIdForFirstTurn = context.taskId;
        // Turn 1's wire id = the first user row (nothing else names it).
        // Harvest/attach failures leave firstTurnPending set: the retry
        // re-enters HERE — never the respond path, never a second create.
        const wireTurnId = yield* harvestFirstUserRowId(restClient, taskIdForFirstTurn);
        const turn: AetherActiveTurn = { wireTurnId, turnId: turnIdForWire(wireTurnId) };
        // Ledger the harvested pair — `POST /tasks` returns no message_id,
        // so the timeline harvest is turn 1's only naming (resolved note 7).
        context.turnLedger.push({ turnId: String(turn.turnId), messageId: wireTurnId });
        // RECORD THE TURN FIRST. The mapper must learn the active wire turn
        // so a settle observed only through the REST backstop still lands —
        // and the attach below forks a fiber whose onConnected reconcile can
        // settle this very turn on its first beat. Attaching before the turn
        // exists lets `turn.completed` (and onTurnSettled's clean-up) run
        // against a turn that was never started, stranding activeTurn state.
        const { mapper } = yield* ensureTaskMapper(context, restClient, taskIdForFirstTurn);
        yield* processMapperEvents(context, mapper.noteTurnStarted(wireTurnId, yield* nowIso));
        context.activeTurn = turn;
        yield* emitTurnStarted(context, turn, {
          model: slug,
          ...(effort !== undefined ? { effort } : {}),
        });
        // ACTIVE attach — the one path allowed to pass start=true.
        yield* ensureTaskPipeline(context, restClient, taskIdForFirstTurn, { allowStart: true });
        yield* startSettlePoll(context);
        context.firstTurnPending = false;
        context.firstTurnFingerprint = undefined;
        const resumeCursor = buildAetherResumeCursor(context);
        return {
          threadId: input.threadId,
          turnId: turn.turnId,
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        };
      }

      // -- later turns: respond ---------------------------------------------
      const taskId = context.taskId;

      // The selection's reasoning effort, resolved (and validated) ONCE for
      // both the settings PUT below and the respond. It rides EVERY respond,
      // not just a slug switch: a model OPTION can change while the slug
      // stays the same, and a respond that omits it inherits the task row's
      // stored effort — silently pinning the previous one. `POST /respond`
      // carries a per-message `reasoning_effort` (apitypes/tasks.go
      // RespondToTaskRequest → task_messages.reasoning_effort) that IS what
      // the runner reads for the turn, so stating it here is both the
      // smallest fix and the only one that works for a steer queued behind a
      // running turn (a PUT is refused while the task is processing).
      const selectionEffort =
        input.modelSelection === undefined
          ? undefined
          : yield* resolveEffortSelection(
              input.modelSelection,
              resolveAetherModelSlug(input.modelSelection.model),
            );

      // Model switch between turns (build item 11): `PUT /tasks/{id}` is a
      // FULL settings replace, so the current row is read back first — the
      // auto_fix_* flags are live-mutable remotely and must not be clobbered
      // with the driver's create-time `false`.
      if (
        input.modelSelection !== undefined &&
        input.modelSelection.model !== context.session.model
      ) {
        if (context.activeTurn !== undefined || context.deferredTurns.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Cannot switch the model to '${input.modelSelection.model}' while a turn is running; stop the turn or let it finish first.`,
          });
        }
        const resolved = resolveAetherModelSlug(input.modelSelection.model);
        const current = yield* restClient
          .getTask(taskId)
          .pipe(Effect.mapError(toRestRequestError("sendTurn")));
        if (current.status === "processing" || current.status === "queued") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Cannot switch the model: Aether task '${taskId}' is currently ${current.status} (a turn driven from the Aether app may be running). Wait for it to settle, then retry.`,
          });
        }
        yield* restClient
          .updateTask(taskId, {
            agent_type: resolved.agentType,
            model: resolved.model,
            // Per-turn plan mode travels on the respond below; the stored
            // task setting is preserved as-is.
            interaction_mode: current.interaction_mode,
            // Required-but-nullable on update: null means an explicit null.
            reasoning_effort: selectionEffort ?? null,
            auto_fix_ci: current.auto_fix_ci,
            auto_fix_pr_comments: current.auto_fix_pr_comments,
            auto_rebase: current.auto_rebase,
          })
          .pipe(Effect.mapError(toRestRequestError("sendTurn")));
        context.session = {
          ...context.session,
          model: input.modelSelection.model,
          updatedAt: yield* nowIso,
        };
      }

      const clientMessageId = deterministicClientMessageId({
        taskId,
        sessionEpoch: context.session.createdAt,
        sendOrdinal: context.sentCount,
      });

      // A task parked on a proposed plan makes this send the accept/reject
      // verb (spec §2.4): t3 routes plan acceptance as a fresh turn with
      // interactionMode 'default' (ChatView thread.turn.start) and a
      // keep-planning follow-up as interactionMode 'plan' — Aether demands
      // the propose_plan tool_response either way.
      const pendingPlan = context.mapper?.openUserInput();
      if (pendingPlan !== undefined && pendingPlan.toolName === "propose_plan") {
        const approved = input.interactionMode !== "plan";
        // Registered BEFORE the call: the server commits the user row before
        // the 202 returns, so a concurrent settle-poll reconcile can observe
        // it mid-flight — pre-registration keeps the own-send classification
        // from warning on it. Safe: the id is deterministic per ordinal, and
        // the ordinal advances only on a confirmed 202.
        context.issuedClientMessageIds.add(clientMessageId);
        const responded = yield* restClient
          .respondToTask(taskId, {
            message,
            ...(promptContext !== undefined ? { context: promptContext } : {}),
            interaction_mode: approved ? "default" : "plan",
            tool_response: {
              tool_name: "propose_plan",
              data: { approved, ...(approved ? {} : { feedback: message }) },
            },
            client_message_id: clientMessageId,
          })
          .pipe(Effect.mapError(toRestRequestError("sendTurn")));
        context.sentCount++;
        context.adoptActiveTurn = false;
        if (context.mapper !== undefined) {
          // Close the pending slot (no resolution event for plan cards).
          yield* processMapperEvents(
            context,
            context.mapper.noteInputResolved(pendingPlan.pendingId, {}, yield* nowIso),
          );
        }
        const turn = yield* activateRespondedTurn(
          context,
          restClient,
          taskId,
          responded.message_id,
        );
        const resumeCursor = buildAetherResumeCursor(context);
        return {
          threadId: input.threadId,
          turnId: turn.turnId,
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        };
      }

      // Registered BEFORE the call (see the plan branch above): the row can
      // hit the wire before the 202 lands here.
      context.issuedClientMessageIds.add(clientMessageId);
      const responded = yield* restClient
        .respondToTask(taskId, {
          message,
          ...(promptContext !== undefined ? { context: promptContext } : {}),
          ...(input.interactionMode !== undefined
            ? { interaction_mode: input.interactionMode }
            : {}),
          // Only on a plain prompt: workspace-service applies a queued
          // message's reasoning_effort ONLY when the message carries no
          // tool_response (http/agent-handlers.ts), so stating it on the plan
          // branch above would be dead payload.
          ...(selectionEffort !== undefined ? { reasoning_effort: selectionEffort } : {}),
          client_message_id: clientMessageId,
        })
        .pipe(Effect.mapError(toRestRequestError("sendTurn")));
      // Advance the ordinal only on a confirmed 202: a respond whose answer
      // was lost in transit retries with the SAME client_message_id, so the
      // server's ON CONFLICT dedupe can actually fire — incrementing before
      // the call would burn the id and deliver the prompt twice.
      context.sentCount++;
      // The user is driving this thread now — a pending resume-adoption of a
      // remotely running turn no longer applies.
      context.adoptActiveTurn = false;
      const wireTurnId = responded.message_id;

      if (context.activeTurn !== undefined || context.deferredTurns.length > 0) {
        // STEER: Aether queues the message server-side; the running turn
        // completes first. DEFER turn.started until remote pickup, but set
        // the session's activeTurnId to the new turn NOW (spec §2.1
        // queued/steering row).
        const turn: AetherActiveTurn = { wireTurnId, turnId: turnIdForWire(wireTurnId) };
        context.turnLedger.push({ turnId: String(turn.turnId), messageId: wireTurnId });
        context.deferredTurns.push({ ...turn, text: message });
        context.session = {
          ...context.session,
          activeTurnId: turn.turnId,
          updatedAt: yield* nowIso,
        };
        yield* startSettlePoll(context);
        const resumeCursor = buildAetherResumeCursor(context);
        return {
          threadId: input.threadId,
          turnId: turn.turnId,
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        };
      }

      // Idle task: the respond dispatches immediately. activateRespondedTurn
      // records the turn BEFORE the attach for the same reason as the create
      // path — a pump restarted here reconciles on its first beat and can
      // settle it. Re-attaches if the pump ended (suspended VM); may start.
      const turn = yield* activateRespondedTurn(context, restClient, taskId, wireTurnId);
      const resumeCursor = buildAetherResumeCursor(context);
      return {
        threadId: input.threadId,
        turnId: turn.turnId,
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
      };
    },
  );

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = Effect.fn(
    "interruptTurn",
  )(function* (threadId, _turnId) {
    const context = yield* ensureContext(threadId);
    const restClient = yield* requireRestClient("interruptTurn");
    const taskId = context.taskId;
    if (taskId === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "interruptTurn",
        detail: "The thread has no Aether task yet; there is nothing to interrupt.",
      });
    }
    const active = context.activeTurn;
    const deferred = [...context.deferredTurns];
    if (active === undefined && deferred.length === 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "interruptTurn",
        detail: "No Aether turn is active on this thread.",
      });
    }
    // Discarding queued messages is the explicit design choice: keeping them
    // would let Aether's done-callback restart the agent and Stop would not
    // stick (spec resolved note 6).
    yield* restClient
      .stopTask(taskId, { discardQueuedMessages: true })
      .pipe(Effect.mapError(toRestRequestError("interruptTurn")));
    // The settle — whichever transport observes it — must read `interrupted`.
    // Marked only AFTER the stop 200: a failed stop leaves the turn running
    // remotely, and the mapper flag is sticky — marking optimistically would
    // falsify a later natural settle into 'interrupted'.
    if (active !== undefined) {
      context.mapper?.markInterrupted(active.wireTurnId);
    }
    // Re-offer any driver-queued (steer) message text the stop discarded,
    // and cancel their deferred turn.starteds — the thread must stay idle.
    context.deferredTurns = [];
    for (const discarded of deferred) {
      yield* emit({
        ...(yield* baseEvent(context)),
        type: "runtime.warning",
        payload: {
          message: `Stopping discarded your queued message. You can send it again:\n\n${discarded.text}`,
        },
      });
    }
    // Every DISCARDED deferred turn needs its own terminal settle: it was
    // announced through session.activeTurnId at queue time, but the remote
    // never picked it up, so neither the mapper nor the reconcile below will
    // ever settle it — without this a stop pressed while ONLY a queued steer
    // exists leaves the session running on a turn that no longer exists.
    const settleDiscarded = Effect.gen(function* () {
      for (const discarded of deferred) {
        yield* emit({
          ...(yield* baseEvent(context)),
          eventId: EventId.make(`aether:${taskId}:turn:${discarded.wireTurnId}:settled`),
          turnId: discarded.turnId,
          type: "turn.completed",
          payload: { state: "interrupted" },
        });
        yield* onTurnSettled(context, discarded.turnId);
      }
    });

    // Read-side confirmation: settle the ACTIVE turn ONLY once the task row
    // has actually left processing — never optimistically on the 200, because
    // an unconfirmed stop may still be running remotely.
    const confirmInterrupt = Effect.gen(function* () {
      let confirmed: AetherTask | undefined;
      for (let attempt = 1; attempt <= turnTiming.interruptMaxAttempts; attempt++) {
        const task = yield* restClient
          .getTask(taskId)
          .pipe(Effect.mapError(toRestRequestError("interruptTurn")));
        if (task.status !== "processing" && task.status !== "queued") {
          confirmed = task;
          break;
        }
        yield* Effect.sleep(Duration.millis(turnTiming.interruptPollMs));
      }
      if (confirmed === undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "interruptTurn",
          detail: `Aether task '${taskId}' is still processing after the stop request; the interrupt could not be confirmed.`,
        });
      }
      // Settle through the standard pipeline: mirror sync runs, the mapper's
      // interrupt flag turns the settle into state=interrupted, and if the
      // live path already settled the turn this emits nothing extra.
      if (context.mapper !== undefined) {
        yield* processMapperEvents(context, context.mapper.reconcileTask(confirmed, yield* nowIso));
      }
    });

    // The deferred turns were discarded by the STOP, which already succeeded —
    // their settle is owed from that moment, not from the confirmation. A
    // transient getTask failure (or an exhausted confirm budget) must not
    // strand them: nothing else will ever settle a turn the remote dropped
    // before picking it up, so the thread would show it running forever.
    yield* confirmInterrupt.pipe(Effect.onError(() => settleDiscarded));
    yield* settleDiscarded;
    // The session must not stay wedged on a turn the remote no longer runs.
    if (context.activeTurn !== undefined && context.activeTurn.turnId === active?.turnId) {
      yield* onTurnSettled(context, active.turnId);
    }
  });

  // -- questions (build item 9) ----------------------------------------------

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] =
    Effect.fn("respondToUserInput")(function* (threadId, requestId, answers) {
      const context = yield* ensureContext(threadId);
      const restClient = yield* requireRestClient("respondToUserInput");
      const requestKey = String(requestId);
      const pending = context.mapper?.openUserInput();
      // The exact substring `unknown pending user-input request` is t3's
      // stale-request trigger (ProviderCommandReactor / decider render it as
      // "Stale pending user-input request … restart the turn").
      if (
        context.taskId === undefined ||
        pending === undefined ||
        pending.pendingId !== requestKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `Aether driver: unknown pending user-input request '${requestKey}'. The question may have been answered from the Aether app or superseded; the transcript catches up on the next sync.`,
        });
      }
      if (pending.toolName !== "ask_user") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `Pending input '${requestKey}' is a proposed plan, not a question. Send a message to accept the plan, or a plan-mode follow-up to keep planning.`,
        });
      }
      const taskId = context.taskId;
      const built = buildAskUserToolResponse(pending.questions, answers);
      if ("issue" in built) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: built.issue,
        });
      }
      const clientMessageId = deterministicClientMessageId({
        taskId,
        sessionEpoch: context.session.createdAt,
        sendOrdinal: context.sentCount,
      });
      // Registered BEFORE the call (see sendTurn): the answer row can hit
      // the wire before the 202 lands here.
      context.issuedClientMessageIds.add(clientMessageId);
      const responded = yield* restClient
        .respondToTask(taskId, {
          // The transcript row: the raw response JSON, exactly like Aether's
          // own composer (packages/conversation toolResponseRequestBody).
          // @effect-diagnostics-next-line preferSchemaOverJson:off - mirrors aether-web's wire-exact transcript row, not a schema decode.
          message: JSON.stringify(built.data),
          tool_response: { tool_name: "ask_user", data: built.data },
          client_message_id: clientMessageId,
        })
        .pipe(
          Effect.catch((cause) =>
            cause._tag === "AetherApiConflictError"
              ? // 409: already answered / wrong pending kind. Re-sync the
                // durable feed FIRST so the stale panel resolves before any
                // retry (best-effort — the reconcile swallows its own
                // transient failures), then fail with a detail that CARRIES
                // the exact `unknown pending user-input request` substring:
                // spec §2.4 mandates it for the 409 path, and t3's
                // stale-request machinery (ProviderCommandReactor, decider,
                // ProjectionPipeline) classifies the failure only by that
                // substring. The decoded body's message rides along.
                (context.reconcile ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "respondToUserInput",
                        detail: `Aether driver: unknown pending user-input request '${requestKey}' — Aether rejected the answer (409): ${cause.detail}`,
                        cause,
                      }),
                    ),
                  ),
                )
              : Effect.fail(toRestRequestError("respondToUserInput")(cause)),
          ),
        );
      context.sentCount++;
      context.adoptActiveTurn = false;
      // Resolve the panel BEFORE announcing the resumed turn.
      if (context.mapper !== undefined) {
        yield* processMapperEvents(
          context,
          context.mapper.noteInputResolved(requestKey, answers, yield* nowIso),
        );
      }
      yield* activateRespondedTurn(context, restClient, taskId, responded.message_id);
    });

  // Cloud terminal: an interactive shell inside the task's VM, over its own
  // tab-scoped workspace socket (independent of the turn engine's stream).
  // Present only for a keyed instance — a keyless one fails loudly at the
  // router instead of silently offering a broken shell. Captured into consts
  // so the presence check narrows inside the closure.
  const terminalRestClient = options.restClient;
  const terminalSocket = options.socket;
  const toCloudTerminalConnectError = (
    error: AetherTerminalConnectError,
  ): CloudTerminalConnectError =>
    error._tag === "AetherTerminalWorkspaceUnavailableError"
      ? new CloudTerminalUnavailableError({ reason: error.reason })
      : new CloudTerminalTransportError({
          detail: "workspace terminal connect failed",
          cause: error,
        });
  const cloudTerminal: CloudTerminalConnector | undefined =
    terminalRestClient !== undefined && terminalSocket !== undefined
      ? {
          openConnection: (input) =>
            openAetherTerminalConnection({
              restClient: terminalRestClient,
              apiBaseUrl: terminalSocket.apiBaseUrl,
              apiKey: terminalSocket.apiKey,
              taskId: input.taskId,
              sessionId: input.sessionId,
              cols: input.cols,
              rows: input.rows,
              onOutput: input.onOutput,
              onClosed: input.onClosed,
            }).pipe(Effect.mapError(toCloudTerminalConnectError)),
        }
      : undefined;

  return {
    provider: PROVIDER,
    ...(cloudTerminal ? { cloudTerminal } : {}),
    capabilities: {
      // "in-session", not restart-based: `PUT /tasks/{id}` replaces the
      // task's settings in place (apitypes/tasks.go UpdateTaskRequest), so a
      // mid-thread model pick lands on the SAME cloud conversation. The
      // restart path (`unsupported` + requiresNewThreadForModelChange) would
      // lie here — a restarted session rebinds the same taskId anyway, and
      // the reactor would silently pin the previous model for turns sent
      // without an explicit selection.
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    // Aether surfaces no command/file approvals to clients — tools are
    // auto-approved remotely inside the VM (tool_response is only
    // ask_user | propose_plan). No request.opened is ever emitted, so this
    // is unreachable; if it fires anyway, say what actually happens.
    respondToRequest: (_threadId, requestId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Aether cloud tasks run with full workspace access and auto-approve tool use remotely; there is no approval request '${String(requestId)}' to answer.`,
        }),
      ),
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread,
    // v1 refusal (spec §2.2 revert row): the WS `git restore` verb exists,
    // but reverting also truncates the remote conversation and moves the
    // VM's tree — wiring that safely is the revert slice. Refuse loudly with
    // the actionable alternative instead of a silent no-op.
    rollbackThread: (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: `Reverting turns is not supported for Aether cloud sessions yet (thread '${String(threadId)}'): the local checkout is a one-way mirror of the cloud workspace. Revert the task from the Aether app; the next turn's sync re-baselines the local checkout.`,
        }),
      ),
    // Pure disconnect for every session; remote tasks are untouched. Each
    // thread gets the same scope-closing teardown and graceful session.exited
    // stopSession emits — ingestion clears per-session state from that event.
    stopAll: () =>
      Effect.gen(function* () {
        // The copy is load-bearing: disconnectSession deletes from the map
        // mid-iteration (Array.from over a spread per unicorn/no-useless-spread).
        for (const [threadId, context] of Array.from(sessions.entries())) {
          yield* disconnectSession(threadId, context);
        }
      }),
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});

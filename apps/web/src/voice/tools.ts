import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isProviderAvailable,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RuntimeMode,
  ThreadId,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ProjectId,
  type RunId,
  type ServerConfig,
  type ServerProvider,
  type VoiceContinueThreadInput,
  type VoiceDiscoverEnvironmentsOutput,
  type VoiceDiscoverProjectsInput,
  type VoiceDiscoverProjectsOutput,
  type VoiceEnvironmentOutcome,
  type VoiceListControlsInput,
  type VoiceListControlsOutput,
  type VoiceClickControlInput,
  type VoiceClickControlOutput,
  type VoiceListModelsInput,
  type VoiceListModelsOutput,
  type VoiceModelOption,
  type VoiceObserveThreadInput,
  type VoiceObserveThreadOutput,
  type VoiceOpenThreadInput,
  type VoiceOpenThreadOutput,
  type VoiceProviderSummary,
  type VoiceReadProjectInput,
  type VoiceReadProjectOutput,
  type VoiceReadThreadInput,
  type VoiceReadThreadOutput,
  type VoiceSearchThreadsInput,
  type VoiceSearchThreadsOutput,
  type VoiceRequestId,
  type VoiceStartThreadInput,
  type VoiceStartThreadOutput,
  type VoiceThreadExcerpt,
  type VoiceThreadRunReadout,
  type VoiceThreadRunStatus,
  type VoiceThreadSearchMatch,
  type VoiceThreadTurnExcerpt,
  type VoiceToolError,
  type VoiceToolErrorCode,
  type EnvironmentConnectionState,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  executeAtomQuery,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { fetchEnvironmentShellSnapshot } from "@t3tools/client-runtime/state/shell";
import { fetchEnvironmentThreadSnapshot } from "@t3tools/client-runtime/state/threads";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/unstable/http";
import { AsyncResult } from "effect/unstable/reactivity";

import { normalizeSearchText } from "../lib/utils";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { runtime as webRuntime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentSession, readPreparedConnection } from "../state/session";
import { serverEnvironment } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { buildThreadRouteParams } from "../threadRoutes";
import { createDomVoiceControlHost } from "./ui/domControls";

// ---------------------------------------------------------------------------
// Constants (frozen contract bounds)
// ---------------------------------------------------------------------------

/** At most four distinctive terms per query by default (frozen search contract). */
const MAX_SEARCH_TERMS = 4;
const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 200;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;
const DEFAULT_SEARCH_LIMIT_PER_ENVIRONMENT = 20;
const MAX_SERVER_SEARCH_LIMIT = 50;
const DEFAULT_READ_THREAD_TURNS = 10;
const MAX_READ_THREAD_TURNS = 50;
const DEFAULT_READ_PROJECT_THREADS = 10;
const MAX_READ_PROJECT_THREADS = 50;
const MAX_TURN_TEXT_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Host boundary (the prepared-connection seam every test mocks)
// ---------------------------------------------------------------------------

/** One environment's slice of the client-local catalog. Computed by the host
    from the connection registry, the primary-environment atom, the
    per-environment session state (granted scopes), and the environment
    descriptor's capabilities. Never a network call. */
export interface VoiceEnvironmentCatalogEntry {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: EnvironmentConnectionState;
  readonly isPrimary: boolean;
  readonly voiceLiveCapable: boolean;
  readonly scopes: readonly string[];
}

/** Authenticated read access to one environment through its prepared
    connection. Every method may reject; rejections are classified into frozen
    VoiceToolError codes by `classifyEnvironmentFailure`. Implementations never
    include credentials in results or error messages. */
export interface VoiceEnvironmentAccess {
  /** Active and archived thread shells plus projects (V2 shell snapshot). */
  readonly shellSnapshot: () => Promise<OrchestrationV2ShellSnapshot>;
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Promise<OrchestrationSearchThreadsResult>;
  /** Bounded thread detail read over the environment's authenticated HTTP
      API (`GET /api/orchestration/threads/:threadId`). The V2 snapshot carries
      the full control-plane projection with a bounded timeline window. */
  readonly threadSnapshot: (threadId: ThreadId) => Promise<OrchestrationV2ThreadDetailSnapshot>;
  /** Current ServerProvider catalog (WS serverGetConfig/subscribeServerConfig
      delivery, read scope). */
  readonly serverConfig: () => Promise<ServerConfig>;
  /** First item of a V2 thread subscription. Without `afterSequence` the
      server sends the (possibly windowed) snapshot frame first; with it, the
      first replayed event, a fallback snapshot, or the synchronization
      marker. */
  readonly subscribeThread: (
    input: OrchestrationV2SubscribeThreadInput,
  ) => Promise<OrchestrationV2ThreadStreamItem>;
  /** V2 orchestration command dispatch over the environment's WebSocket
      (`orchestration.dispatchCommand`, operate scope). Optional so older
      boundary fixtures remain valid; `continueThread` refuses to send a
      follow-up when a host cannot supply it. */
  readonly dispatchCommand?: (
    command: OrchestrationV2Command,
  ) => Promise<{ readonly sequence: number }>;
  /** V2 thread launch over the environment's WebSocket
      (`orchestration.launchThread`, operate scope). Optional for the same
      reason; `startThread` refuses creation when a host cannot supply it.
      Receipt-idempotent: replaying the same input (same commandId and
      threadId) returns the original outcome instead of creating a duplicate. */
  readonly launchThread?: (
    input: OrchestrationV2ThreadLaunchInput,
  ) => Promise<OrchestrationV2ThreadLaunchResult>;
  /** Branch listing for the environment's source control (`vcs.listRefs`,
      read scope). Optional for the same reason; the creation path needs it
      only to resolve a named worktree base branch. */
  readonly listRefs?: (cwd: string) => Promise<VcsListRefsResult>;
}

/** The client-local seam the voice tools execute against. The catalog read is
    synchronous and network-free; `openEnvironment` returns null when the
    environment has no prepared connection (disconnected/unprepared). */
export interface VoiceToolHost {
  readonly catalogEnvironments: () => ReadonlyArray<VoiceEnvironmentCatalogEntry>;
  readonly openEnvironment: (environmentId: EnvironmentId) => VoiceEnvironmentAccess | null;
  /** Enumeration and activation of the attached UI's visible controls.
      Client-local by design (the attached client owns UI execution, so remote
      sessions work); optional so environments whose client cannot see a UI
      get an explicit unsupported refusal instead of a fabricated list. */
  readonly uiControls?: VoiceUiControlHost;
}

/** Enumerates and activates the attached client's own interface controls
    (buttons, links, menu items, tabs, form controls) with stable,
    re-resolvable identities. Implementations report disabled, hidden, stale
    and ambiguous targets explicitly and never claim an activation that did
    not dispatch. */
export interface VoiceUiControlHost {
  readonly listControls: (input: VoiceListControlsInput) => Promise<VoiceListControlsOutput>;
  readonly clickControl: (input: VoiceClickControlInput) => Promise<VoiceClickControlOutput>;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Rejected by a voice tool as a whole (input validation, or a tool whose
    frozen output shape cannot represent the failure in-band). The voice
    adapter formats `error` for the model. */
export class VoiceToolFailureError extends Error {
  readonly error: VoiceToolError;

  constructor(error: VoiceToolError) {
    super(error.message);
    this.name = "VoiceToolFailureError";
    this.error = error;
  }
}

/** Error codes the prepared-connection boundary itself may raise. */
export type VoiceEnvironmentAccessErrorCode = Extract<
  VoiceToolErrorCode,
  | "insufficient_scope"
  | "auth_invalid"
  | "environment_unreachable"
  | "invalid_request"
  | "project_not_found"
  | "thread_not_found"
>;

/** Thrown by real hosts for conditions derived from local state that are not
    contract error classes. */
export class VoiceEnvironmentAccessError extends Error {
  readonly code: VoiceEnvironmentAccessErrorCode;

  constructor(code: VoiceEnvironmentAccessErrorCode, message: string) {
    super(message);
    this.name = "VoiceEnvironmentAccessError";
    this.code = code;
  }
}

const SERVER_ERROR_TAGS: ReadonlyMap<string, VoiceEnvironmentAccessErrorCode> = new Map([
  // HTTP 403 scope enforcement and the WS RPC authorization error.
  ["EnvironmentScopeRequiredError", "insufficient_scope"],
  ["EnvironmentAuthorizationError", "insufficient_scope"],
  // HTTP 401: credentials invalid, expired, or revoked.
  ["EnvironmentAuthInvalidError", "auth_invalid"],
  // HTTP 404 on a thread detail read.
  ["EnvironmentResourceNotFoundError", "thread_not_found"],
  ["EnvironmentRequestInvalidError", "invalid_request"],
]);

function causeMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  // Tagged error payloads decoded from the wire carry a message string
  // without being Error instances in every transport path.
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return String(cause);
}

/** Maps anything thrown across the prepared-connection boundary into a frozen
    VoiceToolError code. Unknown causes are treated as unreachable rather than
    fabricated into a more specific code. */
export function classifyEnvironmentFailure(cause: unknown): {
  code: VoiceToolErrorCode;
  message: string;
} {
  if (cause instanceof VoiceEnvironmentAccessError) {
    return { code: cause.code, message: cause.message };
  }
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? (cause as { _tag: unknown })._tag
      : undefined;
  const mapped = typeof tag === "string" ? SERVER_ERROR_TAGS.get(tag) : undefined;
  return mapped === undefined
    ? { code: "environment_unreachable", message: causeMessage(cause) }
    : { code: mapped, message: causeMessage(cause) };
}

function classifyEnvironmentFailureWithIds(
  cause: unknown,
  environmentId: EnvironmentId,
  threadId?: ThreadId,
): VoiceToolError {
  const failure = classifyEnvironmentFailure(cause);
  return {
    code: failure.code,
    message: failure.message,
    environmentId,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function okOutcome(environmentId: EnvironmentId): VoiceEnvironmentOutcome {
  return { environmentId, status: "ok" };
}

function failedOutcome(
  environmentId: EnvironmentId,
  failure: { code: VoiceToolErrorCode; message: string },
): VoiceEnvironmentOutcome {
  return {
    environmentId,
    status: "error",
    error: { code: failure.code, message: failure.message, environmentId },
  };
}

function failedOutcomeWithThread(
  environmentId: EnvironmentId,
  failure: { code: VoiceToolErrorCode; message: string },
  threadId: ThreadId,
): VoiceEnvironmentOutcome {
  return {
    environmentId,
    status: "error",
    error: { code: failure.code, message: failure.message, environmentId, threadId },
  };
}

function disconnectedOutcome(entry: VoiceEnvironmentCatalogEntry): VoiceEnvironmentOutcome {
  return {
    environmentId: entry.environmentId,
    status: "disconnected",
    error: {
      code: "environment_unreachable",
      message: `Could not reach environment "${entry.label}" because it is not connected.`,
      environmentId: entry.environmentId,
    },
  };
}

function notInCatalogOutcome(environmentId: EnvironmentId): VoiceEnvironmentOutcome {
  return failedOutcome(environmentId, {
    code: "environment_not_in_catalog",
    message: `Environment "${environmentId}" is not in this client's connection catalog.`,
  });
}

// ---------------------------------------------------------------------------
// Search term splitting (R1: the server has no term splitting or ranking)
// ---------------------------------------------------------------------------

/** Splits a spoken query into distinctive terms for the per-term bounded
    server searches. Terms are deduplicated, must independently satisfy the
    server's 2-200 character bounds, are ordered most-distinctive-first
    (longer substrings are rarer), and are capped at four by default. A query
    whose every token is shorter than two characters falls back to the whole
    normalized query so it still produces exactly one valid server call. */
export function splitSearchTerms(query: string, maxTerms = MAX_SEARCH_TERMS): string[] {
  const normalized = normalizeSearchText(query);
  if (normalized.length === 0) {
    return [];
  }
  const terms = [...new Set(normalized.split(" "))].filter(
    (term) => term.length >= MIN_TERM_LENGTH && term.length <= MAX_TERM_LENGTH,
  );
  if (terms.length === 0) {
    return normalized.length >= MIN_QUERY_LENGTH && normalized.length <= MAX_QUERY_LENGTH
      ? [normalized]
      : [];
  }
  return terms.sort((left, right) => right.length - left.length).slice(0, Math.max(maxTerms, 1));
}

// ---------------------------------------------------------------------------
// Model availability (frozen ServerProvider gating; reused by T5 pre-dispatch)
// ---------------------------------------------------------------------------

export type VoiceModelAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** A model is available only under a provider with `enabled === true`,
    `availability` not `unavailable`, and the slug present in `models[]`.
    `unavailableReason` is surfaced when the provider carries one. Never
    hardcodes model slugs; everything comes from the environment's delivered
    ServerProvider snapshot. */
export function evaluateModelAvailability(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
  slug: string,
): VoiceModelAvailability {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  if (provider === undefined) {
    return {
      available: false,
      reason: `Provider instance "${instanceId}" is not configured on this environment.`,
    };
  }
  if (!provider.enabled) {
    return { available: false, reason: `Provider instance "${instanceId}" is disabled.` };
  }
  if (!isProviderAvailable(provider)) {
    return {
      available: false,
      reason:
        provider.unavailableReason ?? `Provider instance "${instanceId}" is currently unavailable.`,
    };
  }
  if (!provider.models.some((model) => model.slug === slug)) {
    return {
      available: false,
      reason: `Model "${slug}" is not offered by provider instance "${instanceId}".`,
    };
  }
  return { available: true };
}

// ---------------------------------------------------------------------------
// Creation path (T5): deterministic request identifiers
// ---------------------------------------------------------------------------

const VOICE_TITLE_MAX_LENGTH = 80;

/** Fixed UUIDv5 namespace scoping every voice-request derivation. Any 128-bit
    value works; this one is dedicated to the voice feature so derived ids
    cannot collide with other UUIDv5 uses. */
const VOICE_REQUEST_NAMESPACE = "5e8f3a2c-7b1d-4c6e-9a0f-2d3b4c5e6f70";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UUIDv5 (SHA-1, RFC 4122) over a name in the voice-request namespace.
    Deterministic across processes and restarts, so a replay derives the same
    identifiers without any persisted mapping state. */
async function uuidV5(namespace: string, name: string): Promise<string> {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const data = new Uint8Array(namespaceBytes.length + nameBytes.length);
  data.set(namespaceBytes);
  data.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  const out = digest.slice(0, 16);
  out[6] = (out[6]! & 0x0f) | 0x50;
  out[8] = (out[8]! & 0x3f) | 0x80;
  return bytesToUuid(out);
}

export interface VoiceRequestIdentifiers {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/** Derives the dispatch identifiers for one voice request. The same
    VoiceRequestId always yields the same triple, so a retry dispatches the
    same commandId and lands in the V2 engine's command-receipt idempotency
    path instead of creating a duplicate thread. This pure derivation is the
    persisted request mapping: it needs no durable client state to survive
    restarts. */
export async function deriveVoiceRequestIdentifiers(
  requestId: VoiceRequestId,
): Promise<VoiceRequestIdentifiers> {
  const [command, thread, message] = await Promise.all([
    uuidV5(VOICE_REQUEST_NAMESPACE, `${requestId}:command`),
    uuidV5(VOICE_REQUEST_NAMESPACE, `${requestId}:thread`),
    uuidV5(VOICE_REQUEST_NAMESPACE, `${requestId}:message`),
  ]);
  return {
    commandId: CommandId.make(command),
    threadId: ThreadId.make(thread),
    messageId: MessageId.make(message),
  };
}

function voiceThreadTitle(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length > VOICE_TITLE_MAX_LENGTH
    ? compact.slice(0, VOICE_TITLE_MAX_LENGTH)
    : compact;
}

/** Identity of one start request: destination, model, and task. A replay
    under the same requestId must match this fingerprint; a differing one is
    a changed destination and must travel under a new VoiceRequestId. */
function startDestinationFingerprint(input: VoiceStartThreadInput): string {
  return JSON.stringify([
    input.environmentId,
    input.projectId,
    input.modelSelection.instanceId,
    input.modelSelection.model,
    input.task,
    input.runtimeMode ?? null,
  ]);
}

/** A failed V2 launch reaches this client as an OrchestrationV2ThreadLaunchError;
    the server resolves the project before anything else, so a launch failure
    is surfaced as the frozen project_not_found code with the launch's
    identity fields. */
function classifyLaunchFailure(
  cause: unknown,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
): VoiceToolError {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? (cause as { _tag: unknown })._tag
      : undefined;
  if (tag === "OrchestrationV2ThreadLaunchError") {
    return {
      code: "project_not_found",
      message: causeMessage(cause),
      environmentId,
      projectId,
      threadId,
    };
  }
  return { ...classifyEnvironmentFailure(cause), environmentId, threadId };
}

const isRuntimeMode = Schema.is(RuntimeMode);

// ---------------------------------------------------------------------------
// V2 run-state projection helpers
// ---------------------------------------------------------------------------

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** V2 projections carry branded `Utc` timestamps; the frozen voice outputs
    carry ISO strings. */
function iso(value: DateTime.Utc): string {
  return DateTime.formatIso(value);
}

/** Run states that mean work is active on the thread (the V2 activity-run
    window). Everything else is terminal or absent. */
const ACTIVE_RUN_STATUSES = new Set<VoiceThreadRunStatus>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

function isActiveRunStatus(status: VoiceThreadRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

interface TurnAccumulator {
  runId: RunId | null;
  createdAt: string;
  userTexts: string[];
  assistantText: string | null;
}

/** Groups a thread's V2 messages into user-anchored turns: each turn carries
    the user prompt text (truncated at 2000 chars) and the turn's final
    assistant text (truncated at 2000 chars, null when the turn has no
    completed assistant message). On Orchestrator V2 a turn is a run, so
    turns are keyed by the messages' runId. System messages are skipped. */
export function projectThreadTurns(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): VoiceThreadTurnExcerpt[] {
  const turns: VoiceThreadTurnExcerpt[] = [];
  let current: TurnAccumulator | null = null;

  const flush = () => {
    if (current === null) {
      return;
    }
    turns.push({
      ...(current.runId !== null ? { runId: current.runId } : {}),
      createdAt: current.createdAt,
      userText: truncateText(current.userTexts.join("\n"), MAX_TURN_TEXT_LENGTH),
      assistantText:
        current.assistantText === null
          ? null
          : truncateText(current.assistantText, MAX_TURN_TEXT_LENGTH),
    });
    current = null;
  };

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "user") {
      // A turn boundary is any change of run identity, including a pending
      // message that does not carry a run id yet (null after an id).
      const startsNewTurn = current === null || message.runId !== current.runId;
      if (startsNewTurn) {
        flush();
        current = {
          runId: message.runId,
          createdAt: iso(message.createdAt),
          userTexts: [message.text],
          assistantText: null,
        };
      } else if (current !== null) {
        current.userTexts.push(message.text);
      }
    } else {
      if (current === null) {
        current = {
          runId: null,
          createdAt: iso(message.createdAt),
          userTexts: [],
          assistantText: null,
        };
      }
      current.assistantText = message.text;
    }
  }
  flush();
  return turns;
}

/** Read-out of a thread's worker state from its V2 projection. The latest
    active run's status is the live state; with no active run the latest run's
    terminal status is reported. A thread without runs is idle. */
function deriveRunReadout(projection: OrchestrationV2ThreadProjection): VoiceThreadRunReadout {
  const activeRun = projection.runs.findLast((run) => isActiveRunStatus(run.status));
  if (activeRun !== undefined) {
    return { status: activeRun.status, lastError: null };
  }
  const latestRun = projection.runs.at(-1);
  if (latestRun !== undefined) {
    return {
      status: latestRun.status,
      lastError:
        latestRun.status === "failed" ? deriveRunErrorMessage(projection, latestRun.id) : null,
    };
  }
  return { status: "idle", lastError: null };
}

/** Best-effort failure text for a failed run: the latest transport-safe
    provider failure recorded on an error turn item of that run. The
    projection alone carries no run-level error field, so a failed run without
    a recorded error item reports a null lastError. */
function deriveRunErrorMessage(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
): string | null {
  for (const item of projection.turnItems.toReversed()) {
    if (item.runId === runId && item.type === "error") {
      return item.failure.message;
    }
  }
  return null;
}

function projectThreadExcerpt(
  projection: OrchestrationV2ThreadProjection,
  truncated: boolean,
): VoiceThreadExcerpt {
  const thread = projection.thread;
  const readout = deriveRunReadout(projection);
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
    runStatus: readout.status,
    ...(readout.lastError !== null ? { runLastError: readout.lastError } : {}),
    turns: projectThreadTurns(projection.messages),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** A thread whose projection carries no active run has nothing running; the
    neutral state is reported rather than a status the server never sent. */
function isRunStatusRunning(status: VoiceThreadRunStatus): boolean {
  return isActiveRunStatus(status);
}

// ---------------------------------------------------------------------------
// Search union and ranking
// ---------------------------------------------------------------------------

interface MutableSearchMatch {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  threadTitle: string;
  source: "title" | "message";
  snippet?: string;
  messageCreatedAt?: string;
  updatedAt?: string;
  archived?: boolean;
  readonly matchedTerms: Set<string>;
  titleMatch: boolean;
}

function matchRecency(match: MutableSearchMatch): string {
  // ISO timestamps compare lexicographically; a missing timestamp sorts last.
  return match.updatedAt ?? match.messageCreatedAt ?? "";
}

function compareMatches(left: MutableSearchMatch, right: MutableSearchMatch): number {
  if (left.titleMatch !== right.titleMatch) {
    return left.titleMatch ? -1 : 1;
  }
  if (left.matchedTerms.size !== right.matchedTerms.size) {
    return right.matchedTerms.size - left.matchedTerms.size;
  }
  return matchRecency(right).localeCompare(matchRecency(left));
}

function mergeTitleMatchesFromShell(
  shell: OrchestrationV2ShellSnapshot,
  terms: string[],
  normalizedQuery: string,
  archivedOnly: boolean,
  matchesByThread: Map<ThreadId, MutableSearchMatch>,
): void {
  // The V2 shell snapshot separates its active and archived thread shelves.
  const shellThreads = archivedOnly ? shell.archivedThreads : shell.threads;
  for (const thread of shellThreads) {
    const title = normalizeSearchText(thread.title);
    const hitTerms = terms.filter((term) => title.includes(term));
    if (hitTerms.length === 0 && !title.includes(normalizedQuery)) {
      continue;
    }
    const existing = matchesByThread.get(thread.id);
    if (existing !== undefined) {
      // An active-shell match outranks an archived one for the same thread.
      if (archivedOnly) {
        continue;
      }
      existing.titleMatch = true;
      for (const term of hitTerms) {
        existing.matchedTerms.add(term);
      }
      continue;
    }
    matchesByThread.set(thread.id, {
      threadId: thread.id,
      projectId: thread.projectId,
      threadTitle: thread.title,
      source: "title",
      updatedAt: iso(thread.updatedAt),
      ...(archivedOnly ? { archived: true } : {}),
      matchedTerms: new Set(hitTerms),
      titleMatch: true,
    });
  }
}

function mergeMessageMatches(
  result: OrchestrationSearchThreadsResult,
  term: string,
  titleByThread: ReadonlyMap<ThreadId, string>,
  matchesByThread: Map<ThreadId, MutableSearchMatch>,
): void {
  for (const match of result.matches) {
    const existing = matchesByThread.get(match.threadId);
    if (existing !== undefined) {
      existing.matchedTerms.add(term);
      if (existing.snippet === undefined) {
        existing.source = "message";
        existing.snippet = match.snippet;
        if (match.messageCreatedAt !== null) {
          existing.messageCreatedAt = match.messageCreatedAt;
        }
      }
      continue;
    }
    matchesByThread.set(match.threadId, {
      threadId: match.threadId,
      projectId: match.projectId,
      // The shell snapshot is the title authority; message-only matches get
      // the title when it is known, empty otherwise (never fabricated).
      threadTitle: titleByThread.get(match.threadId) ?? "",
      source: "message",
      snippet: match.snippet,
      ...(match.messageCreatedAt !== null ? { messageCreatedAt: match.messageCreatedAt } : {}),
      matchedTerms: new Set([term]),
      titleMatch: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface VoiceToolExecutor {
  readonly discoverEnvironments: () => Promise<VoiceDiscoverEnvironmentsOutput>;
  readonly discoverProjects: (
    input: VoiceDiscoverProjectsInput,
  ) => Promise<VoiceDiscoverProjectsOutput>;
  readonly listModels: (input: VoiceListModelsInput) => Promise<VoiceListModelsOutput>;
  readonly searchThreads: (input: VoiceSearchThreadsInput) => Promise<VoiceSearchThreadsOutput>;
  readonly readThread: (input: VoiceReadThreadInput) => Promise<VoiceReadThreadOutput>;
  readonly readProject: (input: VoiceReadProjectInput) => Promise<VoiceReadProjectOutput>;
  readonly openThread: (input: VoiceOpenThreadInput) => Promise<VoiceOpenThreadOutput>;
  readonly startThread: (input: VoiceStartThreadInput) => Promise<VoiceStartThreadOutput>;
  readonly continueThread: (input: VoiceContinueThreadInput) => Promise<VoiceStartThreadOutput>;
  readonly observeThread: (input: VoiceObserveThreadInput) => Promise<VoiceObserveThreadOutput>;
  readonly listControls: (input: VoiceListControlsInput) => Promise<VoiceListControlsOutput>;
  readonly clickControl: (input: VoiceClickControlInput) => Promise<VoiceClickControlOutput>;
}

export function createVoiceToolExecutor(host: VoiceToolHost): VoiceToolExecutor {
  // Session-scoped record of completed start requests, keyed by
  // VoiceRequestId: replays short-circuit to the recorded outcome. The
  // identifiers themselves are derived deterministically and the V2 launch is
  // receipt-idempotent, so idempotency survives even when this in-memory
  // cache does not.
  const startRecords = new Map<
    VoiceRequestId,
    { destination: string; output: VoiceStartThreadOutput }
  >();

  function requireOpenEnvironment(environmentId: EnvironmentId): {
    entry: VoiceEnvironmentCatalogEntry;
    access: VoiceEnvironmentAccess;
  } {
    const entry = host.catalogEnvironments().find((e) => e.environmentId === environmentId);
    if (entry === undefined) {
      // Refused from the client catalog alone: no network call is made for a
      // fabricated environment id.
      throw new VoiceToolFailureError({
        code: "environment_not_in_catalog",
        message: `Environment "${environmentId}" is not in this client's connection catalog.`,
        environmentId,
      });
    }
    const access = host.openEnvironment(environmentId);
    if (access === null) {
      throw new VoiceToolFailureError({
        code: "environment_unreachable",
        message: `Could not reach environment "${entry.label}" because it is not connected.`,
        environmentId: entry.environmentId,
      });
    }
    return { entry, access };
  }

  return {
    async discoverEnvironments() {
      return {
        environments: host.catalogEnvironments().map((entry) => ({
          environmentId: entry.environmentId,
          label: entry.label,
          connectionState: entry.connectionState,
          isPrimary: entry.isPrimary,
          voiceLiveCapable: entry.voiceLiveCapable,
          scopes: [...entry.scopes],
        })),
      };
    },

    async discoverProjects(input) {
      const entry = host.catalogEnvironments().find((e) => e.environmentId === input.environmentId);
      if (entry === undefined) {
        return { environment: notInCatalogOutcome(input.environmentId), projects: [] };
      }
      const access = host.openEnvironment(input.environmentId);
      if (access === null) {
        return { environment: disconnectedOutcome(entry), projects: [] };
      }
      try {
        const shell = await access.shellSnapshot();
        return {
          environment: okOutcome(entry.environmentId),
          // `defaultThreadEnvMode` null/absent means "no explicit override";
          // the server applies its own t3.json/global fallback. Projected as
          // "local" here; T5 must treat this projection as no-override.
          projects: shell.projects.map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            defaultModelSelection: project.defaultModelSelection,
            defaultThreadEnvMode: project.defaultThreadEnvMode ?? "local",
          })),
        };
      } catch (cause) {
        return {
          environment: failedOutcome(entry.environmentId, classifyEnvironmentFailure(cause)),
          projects: [],
        };
      }
    },

    async listModels(input) {
      const entry = host.catalogEnvironments().find((e) => e.environmentId === input.environmentId);
      if (entry === undefined) {
        return { environment: notInCatalogOutcome(input.environmentId), providers: [] };
      }
      const access = host.openEnvironment(input.environmentId);
      if (access === null) {
        return { environment: disconnectedOutcome(entry), providers: [] };
      }
      try {
        const config = await access.serverConfig();
        const providers: VoiceProviderSummary[] = [];
        for (const provider of config.providers) {
          // Only enabled, not-unavailable providers are selectable options
          // (frozen VoiceListModelsOutput doc). Disabled/unavailable gating is
          // surfaced through evaluateModelAvailability, never fabricated here.
          if (!provider.enabled || !isProviderAvailable(provider)) {
            continue;
          }
          const models: VoiceModelOption[] = provider.models.map((model) => ({
            slug: model.slug,
            name: model.name,
            isCustom: model.isCustom,
            ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
          }));
          providers.push({
            instanceId: provider.instanceId,
            driver: provider.driver,
            enabled: provider.enabled,
            availability: provider.availability ?? "available",
            models,
          });
        }
        return { environment: okOutcome(entry.environmentId), providers };
      } catch (cause) {
        return {
          environment: failedOutcome(entry.environmentId, classifyEnvironmentFailure(cause)),
          providers: [],
        };
      }
    },

    async searchThreads(input) {
      const query = input.query.trim();
      if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
        throw new VoiceToolFailureError({
          code: "query_invalid",
          message: `Search query must be between ${MIN_QUERY_LENGTH} and ${MAX_QUERY_LENGTH} characters.`,
        });
      }
      const terms = splitSearchTerms(query);
      if (terms.length === 0) {
        throw new VoiceToolFailureError({
          code: "query_invalid",
          message: "Search query contains no usable search terms.",
        });
      }
      const normalizedQuery = normalizeSearchText(query);
      const includeArchived = input.includeArchived === true;
      const limitPerEnvironment = input.limitPerEnvironment ?? DEFAULT_SEARCH_LIMIT_PER_ENVIRONMENT;
      const serverLimit = Math.min(Math.max(limitPerEnvironment, 1), MAX_SERVER_SEARCH_LIMIT);

      const requestedIds =
        input.environmentIds === undefined
          ? host.catalogEnvironments().map((entry) => entry.environmentId)
          : [...new Set(input.environmentIds)];
      const entriesById = new Map(
        host.catalogEnvironments().map((entry) => [entry.environmentId, entry] as const),
      );

      return {
        perEnvironment: await Promise.all(
          requestedIds.map(async (environmentId) => {
            const entry = entriesById.get(environmentId);
            if (entry === undefined) {
              return { environment: notInCatalogOutcome(environmentId), matches: [] };
            }
            const access = host.openEnvironment(environmentId);
            if (access === null) {
              // A disconnected environment is never reported as "no matches".
              return { environment: disconnectedOutcome(entry), matches: [] };
            }

            const matchesByThread = new Map<ThreadId, MutableSearchMatch>();
            const titleByThread = new Map<ThreadId, string>();
            const errors: { code: VoiceToolErrorCode; message: string }[] = [];
            let attempted = 0;
            let succeeded = 0;

            const runStep = async (step: () => Promise<void>) => {
              attempted += 1;
              try {
                await step();
                succeeded += 1;
              } catch (cause) {
                errors.push(classifyEnvironmentFailure(cause));
              }
            };

            await runStep(async () => {
              const shell = await access.shellSnapshot();
              for (const thread of shell.threads) {
                titleByThread.set(thread.id, thread.title);
              }
              mergeTitleMatchesFromShell(shell, terms, normalizedQuery, false, matchesByThread);
              if (includeArchived) {
                mergeTitleMatchesFromShell(shell, terms, normalizedQuery, true, matchesByThread);
              }
            });

            await Promise.all(
              terms.map((term) =>
                runStep(async () => {
                  const result = await access.searchThreads({ query: term, limit: serverLimit });
                  mergeMessageMatches(result, term, titleByThread, matchesByThread);
                }),
              ),
            );

            const totalTerms = terms.length;
            const matches: VoiceThreadSearchMatch[] = [...matchesByThread.values()]
              .sort(compareMatches)
              .slice(0, Math.max(limitPerEnvironment, 0))
              .map((match) => ({
                threadId: match.threadId,
                projectId: match.projectId,
                threadTitle: match.threadTitle,
                source: match.source,
                ...(match.snippet !== undefined ? { snippet: match.snippet } : {}),
                ...(match.messageCreatedAt !== undefined
                  ? { messageCreatedAt: match.messageCreatedAt }
                  : {}),
                ...(match.updatedAt !== undefined ? { updatedAt: match.updatedAt } : {}),
                termCoverage: match.matchedTerms.size / totalTerms,
                ...(match.titleMatch ? { titleMatch: true } : {}),
                ...(match.archived ? { archived: true } : {}),
              }));

            const firstError = errors[0];
            const outcome: VoiceEnvironmentOutcome =
              firstError === undefined
                ? okOutcome(environmentId)
                : succeeded === 0
                  ? failedOutcome(environmentId, firstError)
                  : {
                      environmentId,
                      status: "partial",
                      error: {
                        code: firstError.code,
                        message: firstError.message,
                        environmentId,
                      },
                    };
            return { environment: outcome, matches };
          }),
        ),
      };
    },

    async readThread(input) {
      const entry = host.catalogEnvironments().find((e) => e.environmentId === input.environmentId);
      if (entry === undefined) {
        return { environment: notInCatalogOutcome(input.environmentId) };
      }
      const access = host.openEnvironment(input.environmentId);
      if (access === null) {
        return { environment: disconnectedOutcome(entry) };
      }
      const turnLimit = Math.min(
        Math.max(input.turnLimit ?? DEFAULT_READ_THREAD_TURNS, 1),
        MAX_READ_THREAD_TURNS,
      );
      try {
        const snapshot = await access.threadSnapshot(input.threadId);
        const allTurns = projectThreadTurns(snapshot.projection.messages);
        // The window keeps the most recent turns, in chronological order; the
        // V2 snapshot may itself be a bounded recent window (hasMoreHistory).
        const turns = allTurns.slice(-turnLimit);
        const truncated = snapshot.hasMoreHistory === true || allTurns.length > turnLimit;
        const readout = deriveRunReadout(snapshot.projection);
        return {
          environment: okOutcome(entry.environmentId),
          thread: {
            ...projectThreadExcerpt(snapshot.projection, truncated),
            turns,
            runStatus: readout.status,
            ...(readout.lastError !== null ? { runLastError: readout.lastError } : {}),
          },
        };
      } catch (cause) {
        return {
          environment: failedOutcomeWithThread(
            entry.environmentId,
            classifyEnvironmentFailure(cause),
            input.threadId,
          ),
        };
      }
    },

    async readProject(input) {
      const entry = host.catalogEnvironments().find((e) => e.environmentId === input.environmentId);
      if (entry === undefined) {
        return { environment: notInCatalogOutcome(input.environmentId), recentThreads: [] };
      }
      const access = host.openEnvironment(input.environmentId);
      if (access === null) {
        return { environment: disconnectedOutcome(entry), recentThreads: [] };
      }
      let shell: OrchestrationV2ShellSnapshot;
      try {
        shell = await access.shellSnapshot();
      } catch (cause) {
        return {
          environment: failedOutcome(entry.environmentId, classifyEnvironmentFailure(cause)),
          recentThreads: [],
        };
      }
      const project = shell.projects.find((candidate) => candidate.id === input.projectId);
      if (project === undefined) {
        // The shell snapshot is the authoritative read model; a project absent
        // from it does not exist for reads. Never fabricate a project.
        return {
          environment: failedOutcome(entry.environmentId, {
            code: "project_not_found",
            message: `Project "${input.projectId}" was not found in environment "${entry.label}".`,
          }),
          recentThreads: [],
        };
      }
      const threadLimit = Math.min(
        Math.max(input.threadLimit ?? DEFAULT_READ_PROJECT_THREADS, 0),
        MAX_READ_PROJECT_THREADS,
      );
      const recentThreads = shell.threads
        .filter((thread) => thread.projectId === input.projectId && thread.archivedAt === null)
        .sort(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )
        .slice(0, threadLimit)
        .map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          updatedAt: iso(thread.updatedAt),
          runStatus: thread.status,
        }));
      return {
        environment: okOutcome(entry.environmentId),
        project: {
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          defaultModelSelection: project.defaultModelSelection,
          defaultThreadEnvMode: project.defaultThreadEnvMode ?? "local",
        },
        recentThreads,
      };
    },

    async openThread(input) {
      const entry = host.catalogEnvironments().find((e) => e.environmentId === input.environmentId);
      if (entry === undefined) {
        return { environment: notInCatalogOutcome(input.environmentId), acknowledged: false };
      }
      const access = host.openEnvironment(input.environmentId);
      if (access === null) {
        return { environment: disconnectedOutcome(entry), acknowledged: false };
      }

      // Existence check: the shell snapshot first (cheap, already live), then
      // a bounded detail read. Router navigation and acknowledgment belong to
      // T4; this tool only validates and reports the destination.
      let shellFailure: { code: VoiceToolErrorCode; message: string } | null = null;
      let exists = false;
      try {
        const shell = await access.shellSnapshot();
        exists =
          shell.threads.some((thread) => thread.id === input.threadId) ||
          shell.archivedThreads.some((thread) => thread.id === input.threadId);
      } catch (cause) {
        shellFailure = classifyEnvironmentFailure(cause);
      }
      if (!exists) {
        try {
          const snapshot = await access.threadSnapshot(input.threadId);
          exists = snapshot.projection.thread.id === input.threadId;
        } catch (cause) {
          const failure = classifyEnvironmentFailure(cause);
          if (failure.code === "thread_not_found") {
            return {
              environment: failedOutcomeWithThread(
                entry.environmentId,
                {
                  code: "thread_not_found",
                  message: `Thread "${input.threadId}" was not found in environment "${entry.label}".`,
                },
                input.threadId,
              ),
              acknowledged: false,
            };
          }
          // Inconclusive: report the blocking failure instead of claiming the
          // thread exists or does not.
          return {
            environment: failedOutcome(entry.environmentId, shellFailure ?? failure),
            acknowledged: false,
          };
        }
      }
      return {
        environment: okOutcome(entry.environmentId),
        acknowledged: false,
        destination: buildThreadRouteParams({
          environmentId: input.environmentId,
          threadId: input.threadId,
        }),
      };
    },

    async continueThread(input) {
      const { entry, access } = requireOpenEnvironment(input.environmentId);
      const dispatch = access.dispatchCommand;
      if (!dispatch || !entry.scopes.includes("orchestration:operate")) {
        throw new VoiceToolFailureError({
          code: "invalid_request",
          message: "This environment does not permit sending a follow-up.",
        });
      }
      const task = input.task.trim();
      if (!task)
        throw new VoiceToolFailureError({
          code: "invalid_request",
          message: "Follow-up text is required.",
        });
      const destination = JSON.stringify(["continue", input.environmentId, input.threadId, task]);
      const previous = startRecords.get(input.requestId);
      if (previous) {
        if (previous.destination !== destination)
          throw new VoiceToolFailureError({
            code: "invalid_request",
            message: "Request id was already used for another task or destination.",
          });
        return previous.output;
      }
      // A failed read must propagate. This path never creates a replacement.
      const preDispatch = await access.threadSnapshot(input.threadId);
      const thread = preDispatch.projection.thread;
      if (
        thread.id !== input.threadId ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        !thread.modelSelection
      ) {
        throw new VoiceToolFailureError({
          code: "invalid_request",
          message: "The target thread is unavailable for a follow-up.",
        });
      }
      const config = await access.serverConfig();
      const availability = evaluateModelAvailability(
        config.providers,
        thread.modelSelection.instanceId,
        thread.modelSelection.model,
      );
      if (!availability.available)
        throw new VoiceToolFailureError({
          code: "model_unavailable",
          message: availability.reason,
        });
      const identifiers = await deriveVoiceRequestIdentifiers(input.requestId);

      // Delivery resolution mirrors the composer's auto mode: servers that
      // resolve command context server-side receive the intent and decide;
      // older projections resolve here against the thread's live runs and the
      // active provider session's turn capabilities.
      const serverResolvesCommandContext =
        config.environment.capabilities.serverResolvedCommandContext === true;
      let dispatchMode: Extract<
        OrchestrationV2Command,
        { type: "message.dispatch" }
      >["dispatchMode"];
      let deliveryIntent: "auto" | undefined;
      if (serverResolvesCommandContext) {
        dispatchMode = { type: "start_immediately" };
        deliveryIntent = "auto";
      } else {
        const activeRun = preDispatch.projection.runs.findLast((run) =>
          isActiveRunStatus(run.status),
        );
        if (activeRun === undefined) {
          dispatchMode = { type: "start_immediately" };
        } else {
          const activeProviderThread = preDispatch.projection.providerThreads.find(
            (providerThread) => providerThread.id === activeRun.providerThreadId,
          );
          const activeProviderSession =
            activeProviderThread?.providerSessionId == null
              ? undefined
              : preDispatch.projection.providerSessions.find(
                  (session) => session.id === activeProviderThread.providerSessionId,
                );
          const turnCapabilities = activeProviderSession?.capabilities.turns;
          dispatchMode =
            turnCapabilities?.supportsActiveSteering === true
              ? { type: "steer_active", targetRunId: activeRun.id }
              : turnCapabilities?.supportsQueuedMessages === true
                ? { type: "queue_after_active" }
                : turnCapabilities?.supportsSteeringByInterruptRestart === true
                  ? { type: "restart_active", targetRunId: activeRun.id }
                  : { type: "queue_after_active" };
        }
      }

      const result = await dispatch({
        type: "message.dispatch",
        commandId: identifiers.commandId,
        createdBy: "user",
        creationSource: "web",
        threadId: input.threadId,
        messageId: identifiers.messageId,
        text: task,
        attachments: [],
        ...(deliveryIntent !== undefined ? { deliveryIntent } : {}),
        dispatchMode,
      });
      const readback = await access.threadSnapshot(input.threadId);
      const output: VoiceStartThreadOutput = {
        requestId: input.requestId,
        environment: okOutcome(entry.environmentId),
        commandId: identifiers.commandId,
        threadId: input.threadId,
        messageId: identifiers.messageId,
        dispatchSequence: result.sequence,
        run: postDispatchRunReadout(
          preDispatch.projection.runs.at(-1)?.id,
          deriveRunReadout(preDispatch.projection),
          readback.projection.runs.at(-1)?.id,
          deriveRunReadout(readback.projection),
        ),
      };
      startRecords.set(input.requestId, { destination, output });
      return output;
    },

    async startThread(input) {
      const task = input.task.trim();
      if (task.length === 0) {
        throw new VoiceToolFailureError({
          code: "invalid_request",
          message: "Task text is required to start a thread.",
        });
      }
      // The frozen input types runtimeMode as a free trimmed string (spoken
      // override); an unknown literal would only fail server-side decode, so
      // refuse it before any dispatch.
      if (input.runtimeMode !== undefined && !isRuntimeMode(input.runtimeMode)) {
        throw new VoiceToolFailureError({
          code: "invalid_request",
          message: `"${input.runtimeMode}" is not a known runtime mode.`,
        });
      }
      const { entry, access } = requireOpenEnvironment(input.environmentId);
      const launch = access.launchThread;
      if (launch === undefined) {
        throw new VoiceToolFailureError({
          code: "environment_unreachable",
          message: `Environment "${entry.label}" does not expose thread launch to this client.`,
          environmentId: entry.environmentId,
        });
      }

      // Pre-dispatch model gate. The server does not validate models at
      // launch, so a disabled or unavailable provider instance and an unknown
      // slug must fail here, before any network write.
      let config: ServerConfig;
      try {
        config = await access.serverConfig();
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyEnvironmentFailureWithIds(cause, entry.environmentId),
        );
      }
      const availability = evaluateModelAvailability(
        config.providers,
        input.modelSelection.instanceId,
        input.modelSelection.model,
      );
      if (!availability.available) {
        throw new VoiceToolFailureError({
          code: "model_unavailable",
          message: availability.reason,
          environmentId: entry.environmentId,
          model: input.modelSelection.model,
        });
      }

      const identifiers = await deriveVoiceRequestIdentifiers(input.requestId);
      const destination = startDestinationFingerprint(input);
      const existing = startRecords.get(input.requestId);
      if (existing !== undefined && existing.destination !== destination) {
        throw new VoiceToolFailureError({
          code: "invalid_request",
          message:
            "Request id was already used for a different destination; a changed destination is a new request.",
          environmentId: entry.environmentId,
          threadId: identifiers.threadId,
        });
      }
      if (existing !== undefined && existing.output.environment.status === "ok") {
        // Replay short-circuit: same request id, same destination, recorded
        // outcome. No second dispatch, no duplicate thread.
        return existing.output;
      }

      // The project's env-mode preference comes from the shell snapshot. A
      // project absent from the snapshot still launches: a fabricated id
      // fails server-side at the project invariant and surfaces as
      // project_not_found, while a stale snapshot must not block a real new
      // project.
      let workspaceRoot: string | null = null;
      let preferWorktree = false;
      try {
        const shell = await access.shellSnapshot();
        const project = shell.projects.find((candidate) => candidate.id === input.projectId);
        if (project !== undefined) {
          workspaceRoot = project.workspaceRoot;
          preferWorktree = project.defaultThreadEnvMode === "worktree";
        }
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyEnvironmentFailureWithIds(cause, entry.environmentId),
        );
      }

      const title = input.title ?? voiceThreadTitle(task);
      // Runtime mode is never hardcoded to a literal here. The launch wire
      // schema requires the field, so the explicit value sent is the same
      // DEFAULT_RUNTIME_MODE constant the server's decode default applies.
      const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;

      // Worktree preference: only an explicit project default of "worktree"
      // prepares a worktree. The base branch must be a NAMED ref — never the
      // unnamed HEAD ref, which the server would record as the worktree's
      // gh-merge-base and which would then poison later merge-base and PR
      // base resolution. The current ref (matching the composer's current-
      // branch default) is preferred, then the environment's default ref.
      // Detached HEAD, a non-repo, or a boundary that cannot list refs is a
      // refusal with a clear error (the frozen contract's refuse alternative),
      // never a fallback to an unnamed ref.
      let workspaceStrategy: OrchestrationV2ThreadLaunchInput["workspaceStrategy"];
      if (preferWorktree && workspaceRoot !== null) {
        if (access.listRefs === undefined) {
          throw new VoiceToolFailureError({
            code: "invalid_request",
            message: `Project "${input.projectId}" prefers worktree threads, but this environment boundary cannot list refs to resolve a named base branch.`,
            environmentId: entry.environmentId,
            projectId: input.projectId,
          });
        }
        let refs: VcsListRefsResult;
        try {
          refs = await access.listRefs(workspaceRoot);
        } catch (cause) {
          throw new VoiceToolFailureError(
            classifyEnvironmentFailureWithIds(cause, entry.environmentId),
          );
        }
        const baseBranch =
          refs.refs.find((candidate) => candidate.current)?.name ??
          refs.refs.find((candidate) => candidate.isDefault)?.name ??
          null;
        if (baseBranch === null) {
          throw new VoiceToolFailureError({
            code: "invalid_request",
            message: `Project "${input.projectId}" prefers worktree threads, but no current or default branch exists in its workspace (detached HEAD or not a git repository); name a base branch to start work there.`,
            environmentId: entry.environmentId,
            projectId: input.projectId,
          });
        }
        workspaceStrategy = {
          type: "worktree",
          baseRef: baseBranch,
          branch: `voice-${identifiers.threadId}`,
          // Honor the environment's newWorktreesStartFromOrigin setting
          // (server decode default true), same semantics as the composer.
          ...(config.settings.newWorktreesStartFromOrigin === true
            ? { startFromOrigin: true }
            : {}),
        };
      } else {
        // A projected "local" (null/absent defaultThreadEnvMode) means no
        // explicit override; the voice path has no access to a server-side
        // t3.json env default on this base, so it launches the thread in the
        // project root.
        workspaceStrategy = { type: "root" };
      }

      // The launch is receipt-idempotent: replaying the same input (same
      // derived commandId and threadId) returns the original outcome instead
      // of creating a duplicate thread, and a previously rejected launch
      // replays its rejection. The launch receipt alone proves acceptance,
      // never execution.
      try {
        await launch({
          commandId: identifiers.commandId,
          creationSource: "web",
          threadId: identifiers.threadId,
          projectId: input.projectId,
          title,
          generateTitle: input.title === undefined,
          modelSelection: input.modelSelection,
          runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy,
          initialMessage: {
            messageId: identifiers.messageId,
            text: task,
            attachments: [],
          },
        });
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyLaunchFailure(cause, entry.environmentId, input.projectId, identifiers.threadId),
        );
      }

      // Read back what actually happened. The launch receipt proves
      // acceptance, never execution; the read-back reports the thread's
      // actual run state. A modelSelection mismatch means the environment did
      // not create what was asked, so the tool refuses to report success.
      let readback: OrchestrationV2ThreadDetailSnapshot;
      try {
        readback = await access.threadSnapshot(identifiers.threadId);
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyEnvironmentFailureWithIds(cause, entry.environmentId, identifiers.threadId),
        );
      }
      const createdSelection = readback.projection.thread.modelSelection;
      if (
        createdSelection === null ||
        createdSelection.instanceId !== input.modelSelection.instanceId ||
        createdSelection.model !== input.modelSelection.model
      ) {
        throw new VoiceToolFailureError({
          code: "invalid_request",
          message: `Thread reports model ${
            createdSelection === null
              ? "none"
              : `${createdSelection.instanceId}/${createdSelection.model}`
          } instead of the requested ${input.modelSelection.instanceId}/${input.modelSelection.model}.`,
          environmentId: entry.environmentId,
          threadId: identifiers.threadId,
          model: input.modelSelection.model,
        });
      }
      // A fresh thread whose first run is not projected yet still started:
      // the launch receipt accepted the initial message, so the honest
      // in-flight report is `starting`, never an unconfirmed `idle`.
      const readout = deriveRunReadout(readback.projection);
      const output: VoiceStartThreadOutput = {
        requestId: input.requestId,
        environment: okOutcome(entry.environmentId),
        commandId: identifiers.commandId,
        threadId: identifiers.threadId,
        messageId: identifiers.messageId,
        // A launch receipt carries no event sequence; observation resumes
        // from the thread's full replay instead.
        dispatchSequence: 0,
        run: readout.status === "idle" ? { status: "starting", lastError: null } : readout,
      };
      startRecords.set(input.requestId, { destination, output });
      return output;
    },

    async observeThread(input) {
      const { access } = requireOpenEnvironment(input.environmentId);
      const afterSequence = input.afterSequence;
      let item: OrchestrationV2ThreadStreamItem;
      try {
        item = await access.subscribeThread({
          threadId: input.threadId,
          ...(afterSequence !== undefined ? { afterSequence, requestCompletionMarker: true } : {}),
        });
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyEnvironmentFailureWithIds(cause, input.environmentId, input.threadId),
        );
      }

      const deriveFromProjection = (
        projection: OrchestrationV2ThreadProjection,
      ): {
        run: VoiceThreadRunReadout;
        runId?: RunId;
        running: boolean;
      } => {
        const readout = deriveRunReadout(projection);
        const activeRun = projection.runs.findLast((run) => isActiveRunStatus(run.status));
        const latestRun = projection.runs.at(-1);
        const runId = activeRun?.id ?? latestRun?.id;
        return {
          run: readout,
          ...(runId !== undefined ? { runId } : {}),
          running: isRunStatusRunning(readout.status),
        };
      };

      if (item.kind === "snapshot") {
        const derived = deriveFromProjection(item.projection);
        return {
          environment: okOutcome(input.environmentId),
          threadId: input.threadId,
          sequence: item.snapshotSequence,
          run: derived.run,
          ...(derived.runId !== undefined ? { runId: derived.runId } : {}),
          running: derived.running,
        };
      }

      // Replayed event or synchronization marker: run state comes from a
      // bounded detail read (single event payloads do not reliably carry the
      // full projection).
      let detail: OrchestrationV2ThreadDetailSnapshot;
      try {
        detail = await access.threadSnapshot(input.threadId);
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyEnvironmentFailureWithIds(cause, input.environmentId, input.threadId),
        );
      }
      const derived = deriveFromProjection(detail.projection);
      return {
        environment: okOutcome(input.environmentId),
        threadId: input.threadId,
        sequence:
          item.kind === "event" ? item.sequence : (afterSequence ?? detail.snapshotSequence),
        run: derived.run,
        ...(derived.runId !== undefined ? { runId: derived.runId } : {}),
        running: derived.running,
      };
    },

    async listControls(input) {
      const ui = host.uiControls;
      if (ui === undefined) {
        return {
          controls: [],
          error: {
            code: "invalid_request",
            message:
              "This client does not expose its interface controls, so none can be listed or activated here.",
          },
        };
      }
      return ui.listControls(input);
    },

    async clickControl(input) {
      const ui = host.uiControls;
      if (ui === undefined) {
        return {
          controlId: input.controlId,
          state: "unsupported",
          message:
            "This client does not expose its interface controls, so none can be listed or activated here.",
        };
      }
      return ui.clickControl(input);
    },
  };
}

/** Read-out of the run after a follow-up dispatch. A projection for the new
    run can only appear after the dispatch is recorded, so a read-back that
    still shows the pre-dispatch run, unchanged, describes the PREVIOUS run,
    not this one. Echoing its terminal state (or inherited error) would
    misreport a follow-up the dispatch receipt accepted and that is in fact
    starting; the honest in-flight `starting` is reported instead. Anything
    else is observed as-is: a new run (even one that already finished or
    repeated the same error), or the same run having progressed, as when a
    steered follow-up lands on the active run and it then completes. */
function postDispatchRunReadout(
  preDispatchLatestRunId: RunId | undefined,
  preDispatch: VoiceThreadRunReadout,
  readbackLatestRunId: RunId | undefined,
  readback: VoiceThreadRunReadout,
): VoiceThreadRunReadout {
  const describesPreviousRun =
    readbackLatestRunId === preDispatchLatestRunId &&
    readback.status === preDispatch.status &&
    readback.lastError === preDispatch.lastError &&
    !isRunStatusRunning(readback.status) &&
    readback.status !== "starting";
  if (describesPreviousRun) {
    return { status: "starting", lastError: null };
  }
  return readback;
}

// ---------------------------------------------------------------------------
// Real host: the web client's authenticated machinery
// ---------------------------------------------------------------------------

/** Reads the `voiceLive` capability flag off an environment descriptor. The
    flag is a version-skew optional key: absent means unsupported, so only an
    explicit `true` enables the Live broker path on that environment. */
function readVoiceLiveCapability(
  capabilities: ExecutionEnvironmentCapabilities | undefined,
): boolean {
  return capabilities?.voiceLive === true;
}

function supervisorPhaseToConnectionState(
  phase: "available" | "offline" | "connecting" | "backoff" | "connected" | "blocked",
): EnvironmentConnectionState {
  switch (phase) {
    case "connected":
      return "connected";
    case "connecting":
    case "backoff":
      return "connecting";
    case "blocked":
      return "error";
    case "available":
    case "offline":
      return "disconnected";
  }
}

function unwrapAtomResult<A>(result: AsyncResult.AsyncResult<A, unknown>): A {
  if (result._tag === "Success") {
    return result.value;
  }
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }
  throw new VoiceEnvironmentAccessError(
    "environment_unreachable",
    "Environment request did not produce a result.",
  );
}

/** First-item thread subscriptions for `observeThread`. Family inputs are
    distinct per (environmentId, input), so each observation mounts its own
    subscription that goes idle after the TTL. */
const threadStreamAtom = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "voice:thread-stream",
  tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  idleTtlMs: 65_000,
});

/** V2 orchestration command dispatch for the follow-up path. Same transport
    as every other client command: the environment's WebSocket
    `orchestration.dispatchCommand` (operate scope). */
const orchestrationDispatchCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice:orchestration-v2:dispatch-command",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});

/** V2 thread launch for the creation path, over the same environment
    WebSocket (`orchestration.launchThread`, operate scope). */
const orchestrationLaunchThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice:orchestration-v2:launch-thread",
  tag: ORCHESTRATION_V2_WS_METHODS.launchThread,
});

function createPreparedEnvironmentAccess(prepared: PreparedConnection): VoiceEnvironmentAccess {
  // Resolve the DPoP signer lazily and per call: only relay/DPoP connections
  // need one, so bearer and primary (cookie) connections work without it, and
  // a relay re-authentication picks up the current signer.
  const resolveSigner = () =>
    webRuntime.runPromise(Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner));
  const runEnvironmentHttp = <A>(
    effect: Effect.Effect<A, RemoteEnvironmentRequestError, HttpClient.HttpClient>,
  ): Promise<A> => webRuntime.runPromise(effect);

  return {
    shellSnapshot: async () => {
      const signer = await resolveSigner();
      return runEnvironmentHttp(fetchEnvironmentShellSnapshot({ prepared, signer }));
    },
    searchThreads: async (input) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        orchestrationEnvironment.threadSearch({
          environmentId: prepared.environmentId,
          input,
        }),
        { reportFailure: false, reportDefect: false },
      );
      return unwrapAtomResult(result);
    },
    threadSnapshot: async (threadId) => {
      const signer = await resolveSigner();
      return runEnvironmentHttp(
        fetchEnvironmentThreadSnapshot({
          prepared,
          threadId,
          signer,
        }),
      );
    },
    serverConfig: async () => {
      const config = appAtomRegistry.get(serverEnvironment.configValueAtom(prepared.environmentId));
      if (config === null) {
        throw new VoiceEnvironmentAccessError(
          "environment_unreachable",
          `Environment "${prepared.label}" has not delivered its server configuration yet.`,
        );
      }
      return config;
    },
    subscribeThread: async (input) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        threadStreamAtom({ environmentId: prepared.environmentId, input }),
        { reportFailure: false, reportDefect: false },
      );
      return unwrapAtomResult(result);
    },
    dispatchCommand: async (command) => {
      const result = await orchestrationDispatchCommand.run(appAtomRegistry, {
        environmentId: prepared.environmentId,
        input: command,
      });
      return unwrapAtomResult(result);
    },
    launchThread: async (input) => {
      const result = await orchestrationLaunchThread.run(appAtomRegistry, {
        environmentId: prepared.environmentId,
        input,
      });
      return unwrapAtomResult(result);
    },
    listRefs: async (cwd) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        vcsEnvironment.listRefs({ environmentId: prepared.environmentId, input: { cwd } }),
        { reportFailure: false, reportDefect: false },
      );
      return unwrapAtomResult(result);
    },
  };
}

/** The voice tool host wired to this web client's existing authenticated
    machinery: the connection registry catalog, per-environment prepared
    connections, the orchestration RPC atoms, and the environment HTTP loaders.
    Credentials stay in T3's existing handling; nothing here reads, logs, or
    forwards them. */
export function createWebVoiceToolHost(): VoiceToolHost {
  return {
    catalogEnvironments: () => {
      const primaryId = appAtomRegistry.get(primaryEnvironmentIdAtom);
      const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
      return [...catalog.entries.entries()].map(([environmentId, entry]) => {
        const supervisorState = Option.getOrElse(
          AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
          () => AVAILABLE_CONNECTION_STATE,
        );
        const sessionState = appAtomRegistry.get(
          environmentSession.sessionStateValueAtom(environmentId),
        );
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
        return {
          environmentId,
          label: entry.target.label,
          connectionState: supervisorPhaseToConnectionState(supervisorState.phase),
          isPrimary: environmentId === primaryId,
          voiceLiveCapable: readVoiceLiveCapability(config?.environment.capabilities),
          scopes: sessionState?.scopes ?? [],
        };
      });
    },

    openEnvironment: (environmentId) => {
      const prepared = readPreparedConnection(environmentId);
      if (prepared === null) {
        return null;
      }
      return createPreparedEnvironmentAccess(prepared);
    },

    // UI control execution stays in this attached client: enumeration and
    // activation read and click the live document of the window the voice
    // session runs in, so remote sessions operate the real UI.
    uiControls: createDomVoiceControlHost(),
  };
}

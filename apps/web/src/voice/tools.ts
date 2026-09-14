import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isProviderAvailable,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  RuntimeMode,
  ThreadId,
  type ClientOrchestrationCommand,
  type DispatchResult,
  type EnvironmentConnectionState,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type OrchestrationMessage,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationSessionStatus,
  type OrchestrationShellSnapshot,
  type OrchestrationSubscribeThreadInput,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ProjectId,
  type ServerConfig,
  type ServerProvider,
  type TurnId,
  type VcsListRefsResult,
  type VoiceDiscoverEnvironmentsOutput,
  type VoiceDiscoverProjectsInput,
  type VoiceDiscoverProjectsOutput,
  type VoiceEnvironmentOutcome,
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
  type VoiceContinueThreadInput,
  type VoiceStartThreadOutput,
  type VoiceThreadExcerpt,
  type VoiceThreadSearchMatch,
  type VoiceThreadTurnExcerpt,
  type VoiceToolError,
  type VoiceToolErrorCode,
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

// ---------------------------------------------------------------------------
// Constants (frozen contract bounds)
// ---------------------------------------------------------------------------

/** At most four distinctive terms per query by default (frozen search contract). */
export const MAX_SEARCH_TERMS = 4;
export const MIN_TERM_LENGTH = 2;
export const MAX_TERM_LENGTH = 200;
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 200;
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
  /** Active (non-archived) projects and thread shells. */
  readonly shellSnapshot: () => Promise<OrchestrationShellSnapshot>;
  /** Archived thread shells. There is no archived message-search endpoint on
      this base, so archived results are title-only by construction. */
  readonly archivedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Promise<OrchestrationSearchThreadsResult>;
  /** Bounded thread detail read over the environment's authenticated HTTP
      API (`GET /api/orchestration/threads/:threadId`). */
  readonly threadSnapshot: (
    threadId: ThreadId,
    window?: { readonly turnLimit?: number },
  ) => Promise<OrchestrationThreadDetailSnapshot>;
  /** Current ServerProvider catalog (WS serverGetConfig/subscribeServerConfig
      delivery, read scope). */
  readonly serverConfig: () => Promise<ServerConfig>;
  /** First item of a thread subscription. Without `afterSequence` the server
      sends the (possibly windowed) snapshot frame first; with it, the first
      replayed event, a fallback snapshot, or the completion marker. */
  readonly subscribeThread: (
    input: OrchestrationSubscribeThreadInput,
  ) => Promise<OrchestrationThreadStreamItem>;
  /** Orchestration command dispatch over the environment's WebSocket
      (`orchestration.dispatchCommand`, operate scope). Optional so older
      boundary fixtures remain valid; `startThread` refuses creation when a
      host cannot supply it. */
  readonly dispatchCommand?: (command: ClientOrchestrationCommand) => Promise<DispatchResult>;
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
    same commandId and lands in the server's command-id idempotency path
    (OrchestrationEngine receipt replay) instead of creating a duplicate
    thread. This pure derivation is the persisted request mapping: it needs no
    durable client state to survive restarts. */
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

/** Dispatch failures reach this client as generic
    OrchestrationDispatchCommandError messages; the server's requireProject
    invariant carries the refused project id in that message, so it is
    surfaced as the frozen project_not_found code. */
function classifyDispatchFailure(
  cause: unknown,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
): VoiceToolError {
  const failure = classifyEnvironmentFailure(cause);
  if (
    failure.code === "environment_unreachable" &&
    failure.message.includes(`'${projectId}'`) &&
    failure.message.includes("does not exist")
  ) {
    return {
      code: "project_not_found",
      message: failure.message,
      environmentId,
      projectId,
      threadId,
    };
  }
  return { ...failure, environmentId, threadId };
}

const isRuntimeMode = Schema.is(RuntimeMode);

// ---------------------------------------------------------------------------
// Thread projection helpers
// ---------------------------------------------------------------------------

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

interface TurnAccumulator {
  turnId: TurnId | null;
  createdAt: string;
  userTexts: string[];
  assistantText: string | null;
}

/** Groups a thread's messages into user-anchored turns: each turn carries the
    user prompt text (truncated at 2000 chars) and the turn's final assistant
    text (truncated at 2000 chars, null when the turn has no completed
    assistant message). System messages are skipped. */
export function projectThreadTurns(
  messages: ReadonlyArray<OrchestrationMessage>,
): VoiceThreadTurnExcerpt[] {
  const turns: VoiceThreadTurnExcerpt[] = [];
  let current: TurnAccumulator | null = null;

  const flush = () => {
    if (current === null) {
      return;
    }
    turns.push({
      ...(current.turnId !== null ? { turnId: current.turnId } : {}),
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
      // A turn boundary is any change of turn identity, including a pending
      // message that does not carry a turn id yet (null after an id).
      const startsNewTurn = current === null || message.turnId !== current.turnId;
      if (startsNewTurn) {
        flush();
        current = {
          turnId: message.turnId,
          createdAt: message.createdAt,
          userTexts: [message.text],
          assistantText: null,
        };
      } else if (current !== null) {
        current.userTexts.push(message.text);
      }
    } else {
      if (current === null) {
        current = {
          turnId: null,
          createdAt: message.createdAt,
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

function projectThreadExcerpt(thread: OrchestrationThread, truncated: boolean): VoiceThreadExcerpt {
  const session = thread.session;
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(session !== null
      ? {
          sessionStatus: session.status,
          ...(session.lastError !== null ? { sessionLastError: session.lastError } : {}),
        }
      : {}),
    turns: projectThreadTurns(thread.messages),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** A thread without a live session has nothing running; the neutral session
    state is reported rather than a status the server never sent. */
function sessionReadout(thread: OrchestrationThread): {
  status: OrchestrationSessionStatus;
  lastError: string | null;
} {
  const session = thread.session;
  return session === null
    ? { status: "idle", lastError: null }
    : { status: session.status, lastError: session.lastError };
}

function isSessionRunning(status: OrchestrationSessionStatus): boolean {
  return status === "starting" || status === "running";
}

function detailSequence(snapshot: OrchestrationThreadDetailSnapshot): number {
  // Per-thread watermark when present (windowed reads); otherwise the global
  // snapshot sequence is the best available anchor.
  return snapshot.page?.threadSequence ?? snapshot.snapshotSequence;
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
  shell: OrchestrationShellSnapshot,
  terms: string[],
  normalizedQuery: string,
  archivedOnly: boolean,
  matchesByThread: Map<ThreadId, MutableSearchMatch>,
): void {
  for (const thread of shell.threads) {
    const isArchived = thread.archivedAt !== null;
    if (archivedOnly !== isArchived) {
      continue;
    }
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
      updatedAt: thread.updatedAt,
      ...(isArchived ? { archived: true } : {}),
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
}

export function createVoiceToolExecutor(host: VoiceToolHost): VoiceToolExecutor {
  // Session-scoped record of completed start requests, keyed by
  // VoiceRequestId: replays short-circuit to the recorded outcome. The
  // identifiers themselves are derived deterministically, so idempotency
  // survives even when this in-memory cache does not.
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
                if (thread.archivedAt === null) {
                  titleByThread.set(thread.id, thread.title);
                }
              }
              mergeTitleMatchesFromShell(shell, terms, normalizedQuery, false, matchesByThread);
            });

            await Promise.all(
              terms.map((term) =>
                runStep(async () => {
                  const result = await access.searchThreads({ query: term, limit: serverLimit });
                  mergeMessageMatches(result, term, titleByThread, matchesByThread);
                }),
              ),
            );

            if (includeArchived) {
              await runStep(async () => {
                const archived = await access.archivedShellSnapshot();
                mergeTitleMatchesFromShell(archived, terms, normalizedQuery, true, matchesByThread);
              });
            }

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
        const snapshot = await access.threadSnapshot(input.threadId, { turnLimit });
        return {
          environment: okOutcome(entry.environmentId),
          thread: projectThreadExcerpt(snapshot.thread, snapshot.page?.hasMore === true),
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
      let shell: OrchestrationShellSnapshot;
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
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, threadLimit)
        .map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          updatedAt: thread.updatedAt,
          ...(thread.session !== null ? { sessionStatus: thread.session.status } : {}),
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
        exists = shell.threads.some((thread) => thread.id === input.threadId);
      } catch (cause) {
        shellFailure = classifyEnvironmentFailure(cause);
      }
      if (!exists) {
        try {
          const snapshot = await access.threadSnapshot(input.threadId, { turnLimit: 1 });
          exists = snapshot.thread.id === input.threadId;
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
      const { thread } = await access.threadSnapshot(input.threadId, { turnLimit: 1 });
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
      const result = await dispatch({
        type: "thread.turn.start",
        commandId: identifiers.commandId,
        threadId: input.threadId,
        message: { messageId: identifiers.messageId, role: "user", text: task, attachments: [] },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString(),
      });
      const readback = await access.threadSnapshot(input.threadId, { turnLimit: 1 });
      const output: VoiceStartThreadOutput = {
        requestId: input.requestId,
        environment: okOutcome(entry.environmentId),
        commandId: identifiers.commandId,
        threadId: input.threadId,
        messageId: identifiers.messageId,
        dispatchSequence: result.sequence,
        session: sessionReadout(readback.thread),
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
      const dispatch = access.dispatchCommand;
      if (dispatch === undefined) {
        throw new VoiceToolFailureError({
          code: "environment_unreachable",
          message: `Environment "${entry.label}" does not expose command dispatch to this client.`,
          environmentId: entry.environmentId,
        });
      }

      // Pre-dispatch model gate. The server does not validate models at
      // dispatch (REVIEW-1), so a disabled or unavailable provider instance
      // and an unknown slug must fail here, before any network write.
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
      // project absent from the snapshot still dispatches: a fabricated id
      // fails server-side at the requireProject invariant and surfaces as
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

      // Existence probe decides the bootstrap shape. A replay whose thread
      // already exists must dispatch WITHOUT bootstrap: the bare turn.start
      // carries the original commandId into the engine's receipt replay and
      // returns the original sequence, whereas a repeated bootstrap would
      // fail on the inner thread-create invariant.
      let threadExists = false;
      try {
        const snapshot = await access.threadSnapshot(identifiers.threadId, { turnLimit: 1 });
        threadExists = snapshot.thread.id === identifiers.threadId;
      } catch (cause) {
        const failure = classifyEnvironmentFailure(cause);
        if (failure.code !== "thread_not_found") {
          throw new VoiceToolFailureError({
            ...failure,
            environmentId: entry.environmentId,
            threadId: identifiers.threadId,
          });
        }
      }

      const title = input.title ?? voiceThreadTitle(task);
      // Runtime mode is never hardcoded to a literal here. The dispatch wire
      // schema requires the field (the server-side decode default only exists
      // on the post-dispatch command union), so the explicit value sent is
      // the same DEFAULT_RUNTIME_MODE constant the server's decode default
      // applies — omitting the field is rejected by the wire schema.
      const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
      const createdAt = new Date().toISOString();

      // Worktree preference: only an explicit project default of "worktree"
      // prepares a worktree. The base branch must be a NAMED ref — never the
      // unnamed HEAD ref, which the server would record as the worktree's
      // gh-merge-base and which would then poison later merge-base and PR
      // base resolution. The current ref (matching the composer's current-
      // branch default) is preferred, then the environment's default ref.
      // Detached HEAD, a non-repo, or a boundary that cannot list refs is a
      // refusal with a clear error (the frozen contract's refuse alternative),
      // never a fallback to an unnamed ref.
      let worktreeBootstrap:
        | {
            prepareWorktree: {
              projectCwd: string;
              baseBranch: string;
              branch: string;
              startFromOrigin?: true;
            };
            runSetupScript: true;
          }
        | undefined;
      if (!threadExists && preferWorktree && workspaceRoot !== null) {
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
        worktreeBootstrap = {
          prepareWorktree: {
            projectCwd: workspaceRoot,
            baseBranch,
            branch: `voice-${identifiers.threadId}`,
            // Honor the environment's newWorktreesStartFromOrigin setting
            // (server decode default true), same semantics as the composer.
            ...(config.settings.newWorktreesStartFromOrigin === true
              ? { startFromOrigin: true as const }
              : {}),
          },
          runSetupScript: true,
        };
      }

      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: identifiers.commandId,
        threadId: identifiers.threadId,
        message: {
          messageId: identifiers.messageId,
          role: "user",
          text: task,
          attachments: [],
        },
        modelSelection: input.modelSelection,
        // Title and titleSeed carry the same value so the generated title can
        // replace it (threadTitles.ts replaces a title equal to titleSeed).
        titleSeed: title,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
        ...(threadExists
          ? {}
          : {
              bootstrap: {
                createThread: {
                  projectId: input.projectId,
                  title,
                  modelSelection: input.modelSelection,
                  runtimeMode,
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
                // A projected "local" (null/absent defaultThreadEnvMode) means
                // no explicit override; the voice path has no access to a
                // server-side t3.json env default on this base, so it creates
                // the thread local (branch/worktreePath null).
                ...worktreeBootstrap,
              },
            }),
      };

      let result: DispatchResult;
      try {
        result = await dispatch(command);
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyDispatchFailure(
            cause,
            entry.environmentId,
            input.projectId,
            identifiers.threadId,
          ),
        );
      }

      // Read back what actually happened. The dispatch receipt proves
      // acceptance, never execution; session status and lastError travel
      // in-band in the frozen output (a fast terminal success reports its
      // final status, a running worker reports starting/running, a worker
      // error reports status "error" with its lastError). A modelSelection
      // mismatch means the environment did not create what was asked, so the
      // tool refuses to report success.
      let readback: OrchestrationThreadDetailSnapshot;
      try {
        readback = await access.threadSnapshot(identifiers.threadId, { turnLimit: 1 });
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyEnvironmentFailureWithIds(cause, entry.environmentId, identifiers.threadId),
        );
      }
      const createdSelection = readback.thread.modelSelection;
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
      const output: VoiceStartThreadOutput = {
        requestId: input.requestId,
        environment: okOutcome(entry.environmentId),
        commandId: identifiers.commandId,
        threadId: identifiers.threadId,
        messageId: identifiers.messageId,
        dispatchSequence: result.sequence,
        session: sessionReadout(readback.thread),
      };
      startRecords.set(input.requestId, { destination, output });
      return output;
    },

    async observeThread(input) {
      const { access } = requireOpenEnvironment(input.environmentId);
      const afterSequence = input.afterSequence;
      let item: OrchestrationThreadStreamItem;
      try {
        item = await access.subscribeThread({
          threadId: input.threadId,
          ...(afterSequence !== undefined
            ? { afterSequence, requestCompletionMarker: true as const }
            : {}),
        });
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyEnvironmentFailureWithIds(cause, input.environmentId, input.threadId),
        );
      }

      const deriveFromThread = (
        thread: OrchestrationThread,
      ): {
        session: { status: OrchestrationSessionStatus; lastError: string | null };
        turnId?: TurnId;
        running: boolean;
      } => {
        const readout = sessionReadout(thread);
        return {
          session: readout,
          ...(thread.latestTurn !== null ? { turnId: thread.latestTurn.turnId } : {}),
          running: isSessionRunning(readout.status),
        };
      };

      if (item.kind === "snapshot") {
        const derived = deriveFromThread(item.snapshot.thread);
        return {
          environment: okOutcome(input.environmentId),
          threadId: input.threadId,
          sequence: detailSequence(item.snapshot),
          session: derived.session,
          ...(derived.turnId !== undefined ? { turnId: derived.turnId } : {}),
          running: derived.running,
        };
      }

      // Replayed event or completion marker: session state comes from a
      // bounded detail read (single event payloads do not reliably carry the
      // full session).
      let detail: OrchestrationThreadDetailSnapshot;
      try {
        detail = await access.threadSnapshot(input.threadId, { turnLimit: 1 });
      } catch (cause) {
        throw new VoiceToolFailureError(
          classifyEnvironmentFailureWithIds(cause, input.environmentId, input.threadId),
        );
      }
      const derived = deriveFromThread(detail.thread);
      return {
        environment: okOutcome(input.environmentId),
        threadId: input.threadId,
        sequence:
          item.kind === "event" ? item.event.sequence : (afterSequence ?? detailSequence(detail)),
        session: derived.session,
        ...(derived.turnId !== undefined ? { turnId: derived.turnId } : {}),
        running: derived.running,
      };
    },
  };
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
  tag: ORCHESTRATION_WS_METHODS.subscribeThread,
  idleTtlMs: 65_000,
});

/** Orchestration command dispatch for the creation path. Same transport as
    every other client command: the environment's WebSocket
    `orchestration.dispatchCommand` (operate scope), not the HTTP dispatch
    route. */
const orchestrationDispatchCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice:orchestration:dispatch-command",
  tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
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
    archivedShellSnapshot: async () => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        orchestrationEnvironment.archivedShellSnapshot({
          environmentId: prepared.environmentId,
          input: {},
        }),
        { reportFailure: false, reportDefect: false },
      );
      return unwrapAtomResult(result);
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
    threadSnapshot: async (threadId, window) => {
      const signer = await resolveSigner();
      return runEnvironmentHttp(
        fetchEnvironmentThreadSnapshot({
          prepared,
          threadId,
          signer,
          ...(window?.turnLimit !== undefined ? { window: { turnLimit: window.turnLimit } } : {}),
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
  };
}

import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import type { PluginId } from "@t3tools/contracts/plugin";
import type {
  AgentsAwaitTurnResult,
  AgentsCapability,
  AgentsCreateThreadInput,
  AgentsPendingRequest,
  AgentsStartTurnBootstrapInput,
} from "@t3tools/plugin-sdk";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as ProjectionThreadMessages from "../../persistence/Services/ProjectionThreadMessages.ts";
import type * as ProjectionTurns from "../../persistence/Services/ProjectionTurns.ts";
import type { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";

const DEFAULT_AWAIT_TURN_TIMEOUT = Duration.minutes(30);
// Re-poll cadence for the awaitTerminalTurn fallback below. streamDomainEvents has
// no subscription-readiness signal, so a turn that reaches terminal in the gap
// between the post-subscribe read and the watcher going live may emit no later
// event to wake the deferred; the poll re-reads the projection to guarantee
// progress. awaitTurn already bounds the total wait via Effect.timeoutOption.
const TERMINAL_POLL_INTERVAL = Duration.millis(250);

export class AgentsThreadOwnershipError extends Schema.TaggedErrorClass<AgentsThreadOwnershipError>()(
  "AgentsThreadOwnershipError",
  {
    pluginId: Schema.String,
    threadId: Schema.String,
    expectedOwner: Schema.String,
    actualOwner: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} cannot access thread ${this.threadId}; expected owner ${this.expectedOwner}, got ${this.actualOwner ?? "none"}.`;
  }
}

export class AgentsThreadNotFoundError extends Schema.TaggedErrorClass<AgentsThreadNotFoundError>()(
  "AgentsThreadNotFoundError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class AgentsTurnAwaitTimeoutError extends Schema.TaggedErrorClass<AgentsTurnAwaitTimeoutError>()(
  "AgentsTurnAwaitTimeoutError",
  {
    threadId: Schema.String,
    turnId: Schema.String,
  },
) {
  override get message(): string {
    return `Timed out waiting for turn ${this.turnId} on thread ${this.threadId}.`;
  }
}

export class AgentsInvalidTimeoutError extends Schema.TaggedErrorClass<AgentsInvalidTimeoutError>()(
  "AgentsInvalidTimeoutError",
  {
    timeout: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid awaitTurn timeout ${JSON.stringify(this.timeout)}; expected milliseconds or a Duration input like "30 seconds".`;
  }
}

export class AgentsBootstrapUnsupportedError extends Schema.TaggedErrorClass<AgentsBootstrapUnsupportedError>()(
  "AgentsBootstrapUnsupportedError",
  {
    threadId: Schema.String,
    fields: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `startTurn bootstrap field(s) ${this.fields.join(", ")} are not supported on the plugin capability path for thread ${this.threadId}; create the worktree via the vcs capability and run setup via the terminals capability instead.`;
  }
}

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const nextCommandId = (tag: string) => CommandId.make(`plugin:${tag}:${NodeCrypto.randomUUID()}`);
const nextThreadId = () => ThreadId.make(NodeCrypto.randomUUID());
const nextMessageId = () => MessageId.make(`plugin-message:${NodeCrypto.randomUUID()}`);
const nextTurnId = () => TurnId.make(`plugin-turn:${NodeCrypto.randomUUID()}`);

// Deterministic id derivations keyed on the caller-supplied commandId. The engine
// dedups dispatch by commandId, so a retry with the same commandId does NOT
// persist a new turn — the original one stays. The ids startTurn returns (and
// registers in turnAliases) must therefore be STABLE across retries of the same
// commandId; otherwise a retry would hand back a fresh messageId that was never
// persisted and a later awaitTurn(turnId) — which correlates via the alias's
// messageId — could never match and would time out. Hashing keeps the derived id
// opaque and bounded rather than echoing the raw commandId.
const stableIdSuffix = (commandId: CommandId) =>
  NodeCrypto.createHash("sha256").update(String(commandId)).digest("hex").slice(0, 32);
const messageIdForCommand = (commandId: CommandId) =>
  MessageId.make(`plugin-message:${stableIdSuffix(commandId)}`);
const turnIdForCommand = (commandId: CommandId) =>
  TurnId.make(`plugin-turn:${stableIdSuffix(commandId)}`);

function isThreadDetailEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

function toTimeoutDuration(
  input: string | number | undefined,
): Effect.Effect<Duration.Duration, AgentsInvalidTimeoutError> {
  if (input === undefined) return Effect.succeed(DEFAULT_AWAIT_TURN_TIMEOUT);
  if (typeof input === "number") return Effect.succeed(Duration.millis(input));
  // The timeout is plugin-provided DATA: parse it safely and fail typed instead
  // of defecting the fiber on a malformed string like "soon"
  // (Duration.fromInputUnsafe throws, which would surface as an internal RPC
  // failure and bypass normal error handling).
  const parsed = Duration.fromInput(input as Duration.Input);
  return Option.isSome(parsed)
    ? Effect.succeed(parsed.value)
    : Effect.fail(new AgentsInvalidTimeoutError({ timeout: input }));
}

type TerminalProjectionTurn = ProjectionTurns.ProjectionTurnById & {
  readonly state: AgentsAwaitTurnResult["state"];
};

function terminalState(
  state: ProjectionTurns.ProjectionTurnById["state"],
): state is AgentsAwaitTurnResult["state"] {
  return state === "completed" || state === "error" || state === "interrupted";
}

function isTerminalTurn(
  row: ProjectionTurns.ProjectionTurnById | null,
): row is TerminalProjectionTurn {
  return row !== null && terminalState(row.state);
}

function activityRequestId(payload: unknown): string | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("requestId" in payload) ||
    typeof (payload as { requestId?: unknown }).requestId !== "string"
  ) {
    return null;
  }
  return (payload as { requestId: string }).requestId;
}

function pendingRequestFromActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): AgentsPendingRequest | null {
  if (activity.kind !== "approval.requested" && activity.kind !== "user-input.requested") {
    return null;
  }
  const requestId = activityRequestId(activity.payload);
  if (requestId === null) {
    return null;
  }
  return {
    kind: activity.kind,
    requestId,
    activity: activity as AgentsPendingRequest["activity"],
  };
}

// Details that mark a respond failure as "the provider no longer knows this
// request", mirroring the stale-failure detail matching in
// ProjectionPipeline.ts (isStalePendingApprovalFailureDetail +
// derivePendingUserInputCountFromActivities). Such a request is closed for all
// practical purposes and must not be re-surfaced as pending.
const STALE_REQUEST_FAILURE_DETAILS = [
  "stale pending approval request",
  "unknown pending approval request",
  "unknown pending permission request",
  "stale pending user-input request",
  "unknown pending user-input request",
  "unknown pending user input request",
  "unknown pending codex user input request",
];

function isStaleRequestFailure(kind: string, payload: unknown): boolean {
  if (
    kind !== "provider.approval.respond.failed" &&
    kind !== "provider.user-input.respond.failed"
  ) {
    return false;
  }
  const detail =
    typeof payload === "object" && payload !== null && "detail" in payload
      ? (payload as { detail?: unknown }).detail
      : null;
  if (typeof detail !== "string") return false;
  const lowered = detail.toLowerCase();
  return STALE_REQUEST_FAILURE_DETAILS.some((marker) => lowered.includes(marker));
}

// Reduce a thread's activity log to the requests that are STILL open: a
// `*.requested` opens, a matching `*.resolved` (or a stale/unknown respond
// failure) closes. Without this, every historical request would be returned
// forever and an already-answered approval could be re-surfaced and
// double-submitted. Mirrors the fail-closed resolution accounting the
// projection pipeline applies for pending-approval rows and the user-input
// counter.
function pendingRequestsFromActivities(
  activities: ReadonlyArray<AgentsPendingRequest["activity"]>,
): ReadonlyArray<AgentsPendingRequest> {
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const open = new Map<string, AgentsPendingRequest>();
  for (const activity of ordered) {
    const pending = pendingRequestFromActivity(activity);
    if (pending) {
      open.set(pending.requestId, pending);
      continue;
    }
    if (
      activity.kind === "approval.resolved" ||
      activity.kind === "user-input.resolved" ||
      isStaleRequestFailure(activity.kind, activity.payload)
    ) {
      const requestId = activityRequestId(activity.payload);
      if (requestId !== null) {
        open.delete(requestId);
      }
    }
  }
  return [...open.values()];
}

function normalizeBootstrapForTurnStart(
  bootstrap: AgentsStartTurnBootstrapInput | undefined,
): AgentsStartTurnBootstrapInput | undefined {
  if (!bootstrap?.createThread) return bootstrap;
  return {
    ...bootstrap,
    createThread: {
      ...bootstrap.createThread,
      createdAt: bootstrap.createThread.createdAt ?? nowIso(),
      runtimeMode: bootstrap.createThread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: bootstrap.createThread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: bootstrap.createThread.branch ?? null,
      worktreePath: bootstrap.createThread.worktreePath ?? null,
    } as AgentsStartTurnBootstrapInput["createThread"],
  };
}

export function makeAgentsCapability(
  input: {
    readonly pluginId: PluginId;
    readonly engine: OrchestrationEngineService["Service"];
    readonly snapshots: ProjectionSnapshotQuery["Service"];
    readonly turns: ProjectionTurns.ProjectionTurnRepository["Service"];
    readonly messages: ProjectionThreadMessages.ProjectionThreadMessageRepository["Service"];
    readonly providerInstances: ProviderInstanceRegistry["Service"];
  },
  // Session-local turnId -> {threadId, messageId} bridge used by readTerminalTurn.
  // Injectable (defaulting to a fresh map) so tests can assert that a failed
  // start does not leak entries; production always uses the default. `terminal`
  // is an eviction hint only (see rememberTurnAlias) — terminal-ness itself is
  // always re-derived from the projection on every read.
  turnAliases: Map<
    string,
    { readonly threadId: ThreadId; readonly messageId: MessageId; readonly terminal: boolean }
  > = new Map(),
  // Upper bound on live aliases. Injectable (defaulting generously) so tests can
  // drive a small value; see rememberTurnAlias for the eviction policy.
  maxTurnAliases: number = 4096,
): AgentsCapability {
  const owner = `plugin:${input.pluginId}` as `plugin:${string}`;

  // Record a pending turn alias under a bounded cap. An alias is KEPT (marked
  // terminal, not deleted) once its turn completes so that a re-await or a
  // concurrent second awaiter still resolves; eviction therefore reclaims the
  // oldest TERMINAL entry first and only falls back to evicting the oldest
  // pending entry when every entry is still pending — the cap must hold, but
  // that fallback is only reachable under pathological (> cap) concurrent
  // un-awaited turns, where the evicted turn's later awaitTurn falls through
  // to the not-found path (degraded, not a crash).
  const rememberTurnAlias = (
    turnId: TurnId,
    entry: { readonly threadId: ThreadId; readonly messageId: MessageId },
  ) => {
    const key = String(turnId);
    if (!turnAliases.has(key) && turnAliases.size >= maxTurnAliases) {
      let evict: string | undefined;
      for (const [candidateKey, candidate] of turnAliases) {
        if (candidate.terminal) {
          evict = candidateKey;
          break;
        }
        // Oldest overall as a fallback, used only when nothing is terminal.
        evict ??= candidateKey;
      }
      if (evict !== undefined) turnAliases.delete(evict);
    }
    turnAliases.set(key, { ...entry, terminal: false });
  };

  const requireOwnedThread = (threadId: ThreadId) =>
    input.snapshots.getThreadOwnerById(threadId).pipe(
      Effect.flatMap(
        (
          actualOwner,
        ): Effect.Effect<void, AgentsThreadOwnershipError | AgentsThreadNotFoundError> => {
          // Distinguish "thread does not exist" from "owned by another plugin": a
          // missing owner is a not-found (otherwise the AgentsThreadNotFoundError
          // branches in callers are unreachable), while a real owner mismatch is
          // an ownership failure. A thread owned by us still passes.
          if (Option.isNone(actualOwner)) {
            return Effect.fail(new AgentsThreadNotFoundError({ threadId }));
          }
          if (actualOwner.value === owner) {
            return Effect.void;
          }
          return Effect.fail(
            new AgentsThreadOwnershipError({
              pluginId: input.pluginId,
              threadId,
              expectedOwner: owner,
              actualOwner: actualOwner.value,
            }),
          );
        },
      ),
    );

  const readTerminalTurn = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      const direct = yield* input.turns.getByTurnId({ threadId, turnId });
      if (Option.isSome(direct)) {
        return direct.value;
      }
      const alias = turnAliases.get(String(turnId));
      if (!alias || alias.threadId !== threadId) {
        return null;
      }
      const rows = yield* input.turns.listByThreadId({ threadId });
      return (
        rows.find(
          (row): row is ProjectionTurns.ProjectionTurnById =>
            row.turnId !== null && row.pendingMessageId === alias.messageId,
        ) ?? null
      );
    }).pipe(
      Effect.flatMap((row) => {
        if (!isTerminalTurn(row)) return Effect.succeed(null);
        // Keep the alias but mark it terminal. Deleting it here broke re-await:
        // a synthetic plugin turnId correlates ONLY via the alias (getByTurnId
        // never matches it), so a second awaitTurn on a completed turn — a
        // re-await after done, a concurrent second waiter, or an await after a
        // prior internal read — would find nothing and poll to timeout. The
        // terminal flag is purely an eviction hint for rememberTurnAlias, which
        // reclaims terminal entries first, keeping the map bounded without ever
        // dropping a turn a live awaitTurn may still need.
        const key = String(turnId);
        const alias = turnAliases.get(key);
        if (alias && !alias.terminal) {
          turnAliases.set(key, { ...alias, terminal: true });
        }
        return Effect.succeed(row);
      }),
    );

  const readAwaitResult = (row: TerminalProjectionTurn) =>
    Effect.gen(function* () {
      const assistantMessage =
        row.assistantMessageId === null
          ? Option.none<ProjectionThreadMessages.ProjectionThreadMessage>()
          : yield* input.messages.getByMessageId({ messageId: row.assistantMessageId });
      return {
        state: row.state,
        assistantText:
          Option.isSome(assistantMessage) && !assistantMessage.value.isStreaming
            ? assistantMessage.value.text
            : null,
      } satisfies AgentsAwaitTurnResult;
    });

  const awaitTerminalTurn = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      const first = yield* readTerminalTurn(threadId, turnId);
      if (first) return first;

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const terminalDeferred = yield* Deferred.make<TerminalProjectionTurn>();
          const waitForEvent = input.engine.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.aggregateKind === "thread" && event.aggregateId === threadId,
            ),
            Stream.mapEffect(() =>
              readTerminalTurn(threadId, turnId).pipe(
                Effect.flatMap((row) =>
                  row ? Deferred.succeed(terminalDeferred, row).pipe(Effect.ignore) : Effect.void,
                ),
              ),
            ),
            Stream.runDrain,
          );
          yield* waitForEvent.pipe(Effect.forkScoped);
          const afterSubscribe = yield* readTerminalTurn(threadId, turnId);
          if (afterSubscribe) return afterSubscribe;
          // Race the event-driven wake against a bounded re-poll. forkScoped returns
          // before the watcher has actually subscribed, so a turn that goes terminal
          // in that gap may produce no later event to wake terminalDeferred; the poll
          // guarantees progress by re-reading the projection. The event path keeps the
          // common case low-latency, and awaitTurn's outer Effect.timeoutOption bounds
          // the total wait so the poll needs no independent cap.
          const pollForTerminal: Effect.Effect<TerminalProjectionTurn, ProjectionRepositoryError> =
            Effect.suspend(() =>
              readTerminalTurn(threadId, turnId).pipe(
                Effect.flatMap((row) =>
                  row
                    ? Effect.succeed(row)
                    : Effect.sleep(TERMINAL_POLL_INTERVAL).pipe(
                        Effect.flatMap(() => pollForTerminal),
                      ),
                ),
              ),
            );
          return yield* Effect.race(Deferred.await(terminalDeferred), pollForTerminal);
        }),
      );
    });

  return {
    listInstances: () =>
      Effect.gen(function* () {
        const [instances, unavailable] = yield* Effect.all([
          input.providerInstances.listInstances,
          input.providerInstances.listUnavailable,
        ]);
        const available = yield* Effect.forEach(
          instances,
          (instance) => instance.snapshot.getSnapshot,
        );
        return { available, unavailable };
      }),

    createThread: (request: AgentsCreateThreadInput) =>
      Effect.gen(function* () {
        const threadId = nextThreadId();
        const createdAt = nowIso();
        yield* input.engine.dispatch({
          type: "thread.create",
          commandId: nextCommandId("thread-create"),
          threadId,
          projectId: request.projectId,
          title: request.title,
          owner,
          modelSelection: request.modelSelection,
          runtimeMode: request.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: request.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: request.branch ?? null,
          worktreePath: request.worktreePath ?? null,
          createdAt,
        });
        return { threadId };
      }),

    startTurn: (request) =>
      Effect.gen(function* () {
        const bootstrap = normalizeBootstrapForTurnStart(request.bootstrap);
        // The plugin path dispatches thread.turn.start straight to the engine,
        // whose decider ignores bootstrap prep — the atomic prepareWorktree /
        // runSetupScript handling lives only in the WS entrypoint
        // (dispatchBootstrapTurnStart in ws.ts). Forwarding those fields here
        // would be a silent no-op that misleads the caller into believing the
        // prep ran, so reject them loudly instead: plugins create worktrees via
        // the vcs capability and run setup via the terminals capability.
        const unsupportedBootstrapFields = [
          ...(bootstrap?.prepareWorktree !== undefined ? ["prepareWorktree"] : []),
          ...(bootstrap?.runSetupScript ? ["runSetupScript"] : []),
        ];
        if (unsupportedBootstrapFields.length > 0) {
          return yield* new AgentsBootstrapUnsupportedError({
            threadId: request.threadId,
            fields: unsupportedBootstrapFields,
          });
        }
        const actualOwner = yield* input.snapshots.getThreadOwnerById(request.threadId);
        if (Option.isSome(actualOwner) && actualOwner.value !== owner) {
          return yield* new AgentsThreadOwnershipError({
            pluginId: input.pluginId,
            threadId: request.threadId,
            expectedOwner: owner,
            actualOwner: actualOwner.value,
          });
        }
        // When the thread does not yet exist we create it explicitly here
        // rather than via the turn-start bootstrap: the decider's
        // thread.turn.start ignores bootstrap.createThread (that atomic path
        // lives only in the WS entrypoint), so the create must be its own
        // dispatch. If turn-start then fails, best-effort delete the thread we
        // just created so we don't orphan a plugin-owned thread.
        const createdThread = Option.isNone(actualOwner);
        if (createdThread) {
          if (!bootstrap?.createThread) {
            return yield* new AgentsThreadOwnershipError({
              pluginId: input.pluginId,
              threadId: request.threadId,
              expectedOwner: owner,
              actualOwner: null,
            });
          }
          yield* input.engine.dispatch({
            type: "thread.create",
            // Derive the bootstrap create's commandId from the caller's when
            // present, so two overlapping starts with the SAME caller commandId
            // (both seeing the thread absent) dispatch the SAME create commandId.
            // The engine returns the stored receipt for a repeated commandId
            // without re-running requireThreadAbsent, so the losing create dedups
            // instead of colliding — the losing start would otherwise fail,
            // violating the commandId idempotency contract. Without a caller
            // commandId, mint a fresh random id as before.
            commandId:
              request.commandId !== undefined
                ? CommandId.make(
                    `plugin:bootstrap-thread-create:${stableIdSuffix(request.commandId)}`,
                  )
                : nextCommandId("bootstrap-thread-create"),
            threadId: request.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            owner,
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode:
              bootstrap.createThread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: bootstrap.createThread.branch ?? null,
            worktreePath: bootstrap.createThread.worktreePath ?? null,
            createdAt: bootstrap.createThread.createdAt ?? nowIso(),
          });
        }
        // A caller-supplied commandId makes the turn idempotent (the engine dedups
        // dispatch by commandId), so the returned turnId/messageId must be stable
        // across retries — derive them deterministically from the commandId so a
        // retry resolves the same alias the first call persisted. Without a
        // commandId, mint fresh random ids as before.
        const turnId =
          request.commandId !== undefined ? turnIdForCommand(request.commandId) : nextTurnId();
        // Idempotent retry: same commandId → same derived turnId, so an existing
        // alias holds the messageId the first call actually persisted
        // (pendingMessageId). Reuse it so a retry that omits messageId — or supplies
        // a different one — doesn't overwrite the alias with a fresh derived id the
        // engine never persisted, which would leave awaitTurn(turnId) correlating on
        // the wrong messageId and timing out.
        const existingAlias =
          request.commandId !== undefined ? turnAliases.get(String(turnId)) : undefined;
        const messageId =
          existingAlias?.messageId ??
          request.messageId ??
          (request.commandId !== undefined
            ? messageIdForCommand(request.commandId)
            : nextMessageId());
        rememberTurnAlias(turnId, { threadId: request.threadId, messageId });
        // No bootstrap is forwarded to the engine: createThread was handled
        // explicitly above, and the unsupported prep fields were rejected at
        // the top of this method (the decider would ignore them anyway).
        yield* input.engine
          .dispatch({
            type: "thread.turn.start",
            commandId: request.commandId ?? nextCommandId("turn-start"),
            threadId: request.threadId,
            message: {
              messageId,
              role: "user",
              text: request.text,
              attachments: [...(request.attachments ?? [])],
            },
            ...(request.modelSelection !== undefined
              ? { modelSelection: request.modelSelection }
              : {}),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: nowIso(),
          })
          .pipe(
            Effect.tapError(() =>
              // Always drop the pending alias on failure so a failed start never
              // leaks a turnAliases entry (the map would otherwise grow for the
              // plugin process lifetime on repeated failed starts). Additionally
              // roll back the thread we just created, but only when this start
              // created it.
              Effect.sync(() => turnAliases.delete(String(turnId))).pipe(
                Effect.andThen(
                  createdThread
                    ? input.engine
                        .dispatch({
                          type: "thread.delete",
                          commandId: nextCommandId("thread-create-rollback"),
                          threadId: request.threadId,
                        })
                        .pipe(Effect.ignore)
                    : Effect.void,
                ),
              ),
            ),
          );
        return { turnId, messageId };
      }),

    observeThread: (threadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* requireOwnedThread(threadId);
          // Subscribe to live thread-detail events into a bounded, back-pressured
          // queue BEFORE reading the snapshot. The previous Stream.concat only
          // subscribed AFTER the snapshot was emitted, so any event committed in
          // that window was dropped. The engine commits the projection update
          // before publishing to the domain-event PubSub, so once we are
          // subscribed here every event committed after this point is captured in
          // the buffer. A hard, scheduler-independent guarantee would additionally
          // require a subscription-readiness signal from streamDomainEvents (an
          // engine-level change); ws.ts carries the same residual assumption.
          const buffer = yield* Queue.bounded<OrchestrationEvent>(256);
          yield* input.engine.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === threadId &&
                isThreadDetailEvent(event),
            ),
            Stream.runForEach((event) => Queue.offer(buffer, event)),
            Effect.forkScoped,
          );

          // Read snapshotSequence FIRST, then the thread detail, sequentially
          // (not concurrently). getThreadDetailById returns only
          // Option<OrchestrationThread> with no per-thread sequence, so the replay
          // is deduped against the GLOBAL snapshotSequence. Reading that threshold
          // before the detail guarantees it never exceeds the state the detail
          // reflects, so no committed update is ever filtered out (no dropped
          // events); a bounded duplicate within the read window is idempotent on
          // the revision-gated client. Being simultaneously dup-free AND gap-free
          // is unattainable without a per-thread snapshot sequence
          // (getThreadDetailById does not expose one), so we deliberately choose
          // at-least-once: a lost update is worse than an idempotent re-render.
          const snapshotSequence = yield* input.snapshots
            .getSnapshotSequence()
            .pipe(Effect.map((snapshot) => snapshot.snapshotSequence));
          const threadDetail = yield* input.snapshots.getThreadDetailById(threadId);
          if (Option.isNone(threadDetail)) {
            return yield* new AgentsThreadNotFoundError({ threadId });
          }

          return Stream.concat(
            Stream.make({
              kind: "snapshot" as const,
              snapshot: { snapshotSequence, thread: threadDetail.value },
            }),
            Stream.fromQueue(buffer).pipe(
              // Skip events already reflected in the snapshot to avoid emitting a
              // duplicate of an event the snapshot already contains.
              Stream.filter((event) => event.sequence > snapshotSequence),
              Stream.map((event) => ({ kind: "event" as const, event })),
            ),
          );
        }),
      ),

    awaitTurn: (request) =>
      Effect.gen(function* () {
        yield* requireOwnedThread(request.threadId);
        const timeout = yield* toTimeoutDuration(request.timeout);
        const terminal = yield* awaitTerminalTurn(request.threadId, request.turnId).pipe(
          Effect.timeoutOption(timeout),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new AgentsTurnAwaitTimeoutError({
                    threadId: request.threadId,
                    turnId: request.turnId,
                  }),
                ),
              onSome: (row) => Effect.succeed(row),
            }),
          ),
        );
        return yield* readAwaitResult(terminal);
      }),

    listPendingRequests: (threadId) =>
      Effect.gen(function* () {
        yield* requireOwnedThread(threadId);
        const thread = yield* input.snapshots.getThreadDetailById(threadId);
        if (Option.isNone(thread)) {
          return yield* new AgentsThreadNotFoundError({ threadId });
        }
        return pendingRequestsFromActivities(thread.value.activities);
      }),

    respondToApproval: (request) =>
      requireOwnedThread(request.threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.approval.respond",
            commandId: nextCommandId("approval-respond"),
            threadId: request.threadId,
            requestId: request.requestId as any,
            decision: request.decision,
            createdAt: nowIso(),
          }),
        ),
        Effect.asVoid,
      ),

    respondToUserInput: (request) =>
      requireOwnedThread(request.threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.user-input.respond",
            commandId: nextCommandId("user-input-respond"),
            threadId: request.threadId,
            requestId: request.requestId as any,
            answers: request.answers,
            createdAt: nowIso(),
          }),
        ),
        Effect.asVoid,
      ),

    interruptTurn: (request) =>
      requireOwnedThread(request.threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: nextCommandId("turn-interrupt"),
            threadId: request.threadId,
            ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
            createdAt: nowIso(),
          }),
        ),
        Effect.asVoid,
      ),

    stopSession: ({ threadId }) =>
      requireOwnedThread(threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.session.stop",
            commandId: nextCommandId("session-stop"),
            threadId,
            createdAt: nowIso(),
          }),
        ),
        Effect.asVoid,
      ),

    deleteThread: ({ threadId }) =>
      requireOwnedThread(threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.delete",
            commandId: nextCommandId("thread-delete"),
            threadId,
          }),
        ),
        Effect.asVoid,
      ),
  };
}

/**
 * AntigravityAdapterLive — Antigravity CLI (`agy`) via the bundled ACP bridge.
 *
 * Antigravity has no native agent protocol, so the ACP peer this adapter talks
 * to is T3 Code's own bridge (`t3 agy-acp`). That shapes three deliberate
 * differences from the CLI-native ACP adapters:
 *
 *   - **Approvals come from the hook, not the CLI.** `agy` always runs with
 *     `--dangerously-skip-permissions` because print mode cannot prompt. When
 *     `requireToolApproval` is set, the bridge's `PreToolUse` hook becomes the
 *     gate instead: it blocks the tool until this adapter answers, and a
 *     denial is reported back to the model. On by default: without it nothing
 *     stands between the model and an auto-approved tool.
 *   - **No session modes.** Print mode has no plan/ask distinction to switch.
 *   - **Attachments travel by reference.** `agy --print` has no attachment
 *     flag, so files are sent as `resource_link` blocks and the bridge stages
 *     them into a directory it grants the CLI access to for that turn.
 *   - **Model changes apply from the next turn.** `--model` is a per-spawn
 *     flag that composes with `--conversation`, so a switch keeps the
 *     trajectory rather than needing a new session.
 *
 * @module AntigravityAdapterLive
 */

import {
  type AntigravitySettings,
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { attachmentFileUrl, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  makeAntigravityAcpRuntime,
  resolveAntigravityBaseModelId,
} from "../acp/AntigravityAcpSupport.ts";
import { type AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
/**
 * How long this side waits for a tool-approval answer.
 *
 * Deliberately *shorter* than the bridge's own wait, which is shorter again
 * than the hook's. Each layer must give up before the one behind it: when this
 * was the longest, the bridge had already denied and released the hook while
 * the request was still open here, so a user answering in that window got an
 * acceptance the bridge would ignore.
 */
const APPROVAL_WAIT_MS = 9 * 60 * 1000;
/**
 * How long to let the bridge answer a cancelled prompt on its own before
 * interrupting the RPC. Only a backstop against a wedged bridge; the normal
 * path settles well inside it.
 */
const CANCEL_ACK_TIMEOUT_MS = 10_000;
/**
 * How long turn settlement waits for an approval handler it just cancelled to
 * publish its resolution. Short: the handler is already unblocked, so this only
 * covers the hop back through the runtime, and a turn must never be held open
 * by a handler that will not finish.
 */
const APPROVAL_SETTLE_TIMEOUT_MS = 5_000;
const ANTIGRAVITY_RESUME_VERSION = 1 as const;

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`antigravity`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver, used by tests that mutate
   * `ServerSettingsService` mid-flight. Production leaves this undefined and
   * relies on the hydration layer rebuilding the adapter on config change.
   */
  readonly resolveSettings?: Effect.Effect<AntigravitySettings>;
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  /** Model the bridge will pass to `agy --model` on the next turn. */
  currentModelId: string | undefined;
  /**
   * Bumped by every interrupt. A prompt records this when it is accepted and
   * rechecks it immediately before submitting: the ACP runtime serializes
   * prompts behind a semaphore, so a steer can still be waiting there when
   * Stop is pressed and would otherwise reach the bridge *after* the cancel,
   * capture the post-cancel state, and run anyway.
   */
  cancelEpoch: number;
  /**
   * Turns whose `turn.started` a prompt has reserved the right to publish.
   * Shared rather than per-call, so a steer cannot assume the prompt it folded
   * into already announced the turn — that prompt may have failed in preflight.
   */
  readonly reservedTurnIds: Set<TurnId>;
  /**
   * Turns whose `turn.started` is actually on the wire.
   *
   * Kept apart from the reservation: teardown may run while a start is still
   * being stamped, and completing a turn nobody has seen start is as wrong as
   * dropping the completion of one they have.
   */
  readonly publishedTurnIds: Set<TurnId>;
  /**
   * Serializes prompt submission for this thread.
   *
   * `acp.prompt` already queues internally on its own semaphore, but that one
   * is acquired inside the call where nothing can be rechecked — a steer could
   * clear the cancel check, wait there, and reach the agent after Stop. Taking
   * the same serialization here instead makes the wait observable, so the
   * epoch can be re-read at the point submission actually begins. Deliberately
   * separate from the thread lock, which teardown needs to stay free.
   */
  readonly promptGate: Semaphore.Semaphore;
  /**
   * Serializes the turn-lifecycle critical sections against teardown.
   *
   * Announcing a turn is "check the session is live, reserve the turn, publish
   * the start" and teardown is "mark stopped, snapshot what was published".
   * Interleaving those two is what let a start be published after
   * `session.exited`, or a turn be completed while its start was still being
   * stamped. Both run under this, and both are short and yield-free apart from
   * the publications they own.
   */
  readonly lifecycleGate: Semaphore.Semaphore;
  /**
   * Fired the moment teardown begins. Waiting on the event consumer races
   * against this rather than a wall clock, so a slow but healthy consumer is
   * still awaited in full while a torn-down one never blocks anybody.
   */
  readonly teardownSignal: Deferred.Deferred<void>;
  /**
   * This session's pending approvals. Held on the context as well as in
   * `approvalsByThread` so teardown can tell its own map from a replacement
   * session's before clearing the registry entry.
   */
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  /** Bridge-side session id, needed to address provider-specific notifications. */
  readonly acpSessionId: string;

  /** Cancel epoch the active turn belongs to; steering is scoped to it. */
  activeTurnEpoch: number;
  /**
   * Turns whose prompt the bridge has not answered yet.
   *
   * The cancel fallback arms on this rather than on "is that turn still
   * active": a turn stays active while its events drain, and a healthy drain
   * can outlast the acknowledgement window — which would have the fallback
   * tear down a session that is working perfectly.
   */
  readonly awaitingBridgeAck: Set<TurnId>;
  /**
   * Number of prompts in flight. >0 means a turn is running, so a new
   * sendTurn steers the existing turn rather than opening a new one.
   */
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAntigravityResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ANTIGRAVITY_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/**
 * Reasoning effort for `agy --effort`, read from the model option selections.
 * Antigravity accepts only low/medium/high.
 */
function resolveEffortSelection(
  options:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | null
    | undefined,
): string | undefined {
  // Option values are a string/boolean union across providers; only a string
  // effort is meaningful here.
  const raw = options?.find((option) => option.id === "effort")?.value;
  const effort = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;
}

/** A thread's lock plus how many callers currently want it. */
interface ThreadLock {
  readonly semaphore: Semaphore.Semaphore;
  holders: number;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  /**
   * The turn this request belongs to, so settlement can release exactly the
   * approvals its own turn opened. Undefined when no turn was active, which
   * only happens for a request arriving outside a prompt.
   */
  readonly turnId: TurnId | undefined;
  /** Completed once the handler has published this request's resolution. */
  readonly settled: Deferred.Deferred<void>;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((entry) => entry.kind === kind)?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

export function makeAntigravityAdapter(
  antigravitySettings: AntigravitySettings,
  options?: AntigravityAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("antigravity");
    const serverConfig = yield* Effect.service(ServerConfig);
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    // Scope for work that must outlive the session it concerns — specifically
    // the cancel-acknowledgement fallback, whose whole job is to tear that
    // session down. Forked into the session's own scope it would be closing the
    // scope it runs in, and a scope waits for its children: the close would
    // wait on the fiber waiting on the close.
    const adapterScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Effect.ignore(Scope.close(adapterScope, Exit.void)));

    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    /**
     * Approvals awaiting a user decision, per thread. Held outside the session
     * context because the permission callback is registered before the context
     * exists, and `respondToRequest` resolves entries from a different call.
     */
    const approvalsByThread = new Map<ThreadId, Map<ApprovalRequestId, PendingApproval>>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, ThreadLock>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Antigravity runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Antigravity ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    /**
     * Acquire this thread's lock, counting holders so the entry can be dropped
     * once the last one leaves. Threads come and go for the life of the
     * adapter — and a `stopSession` for an id that never existed still mints a
     * lock — so an unreleased entry per id would grow without bound.
     */
    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<ThreadLock> = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const lock: ThreadLock = { semaphore, holders: 1 };
                const next = new Map(current);
                next.set(threadId, lock);
                return [lock, next] as const;
              }),
            ),
          onSome: (lock) => {
            lock.holders += 1;
            return Effect.succeed([lock, current] as const);
          },
        });
      });

    const releaseThreadSemaphore = (threadId: string) =>
      SynchronizedRef.update(threadLocksRef, (current) => {
        const lock = current.get(threadId);
        if (!lock) {
          return current;
        }
        lock.holders -= 1;
        if (lock.holders > 0) {
          return current;
        }
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      // Bracketed: an interrupt landing between taking the holder count and
      // registering its release would retain that thread's entry for good,
      // which is the leak the counting is there to prevent.
      Effect.acquireUseRelease(
        getThreadSemaphore(threadId),
        (lock) => lock.semaphore.withPermit(effect),
        () => releaseThreadSemaphore(threadId),
      );

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravitySessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /**
     * Idempotent, uninterruptible teardown of everything a context owns.
     *
     * Shared by the normal stop path and its failure path so neither can leave
     * half of it done: `ctx.stopped` is set before any of this runs, so a stop
     * that died partway would otherwise make every later attempt return
     * immediately with the bridge and its `agy` child still alive.
     */
    const cleanupContext = (ctx: AntigravitySessionContext) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (ctx.notificationFiber) {
            yield* Effect.ignore(Fiber.interrupt(ctx.notificationFiber));
            ctx.notificationFiber = undefined;
          }
          yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
          // Ownership-checked: a replacement session may already have been
          // installed while this teardown was closing a slow child, and
          // clearing its entries would leak that session's process.
          if (sessions.get(ctx.threadId) === ctx) {
            sessions.delete(ctx.threadId);
          }
          if (approvalsByThread.get(ctx.threadId) === ctx.approvals) {
            approvalsByThread.delete(ctx.threadId);
          }
        }),
      );

    const stopSessionInternal = (
      ctx: AntigravitySessionContext,
      /**
       * Stop only while this turn is still the active one. Used by the
       * cancel-acknowledgement fallback, whose decision to stop was made ten
       * seconds earlier: without rechecking under the gate, a turn that settled
       * in the meantime would take its replacement down with it.
       */
      onlyIfActiveTurn?: TurnId,
      /**
       * Additional condition rechecked under the gate. The fallback's reason to
       * stop — the bridge never acknowledged — can stop being true between it
       * deciding and this claiming, and the turn stays active while its events
       * drain, so the turn id alone does not settle it.
       */
      onlyIf?: () => boolean,
    ) => {
      // Whether this call is the one that claimed the teardown. The cleanup
      // below must not run otherwise: a call that declined because the turn had
      // moved on would close a session that is perfectly alive.
      let claimedTeardown = false;
      return Effect.gen(function* () {
        // Claiming the stop, snapshotting what was published, and clearing the
        // active turn happen under the lifecycle gate so they cannot interleave
        // with a `sendTurn` that is midway through announcing its turn.
        const orphanedTurnIds = yield* ctx.lifecycleGate.withPermit(
          Effect.sync(() => {
            if (ctx.stopped) {
              return undefined;
            }
            if (onlyIfActiveTurn !== undefined && ctx.activeTurnId !== onlyIfActiveTurn) {
              return undefined;
            }
            if (onlyIf !== undefined && !onlyIf()) {
              return undefined;
            }
            ctx.stopped = true;
            claimedTeardown = true;
            const claimed = [...ctx.publishedTurnIds];
            ctx.publishedTurnIds.clear();
            ctx.reservedTurnIds.clear();
            ctx.activeTurnId = undefined;
            return claimed;
          }),
        );
        if (orphanedTurnIds === undefined) {
          return;
        }
        // Releases anything waiting on the event consumer before that consumer
        // is torn down.
        yield* Effect.ignore(Deferred.succeed(ctx.teardownSignal, undefined));

        // Anything still waiting on a human is cancelled, which the bridge
        // turns into a denial. Left pending, the hook would block its tool
        // until its own timeout with no one able to answer.
        for (const [, approval] of ctx.approvals) {
          // Ignored: an answer racing session stop may have settled this
          // already, and that must not abort the rest of teardown.
          yield* Effect.ignore(Deferred.succeed(approval.decision, "cancel"));
        }
        ctx.approvals.clear();

        // Quiesced before any terminal event is published: updates already
        // queued for the consumer would otherwise surface after the completion
        // that is supposed to close them out.
        yield* cleanupContext(ctx);

        for (const orphanedTurnId of orphanedTurnIds) {
          // The stamp is generated inside the ignored region, not before it.
          // `makeEventStamp` can fail — it mints a UUID — and evaluating it
          // outside would abort teardown after `ctx.stopped` was set and the
          // published set cleared, losing this completion and everything after
          // it with no later stop able to retry.
          yield* Effect.ignore(
            Effect.gen(function* () {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: orphanedTurnId,
                payload: { state: "cancelled", stopReason: null },
              });
            }),
          );
        }
        // Suppressed when a replacement already holds this thread: the event
        // names the thread, not the context, so it would read as the new
        // session exiting.
        if (sessions.get(ctx.threadId) === undefined) {
          yield* Effect.ignore(
            Effect.gen(function* () {
              yield* offerRuntimeEvent({
                type: "session.exited",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: { exitKind: "graceful" },
              });
            }),
          );
        }
      }).pipe(
        // The whole sequence is uninterruptible, not just the cleanup inside
        // it. `ctx.stopped` and the published-turn snapshot are taken first, so
        // an interrupt partway would have the session torn down by `onExit`
        // while the completions and `session.exited` it owed were never
        // published — and no later stop would retry, the flag already being set.
        Effect.uninterruptible,
        // Only for the call that claimed the teardown. Running it regardless
        // meant a declined call — the fallback finding its turn already gone —
        // closed and deregistered a live session without so much as a
        // `session.exited`.
        Effect.onExit(() => (claimedTeardown ? cleanupContext(ctx) : Effect.void)),
      );
    };

    const startSession: AntigravityAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: AntigravitySessionContext;

          const resumeSessionId = parseAntigravityResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const effectiveSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : antigravitySettings;

          // The model and effort are bound when the bridge spawns `agy`, so
          // they must be resolved before the runtime is constructed rather
          // than applied afterwards via session config.
          const boundModel = resolveAntigravityBaseModelId(modelSelection?.model);
          const boundEffort = resolveEffortSelection(modelSelection?.options);

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeAntigravityAcpRuntime({
            antigravitySettings: effectiveSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            model: boundModel,
            ...(boundEffort ? { effort: boundEffort } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          // With approvals enabled the bridge blocks each tool on this callback,
          // so it must be registered before `start()` — the first tool call can
          // arrive as soon as the first turn begins.
          // Not published to `approvalsByThread` yet: if startup fails there is
          // no session context for teardown to clean up, and repeated failures
          // across thread ids would grow the map. Registered after `start()`.
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          yield* acp.handleRequestPermission((params) => {
            // Held outside the workflow so the finalizer can clear the entry
            // wherever inside it things stopped.
            let registeredRequestId: ApprovalRequestId | undefined;
            // Held alongside the id so the finalizer can signal completion even
            // after the entry has been removed from the registry by settlement
            // or teardown.
            let registeredApproval: PendingApproval | undefined;
            // Set once the UI has been told a request exists. From then on it
            // is owed a terminal event: the tool is denied either way, but a
            // request left open cannot be answered or dismissed.
            let opened:
              | {
                  readonly requestId: ApprovalRequestId;
                  readonly permissionRequest: ReturnType<typeof parsePermissionRequest>;
                  readonly turnId: TurnId | undefined;
                }
              | undefined;
            let resolutionPublished = false;
            return mapAcpCallbackFailure(
              Effect.gen(function* () {
                // The bridge's own deadline is already running when this
                // workflow starts. One absolute cutoff covers both queued event
                // delivery and the user's decision, so time spent draining
                // cannot leave a request actionable after the bridge has
                // stopped accepting it.
                const approvalDeadline = (yield* Clock.currentTimeMillis) + APPROVAL_WAIT_MS;
                // Bound to the turn actually running, with the epoch that turn
                // was accepted at — not the session's current epoch. A request
                // from a cancelled turn can arrive after the epoch moved, and
                // reading the live value would make it look current.
                const approvalTurnId = ctx?.activeTurnId;
                const approvalEpoch = ctx?.activeTurnEpoch;
                const turnCancelled =
                  approvalEpoch !== undefined &&
                  ctx !== undefined &&
                  approvalEpoch !== ctx.cancelEpoch;
                // Checked before auto-approval, not after: teardown or a Stop
                // must not be waved through by full access.
                if (ctx?.stopped || turnCancelled) {
                  return { outcome: { outcome: "cancelled" } as const };
                }
                if (input.runtimeMode === "full-access") {
                  const autoApproved = selectAutoApprovedPermissionOption(params);
                  if (autoApproved !== undefined) {
                    return { outcome: { outcome: "selected" as const, optionId: autoApproved } };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                const settled = yield* Deferred.make<void>();
                const approval: PendingApproval = { decision, turnId: approvalTurnId, settled };
                pendingApprovals.set(requestId, approval);
                registeredRequestId = requestId;
                registeredApproval = approval;
                // Rechecked after registering, not only before: minting the id
                // and the deferred both yield, and a Stop landing in that gap
                // would find no entry to cancel — leaving this request open in
                // the UI and its deferred held for the full approval timeout.
                if (
                  ctx?.stopped ||
                  (approvalEpoch !== undefined &&
                    ctx !== undefined &&
                    approvalEpoch !== ctx.cancelEpoch)
                ) {
                  pendingApprovals.delete(requestId);
                  return { outcome: { outcome: "cancelled" } as const };
                }
                // The bridge sends the tool update before asking permission,
                // but the ACP runtime only queues that update. Wait until the
                // notification consumer has published everything ahead of this
                // barrier so the request cannot overtake the tool call it
                // belongs to. Teardown wins the race when that consumer is no
                // longer available, which keeps a stopped session from holding
                // the hook callback forever.
                const drained = yield* Effect.raceFirst(
                  ctx.acp.drainEvents.pipe(Effect.as(true)),
                  Deferred.await(ctx.teardownSignal).pipe(Effect.as(false)),
                ).pipe(
                  Effect.timeoutOption(
                    Math.max(0, approvalDeadline - (yield* Clock.currentTimeMillis)),
                  ),
                );
                const eventStreamDrained = Option.isSome(drained) && drained.value;
                // Rechecked by turn identity, not only by epoch. A turn that
                // ends on its own — `agy` exiting, or its print timeout — moves
                // no epoch, so a request that waited out a slow consumer would
                // open here against a turn settlement had already completed and
                // then resolve it immediately afterwards.
                if (
                  !eventStreamDrained ||
                  ctx.stopped ||
                  ctx.activeTurnId !== approvalTurnId ||
                  (approvalEpoch !== undefined && approvalEpoch !== ctx.cancelEpoch)
                ) {
                  pendingApprovals.delete(requestId);
                  return { outcome: { outcome: "cancelled" } as const };
                }
                // Built first, then published and recorded in one uninterruptible
                // step. An interrupt between the two would leave the UI showing
                // a request the finalizer does not know to close.
                const openedEvent = makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: approvalTurnId,
                  requestId: RuntimeRequestId.make(requestId),
                  permissionRequest,
                  detail: permissionRequest.detail ?? "Antigravity tool call",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                });
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* offerRuntimeEvent(openedEvent);
                    opened = { requestId, permissionRequest, turnId: approvalTurnId };
                  }),
                );
                // Raced against a deadline and cleaned up unconditionally: the
                // bridge forgets its side of a timed-out request, so without
                // this the handler would stay blocked and the entry retained.
                const answered = yield* Deferred.await(decision).pipe(
                  Effect.timeoutOption(
                    Math.max(0, approvalDeadline - (yield* Clock.currentTimeMillis)),
                  ),
                );
                // An unanswered request denies, matching the bridge's own
                // timeout: this gate must never resolve to "allow" by default.
                const resolved: ProviderApprovalDecision = Option.isSome(answered)
                  ? answered.value
                  : "cancel";
                // Re-checked at the moment of answering: an approval decided
                // while Stop was landing must not come back as an allow.
                //
                // Turn identity is part of that check, not just the epoch. Two
                // consecutive turns with no cancel between them share an epoch,
                // so a request still open when its own turn ended would look
                // current again once the next one started, and this would
                // answer "allow" for a tool whose token the bridge has already
                // retired.
                // A defined turn on both sides is required, not just equality:
                // a request that arrived with no turn running compared
                // `undefined === undefined` against a session whose turn had
                // already been cleared, and passed.
                const stillLive =
                  !ctx?.stopped &&
                  approvalTurnId !== undefined &&
                  ctx?.activeTurnId === approvalTurnId &&
                  (approvalEpoch === undefined || ctx?.cancelEpoch === approvalEpoch);
                const optionId =
                  resolved === "cancel" || !stillLive
                    ? undefined
                    : selectPermissionOptionId(params, resolved);
                // Decided before the event is built, so what the UI is told and
                // what the agent is told are the same thing. Publishing the
                // user's raw answer here reported an approval that the liveness
                // check had already turned into a cancellation — the tool did
                // not run, and the transcript claimed it was allowed to.
                const effective: ProviderApprovalDecision = optionId ? resolved : "cancel";
                // Same pairing on the way out: an interrupt between publishing
                // this and recording it would have the finalizer publish a
                // second, contradictory resolution.
                const resolvedEvent = makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: approvalTurnId,
                  requestId: RuntimeRequestId.make(requestId),
                  permissionRequest,
                  decision: effective,
                });
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* offerRuntimeEvent(resolvedEvent);
                    resolutionPublished = true;
                  }),
                );
                return {
                  outcome: optionId
                    ? { outcome: "selected" as const, optionId }
                    : ({ outcome: "cancelled" } as const),
                };
              }).pipe(
                // Covers everything after the entry was registered, not just
                // the wait: a failure while stamping or publishing either event
                // would otherwise leave the entry in the map for good, and the
                // request open in the UI with nothing able to answer it.
                Effect.ensuring(
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      // A request the UI has seen but never got a resolution
                      // for would sit there permanently, unanswerable. The tool
                      // is denied regardless; this closes the request out.
                      if (opened !== undefined && !resolutionPublished) {
                        const closing = opened;
                        yield* Effect.ignore(
                          Effect.gen(function* () {
                            yield* offerRuntimeEvent(
                              makeAcpRequestResolvedEvent({
                                stamp: yield* makeEventStamp(),
                                provider: PROVIDER,
                                threadId: input.threadId,
                                turnId: closing.turnId,
                                requestId: RuntimeRequestId.make(closing.requestId),
                                permissionRequest: closing.permissionRequest,
                                decision: "cancel",
                              }),
                            );
                          }),
                        );
                      }
                      if (registeredRequestId !== undefined) {
                        pendingApprovals.delete(registeredRequestId);
                      }
                      // Completed from the entry captured at registration, not
                      // from a fresh map lookup. Settlement and teardown both
                      // remove entries before this finalizer runs, so looking it
                      // up here found nothing and left every waiter to time out.
                      // This handler owns the signal; the map is only a registry.
                      if (registeredApproval !== undefined) {
                        yield* Effect.ignore(
                          Deferred.succeed(registeredApproval.settled, undefined),
                        );
                      }
                    }),
                  ),
                ),
              ),
            );
          });

          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: boundModel,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: ANTIGRAVITY_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            turns: [],
            activeTurnId: undefined,
            currentModelId: boundModel,
            cancelEpoch: 0,
            reservedTurnIds: new Set(),
            publishedTurnIds: new Set(),
            promptGate: yield* Semaphore.make(1),
            lifecycleGate: yield* Semaphore.make(1),
            teardownSignal: yield* Deferred.make<void>(),
            approvals: pendingApprovals,
            acpSessionId: started.sessionId,
            activeTurnEpoch: -1,
            awaitingBridgeAck: new Set(),
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  // The bridge never changes modes; print mode has none.
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }).pipe(
                // Per event, not around the whole stream. Catching outside the
                // drain meant one unprocessable notification ended the consumer
                // for good: every later event was lost, and the turn events
                // that depend on it stopped being attributed even though
                // prompts kept completing.
                Effect.catchCause((cause) =>
                  // Interrupts pass through. Swallowing them kept this fiber
                  // alive through teardown, so `Fiber.interrupt` waited on a
                  // consumer that had been told to stop and would not —
                  // stranding the session and its bridge.
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logError("Failed to process Antigravity runtime notification.", {
                        cause,
                      }),
                ),
              ),
            ),
          ).pipe(
            // Absorbs a typed failure that escapes the per-event handler while
            // leaving interruption alone — `Effect.catch` does not catch it —
            // so teardown can still stop this fiber.
            Effect.catch(() => Effect.void),
            // However this consumer ends — teardown, a defect while stamping,
            // an interrupt — it fires the same signal drains wait on. Without
            // it a consumer that died on its own would leave every later drain
            // queuing a barrier nobody can acknowledge, hanging `sendTurn`
            // while it holds the prompt gate.
            Effect.onExit(() => Effect.ignore(Deferred.succeed(ctx.teardownSignal, undefined))),
            // Forked into the session's own scope, not the calling fiber's.
            // `startSession` can run inside a short-lived request fiber, and a
            // child fork would die with it while the session and its bridge
            // live on — taking every future event with it, and now also
            // tripping the signal above so drains stop waiting.
            Effect.forkIn(sessionScope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          // Published only now: teardown finds pending approvals through the
          // session context, so registering earlier would leak the entry if
          // startup were interrupted before the session existed.
          approvalsByThread.set(input.threadId, pendingApprovals);
          sessionScopeTransferred = true;

          // Past this point the scoped finalizer no longer owns the scope, so
          // a failure or interrupt while announcing the session would strand
          // the bridge process, its notification fiber, and both registry
          // entries with nothing left to close them. Ownership has moved to
          // the session, so teardown has to move with it.
          yield* Effect.onError(
            Effect.gen(function* () {
              yield* offerRuntimeEvent({
                type: "session.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { resume: started.initializeResult },
              });
              yield* offerRuntimeEvent({
                type: "session.state.changed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { state: "ready", reason: "Antigravity ACP session ready" },
              });
              yield* offerRuntimeEvent({
                type: "thread.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { providerThreadId: started.sessionId },
              });
            }),
            () => Effect.ignore(stopSessionInternal(ctx)),
          );

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // Read before any yielding preparation. Attachment resolution and id
        // generation both yield, and a Stop landing in that window raises the
        // cancelled mark past this value — so the prompt is still covered by
        // the fence even though it had not been submitted yet.
        const acceptedEpoch = ctx.cancelEpoch;

        // `agy --print` takes a single text prompt, so attachments travel as
        // `resource_link` blocks (ACP baseline, no capability needed) pointing
        // at the files the attachment store already wrote to disk. The bridge
        // renders those paths into the prompt and grants `agy` read access to
        // stages just those files into a per-turn directory it can grant `agy`
        // access to. Nothing is re-encoded.
        //
        // This runs before any `turn.started` is offered — a rejected prompt
        // that had already announced a turn would leave the UI with one that
        // never completes.
        const text = input.input?.trim();
        const attachmentParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            return {
              type: "resource_link",
              // `pathToFileURL` rather than hand-built escaping: it handles
              // Windows drive letters and escapes `#`/`?`, which would
              // otherwise truncate the path when the bridge parses it back.
              uri: attachmentFileUrl(attachmentPath),
              name: path.basename(attachmentPath),
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
            } satisfies EffectAcpSchema.ContentBlock;
          }),
        );
        const promptParts: Array<EffectAcpSchema.ContentBlock> = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...attachmentParts,
        ];
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const freshTurnId = TurnId.make(yield* randomUUIDv4);

        // The submission gate is taken before the turn is claimed, not after.
        //
        // Claiming outside it let two turns exist at once — a prompt sent after
        // a Stop opened its own while the cancelled one was still settling —
        // and everything that reads "the current turn" then has to guess which
        // one it means: streamed events, permission requests, the epoch a
        // decision is checked against. Guarding each of those in turn produced
        // a new mismatch every time. Inside the gate there is exactly one live
        // turn, so there is nothing to disambiguate.
        //
        // This costs nothing in practice: `acp.prompt` already serializes on
        // its own semaphore, so a second prompt could never reach `agy` early
        // anyway — only its bookkeeping ran ahead.
        return yield* ctx.promptGate.withPermit(
          Effect.gen(function* () {
            // Rechecked with the gate held and before any turn state is
            // touched. Waiting for the gate is exactly when a Stop can land.
            if (ctx.stopped || ctx.cancelEpoch !== acceptedEpoch) {
              return {
                threadId: input.threadId,
                turnId: freshTurnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }
            // Each prompt is its own turn. Steering used to fold a second
            // prompt into a running turn, but `agy --print` cannot inject into
            // a running invocation — the second prompt always became its own
            // `agy` process, and the merge existed only in the bookkeeping.
            // Holding the gate makes that explicit: by the time this runs, any
            // earlier prompt has already settled.
            const turnId = freshTurnId;
            ctx.activeTurnId = turnId;
            ctx.activeTurnEpoch = acceptedEpoch;
            let stopReason: string | null = null;
            let promptSucceeded = false;

            return yield* Effect.gen(function* () {
              ctx.session = {
                ...ctx.session,
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
              };

              // `agy` binds the model with a `--model` flag on each spawn, and that
              // flag composes with `--conversation` — verified against the CLI: a
              // resumed conversation answers on the new model with its history
              // intact. Applied before `turn.started` so the announced model is the
              // one the turn actually runs on.
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedModelId = turnModelSelection?.model
                ? resolveAntigravityBaseModelId(turnModelSelection.model)
                : undefined;
              if (requestedModelId !== undefined && requestedModelId !== ctx.currentModelId) {
                yield* ctx.acp
                  .setSessionModel(requestedModelId)
                  .pipe(
                    Effect.mapError((cause) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
                    ),
                  );
                ctx.currentModelId = requestedModelId;
                ctx.session = {
                  ...ctx.session,
                  model: turnModelSelection?.model ?? ctx.session.model,
                };
              }

              // Rechecked before anything is announced: everything above yields, so
              // the session can be stopped or the turn interrupted while
              // attachments resolve and the model is selected. Announcing a turn
              // on a closed runtime would emit events after `session.exited`.
              if (ctx.cancelEpoch !== acceptedEpoch || ctx.stopped) {
                stopReason = "cancelled";
                return {
                  threadId: input.threadId,
                  turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              // Claimed from shared state, not from "am I a steer": the prompt this
              // one folded into may have failed before it announced anything, and
              // emitting content for a turn that never started strands the UI.
              //
              // Test and claim are one synchronous step — publishing first and
              // marking afterwards let two concurrent steers both find the turn
              // unannounced and emit `turn.started` twice. The claim is released
              // again if publication does not happen, so a turn nobody saw start
              // cannot later be completed.
              // Reservation is taken under the lifecycle gate so teardown cannot
              // snapshot between the check and the claim.
              const announcing = yield* ctx.lifecycleGate.withPermit(
                Effect.sync(() => {
                  if (ctx.stopped || ctx.reservedTurnIds.has(turnId)) {
                    return false;
                  }
                  ctx.reservedTurnIds.add(turnId);
                  return true;
                }),
              );
              if (announcing) {
                // Stamp generation sits inside the guarded region: it can fail or
                // be interrupted too, and a claim left behind without its event
                // would make a steer skip the start and let settlement publish an
                // orphan completion.
                yield* ctx.lifecycleGate
                  .withPermit(
                    Effect.gen(function* () {
                      // Re-checked inside the gate: teardown may have run while
                      // this fiber waited for it, and a start published after
                      // `session.exited` is worse than no start at all.
                      if (ctx.stopped) {
                        return;
                      }
                      const startedEvent = {
                        type: "turn.started" as const,
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        payload: { model: ctx.session.model },
                      };
                      // Published and recorded together. Marking only after the
                      // event is out keeps teardown from completing a turn that
                      // was merely reserved — but an interrupt between the two
                      // would drop the reservation with the start already on
                      // the wire, and settlement would owe a completion it did
                      // not know about.
                      yield* Effect.uninterruptible(
                        Effect.gen(function* () {
                          yield* offerRuntimeEvent(startedEvent);
                          ctx.publishedTurnIds.add(turnId);
                        }),
                      );
                    }),
                  )
                  .pipe(
                    Effect.onExit((exit) =>
                      Exit.isSuccess(exit)
                        ? Effect.void
                        : Effect.sync(() => ctx.reservedTurnIds.delete(turnId)),
                    ),
                  );
              }

              const result = yield* Effect.gen(function* () {
                if (ctx.cancelEpoch !== acceptedEpoch || ctx.stopped) {
                  return undefined;
                }
                // The bridge writes its `session/update` notifications before
                // the prompt response, but the runtime only queues them.
                // Draining inside the gate keeps the turn from settling — and
                // its id from being cleared — while content, tool and item
                // events are still pending, which would leave them
                // unattributed or attributed to the next turn.
                //
                // Bounded and best-effort: the drain waits on the notification
                // consumer, and stop interrupts that consumer, so an unbounded
                // wait here would strand this fiber holding the gate forever.
                // Losing the ordering guarantee is recoverable; a permanent
                // hang is not. The error path drains too — a nonzero `agy`
                // exit still emits final updates before its response.
                // Raced against teardown rather than a wall clock: a slow but
                // healthy consumer is still awaited in full, while a consumer
                // that stop has interrupted can never strand this fiber
                // holding the gate.
                const drain = Effect.ignore(
                  Effect.raceFirst(ctx.acp.drainEvents, Deferred.await(ctx.teardownSignal)),
                );
                ctx.awaitingBridgeAck.add(turnId);
                return yield* ctx.acp
                  .prompt({ prompt: promptParts, _meta: { t3: { epoch: acceptedEpoch } } })
                  .pipe(
                    // Cleared the moment the bridge answers, before draining:
                    // the drain is the part that can legitimately run long, and
                    // the fallback must not read that as an unresponsive bridge.
                    Effect.tapCause(() => Effect.sync(() => ctx.awaitingBridgeAck.delete(turnId))),
                    Effect.tap(() => Effect.sync(() => ctx.awaitingBridgeAck.delete(turnId))),
                    Effect.tapCause(() => drain),
                    Effect.tap(() => drain),
                    Effect.ensuring(Effect.sync(() => ctx.awaitingBridgeAck.delete(turnId))),
                  );
              }).pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
              );
              if (result === undefined) {
                stopReason = "cancelled";
                return {
                  threadId: input.threadId,
                  turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
              if (turnRecord) {
                turnRecord.items.push({ prompt: promptParts, result });
              } else {
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
              }
              ctx.session = {
                ...ctx.session,
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
              };

              promptSucceeded = true;
              stopReason = result.stopReason ?? null;

              return {
                threadId: input.threadId,
                turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }).pipe(
              Effect.ensuring(
                // Settlement takes the same gate teardown does. It clears the
                // published claim and then yields to stamp and publish; without
                // the gate, a concurrent stop could see an empty set, decide it
                // owed nothing, emit `session.exited`, and have this completion
                // arrive after it. Whichever takes the gate first owns the
                // terminal event, and the other finds nothing to publish.
                ctx.lifecycleGate
                  .withPermit(
                    Effect.gen(function* () {
                      // Anything this turn opened and never got an answer for is
                      // released here. `agy` dying with a hook mid-approval used
                      // to leave the request sitting in the UI for the full nine
                      // minute deadline, unanswerable, with the turn already
                      // reported complete.
                      //
                      // `activeTurnId` is also the approval handler's liveness
                      // check. Clear the internal claim before releasing any
                      // decisions so an accept racing this settlement is
                      // reported as cancelled, matching the bridge token that
                      // has already been retired. The public session claim is
                      // kept until the terminal bookkeeping below; nothing in
                      // the approval wait depends on the internal claim.
                      if (ctx.activeTurnId === turnId) {
                        ctx.activeTurnId = undefined;
                      }
                      const orphanedApprovals = [...ctx.approvals.values()].filter(
                        (approval) => approval.turnId === turnId,
                      );
                      for (const approval of orphanedApprovals) {
                        yield* Effect.ignore(Deferred.succeed(approval.decision, "cancel"));
                      }
                      // Entries are left in place: each handler removes its own
                      // on the way out. Removing them here left the finalizers
                      // with nothing to look up, so nothing ever signalled and
                      // every wait below ran its deadline out in full.
                      //
                      // Awaited together under a single budget rather than one
                      // deadline each, so a turn with several open requests
                      // cannot hold the lifecycle gate for a multiple of it.
                      if (orphanedApprovals.length > 0) {
                        yield* Effect.ignore(
                          Effect.all(
                            orphanedApprovals.map((approval) => Deferred.await(approval.settled)),
                            { concurrency: "unbounded" },
                          ).pipe(Effect.timeoutOption(APPROVAL_SETTLE_TIMEOUT_MS)),
                        );
                      }
                      // Read from shared state rather than this call's local flag: the
                      // prompt that published `turn.started` may not be the one that
                      // settles the turn, and the settler still owes the completion.
                      const published = ctx.publishedTurnIds.has(turnId);
                      ctx.reservedTurnIds.delete(turnId);
                      // The public session field is what `listSessions` and the reaper
                      // read, so leaving it set would advertise a turn that has ended.
                      if (ctx.session.activeTurnId === turnId) {
                        const { activeTurnId: _endedTurnId, ...endedSession } = ctx.session;
                        ctx.session = {
                          ...endedSession,
                          status: "ready",
                          updatedAt: yield* nowIso,
                        };
                      }
                      // A prompt that failed or was interrupted after `turn.started`
                      // still owes consumers a terminal event; without one the turn
                      // renders as running forever even though sendTurn already
                      // returned an error.
                      if (!published) {
                        ctx.publishedTurnIds.delete(turnId);
                        return;
                      }
                      const state: "cancelled" | "completed" | "failed" =
                        stopReason === "cancelled"
                          ? "cancelled"
                          : promptSucceeded
                            ? "completed"
                            : "failed";
                      // The claim is surrendered only once the event is built
                      // and published. Releasing it first meant a failure while
                      // stamping — which mints a UUID — left teardown seeing no
                      // published turn, so nothing ever reported the turn ending.
                      const completedEvent = {
                        type: "turn.completed" as const,
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        payload: { state, stopReason },
                      };
                      yield* Effect.uninterruptible(
                        Effect.gen(function* () {
                          yield* offerRuntimeEvent(completedEvent);
                          ctx.publishedTurnIds.delete(turnId);
                        }),
                      );
                      // `catchCause` rather than `catch`: a defect while stamping or
                      // publishing would otherwise escape after the turn's prompt count
                      // was already decremented, stranding the turn as running.
                    }),
                  )
                  .pipe(Effect.catchCause(() => Effect.void)),
              ),
            );
          }),
        );
      });

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // Uninterruptible as a whole. The epoch moves first, so an interrupt
        // partway would leave prompts refused against a fence the bridge never
        // received — `agy` running on after Stop with nothing left to tell it.
        yield* Effect.uninterruptible(cancelSequence(ctx));
      });

    const cancelSequence = (ctx: AntigravitySessionContext) =>
      Effect.gen(function* () {
        // `requireSession` yields its context to the caller, so a concurrent
        // restart can replace it before this effect begins. A stale interrupt
        // must not cancel either the old process or approvals owned by the new
        // session now registered for the same thread.
        if (sessions.get(ctx.threadId) !== ctx) {
          return;
        }
        // Recorded before anything else: prompts already accepted but still
        // queued upstream compare against this and refuse to submit.
        // Read and bumped in one synchronous step: everything accepted up to
        // and including this value is what the fence below covers.
        const cancelledThrough = ctx.cancelEpoch;
        // Captured in the same synchronous step as the epoch, before anything
        // yields. Reading it later would name whichever turn happened to be
        // active by then — the cancelled one can finish and a new one acquire
        // the gate while approvals are settled and notifications are written.
        const cancelledTurnId = ctx.activeTurnId;
        ctx.cancelEpoch += 1;
        // Settled before the cancel goes out, as ACP requires: an outstanding
        // permission request has a hook process blocked behind it, and the
        // bridge turns "cancel" into a denial. Leaving it pending would hold
        // that tool until the hook's own timeout.
        for (const [, approval] of ctx.approvals) {
          yield* Effect.ignore(Deferred.succeed(approval.decision, "cancel"));
        }
        // The fence names the epoch being cancelled through, rather than one
        // notification per outstanding prompt. Everything accepted at or below
        // it is cancelled; anything accepted afterwards carries a higher epoch
        // and is untouched, so nothing has to be tracked per prompt.
        yield* Effect.ignore(
          ctx.acp.notify("t3/fence", { sessionId: ctx.acpSessionId, epoch: cancelledThrough }),
        );
        // Sent as a plain notification rather than through `acp.cancel`, which
        // interrupts the local prompt RPC. That interrupt settles the turn and
        // releases the gate before the bridge has killed `agy` and run its
        // final drain, so the transcript and failed-tool updates that drain
        // produces arrive with no turn to belong to. Delivered this way the
        // bridge answers the original prompt itself, after its updates are on
        // the wire, and the turn settles on that response.
        // Carries the epoch it cancels, so it is bounded to the same turns the
        // fence covers even if the fence itself never arrived.
        yield* Effect.ignore(
          ctx.acp.notify("session/cancel", {
            sessionId: ctx.acpSessionId,
            epoch: cancelledThrough,
          }),
        );
        // Fallback: if the bridge never answers — wedged, or already gone — the
        // interrupt still happens, just late enough not to truncate a healthy
        // drain. Forked into the session scope so it dies with the session.
        //
        // Scoped to the turn being cancelled by identity, not to "some turn is
        // active". This cancel can settle normally and a fresh turn start
        // inside the timeout; `acp.cancel` interrupts whatever prompt the
        // runtime currently holds, so a laxer check would interrupt that new
        // turn — and the bridge would ignore the accompanying cancel, its
        // epoch being newer than this fence, leaving `agy` running while T3
        // believed the turn was cancelled.
        if (cancelledTurnId !== undefined) {
          yield* Effect.forkIn(
            Effect.sleep(CANCEL_ACK_TIMEOUT_MS).pipe(
              Effect.flatMap(() =>
                // Still running this long after a cancel means the bridge is
                // not processing notifications. Interrupting the RPC alone
                // would settle the turn here while a detached `agy` kept
                // running tools, so the session goes instead: closing its scope
                // ends the bridge process, whose own exit handler kills the
                // `agy` process group.
                //
                // The turn is named rather than checked here: this fiber woke
                // ten seconds late, and the check has to happen under the same
                // gate that claims the stop or a turn that settled meanwhile
                // takes its replacement down with it.
                Effect.ignore(
                  stopSessionInternal(ctx, cancelledTurnId, () =>
                    ctx.awaitingBridgeAck.has(cancelledTurnId),
                  ),
                ),
              ),
            ),
            adapterScope,
          );
        }
      });

    // `agy` itself always runs with permissions skipped — print mode cannot
    // prompt — so when approvals are enabled the bridge's PreToolUse hook is
    // the gate, and this resolves the decision it is blocked on.
    const respondToRequest: AntigravityAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        const pending = approvalsByThread.get(threadId)?.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/user_input",
          detail: `Antigravity print mode cannot ask questions; unknown request: ${requestId}`,
        });
      });

    const readThread: AntigravityAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        // Truncating the local turn list would report success while leaving the
        // Antigravity trajectory untouched: the next turn resumes the same
        // `--conversation` and still sees the rolled-back exchanges, so the
        // model would answer from history the user believes is gone. Print mode
        // exposes no rewind primitive, so this fails loudly instead.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Antigravity conversations do not support provider-side rollback.",
        });
      });

    const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: AntigravityAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AntigravityAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    // Snapshotted, not iterated live: teardown deletes from this map, and a
    // concurrent `startSession` can install a replacement mid-sweep.
    // Each teardown runs under the thread lock, so a sweep cannot interleave
    // with a `startSession` installing a replacement for the same thread.
    const stopSwept = (ctx: AntigravitySessionContext) =>
      withThreadLock(ctx.threadId, stopSessionInternal(ctx));

    const stopAll: AntigravityAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSwept, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSwept, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Antigravity session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      // `agy --model` is applied when the bridge spawns the CLI, so switching
      // models mid-session is not possible.
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies AntigravityAdapterShape;
  });
}

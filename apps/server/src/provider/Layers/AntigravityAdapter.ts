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
 * Deliberately longer than the bridge's own wait: the bridge denies first and
 * the blocked hook is released by that, so this only exists to stop an
 * unanswered request pinning its entry and its UI prompt forever.
 */
const APPROVAL_WAIT_MS = 11 * 60 * 1000;
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
   * Turns for which `turn.started` has actually been published. Shared rather
   * than per-call, so a steer cannot assume the prompt it folded into already
   * announced the turn — that prompt may have failed during preflight.
   */
  readonly startedTurnIds: Set<TurnId>;
  /**
   * Number of prompts in flight. >0 means a turn is running, so a new
   * sendTurn steers the existing turn rather than opening a new one.
   */
  promptsInFlight: number;
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

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
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

    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    /**
     * Approvals awaiting a user decision, per thread. Held outside the session
     * context because the permission callback is registered before the context
     * exists, and `respondToRequest` resolves entries from a different call.
     */
    const approvalsByThread = new Map<ThreadId, Map<ApprovalRequestId, PendingApproval>>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
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

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

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

    const stopSessionInternal = (ctx: AntigravitySessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        // Anything still waiting on a human is cancelled, which the bridge
        // turns into a denial. Left pending, the hook would block its tool
        // until its own timeout with no one able to answer.
        const pending = approvalsByThread.get(ctx.threadId);
        if (pending) {
          for (const [, approval] of pending) {
            // Ignored: an answer racing session stop may have settled this
            // already, and that must not abort the rest of teardown.
            yield* Effect.ignore(Deferred.succeed(approval.decision, "cancel"));
          }
          approvalsByThread.delete(ctx.threadId);
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

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
          yield* acp.handleRequestPermission((params) =>
            mapAcpCallbackFailure(
              Effect.gen(function* () {
                if (input.runtimeMode === "full-access") {
                  const autoApproved = selectAutoApprovedPermissionOption(params);
                  if (autoApproved !== undefined) {
                    return { outcome: { outcome: "selected" as const, optionId: autoApproved } };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                const turnId = sessions.get(input.threadId)?.activeTurnId;
                pendingApprovals.set(requestId, { decision });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: RuntimeRequestId.make(requestId),
                    permissionRequest,
                    detail: permissionRequest.detail ?? "Antigravity tool call",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                // Raced against a deadline and cleaned up unconditionally: the
                // bridge forgets its side of a timed-out request, so without
                // this the handler would stay blocked and the entry retained.
                const answered = yield* Deferred.await(decision).pipe(
                  Effect.timeoutOption(APPROVAL_WAIT_MS),
                  Effect.ensuring(Effect.sync(() => pendingApprovals.delete(requestId))),
                );
                // An unanswered request denies, matching the bridge's own
                // timeout: this gate must never resolve to "allow" by default.
                const resolved: ProviderApprovalDecision = Option.isSome(answered)
                  ? answered.value
                  : "cancel";
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: RuntimeRequestId.make(requestId),
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const optionId =
                  resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                return {
                  outcome: optionId
                    ? { outcome: "selected" as const, optionId }
                    : ({ outcome: "cancelled" } as const),
                };
              }),
            ),
          );

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
            startedTurnIds: new Set(),
            promptsInFlight: 0,
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
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Antigravity runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          // Published only now: teardown finds pending approvals through the
          // session context, so registering earlier would leak the entry if
          // startup were interrupted before the session existed.
          approvalsByThread.set(input.threadId, pendingApprovals);
          sessionScopeTransferred = true;

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

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);

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

        // A sendTurn while a prompt is in flight is a steer: the new prompt
        // folds into the ongoing work, so the active turn id is reused.
        //
        // The id is minted first, before anything is read, so that reading
        // `promptsInFlight` and claiming it are one synchronous step. Yielding
        // between the two — which generating the id here used to do — let two
        // concurrent calls both observe zero and open rival turns over the
        // same thread.
        const freshTurnId = TurnId.make(yield* randomUUIDv4);
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? freshTurnId;
        const acceptedEpoch = ctx.cancelEpoch;
        // Claimed together, without an intervening yield: assigning the active
        // turn id later let a concurrent call see `promptsInFlight > 0` with no
        // id yet and open a rival turn.
        ctx.promptsInFlight += 1;
        ctx.activeTurnId = turnId;
        // Terminal-event bookkeeping. Publication happens in exactly one place
        // (the teardown below) so that the decision cannot race a steer.
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
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
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
            ctx.session = { ...ctx.session, model: turnModelSelection?.model ?? ctx.session.model };
          }

          // Claimed from shared state, not from "am I a steer": the prompt this
          // one folded into may have failed before it announced anything, and
          // emitting content for a turn that never started strands the UI.
          if (!ctx.startedTurnIds.has(turnId)) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: ctx.session.model },
            });
            // Marked only after the event is actually out, so a failed publish
            // cannot let another prompt emit a completion for a turn nobody
            // saw start.
            ctx.startedTurnIds.add(turnId);
          }
          // Rechecked here rather than only at accept time: everything above
          // yields, and an interrupt during any of it means this prompt must
          // not reach the agent.
          if (ctx.cancelEpoch !== acceptedEpoch) {
            stopReason = "cancelled";
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }

          const result = yield* ctx.acp
            .prompt({ prompt: promptParts })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

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
            Effect.gen(function* () {
              // Decrement and the last-prompt test are one synchronous step, so
              // a steer arriving mid-settlement cannot make two prompts both
              // believe they own the turn and publish a terminal event each.
              const remaining = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remaining;
              if (remaining > 0) {
                return;
              }
              // Cleared even when the turn never started — a model switch can
              // fail after `activeTurnId` is installed, and leaving it set
              // advertises a turn to `listSessions` and the reaper that no
              // longer exists. Only the event below depends on having started.
              if (ctx.activeTurnId === turnId) {
                ctx.activeTurnId = undefined;
              }
              // Read from shared state rather than this call's local flag: the
              // prompt that published `turn.started` may not be the one that
              // settles the turn, and the settler still owes the completion.
              const published = ctx.startedTurnIds.has(turnId);
              ctx.startedTurnIds.delete(turnId);
              // The public session field is what `listSessions` and the reaper
              // read, so leaving it set would advertise a turn that has ended.
              if (ctx.session.activeTurnId === turnId) {
                const { activeTurnId: _endedTurnId, ...endedSession } = ctx.session;
                ctx.session = { ...endedSession, status: "ready", updatedAt: yield* nowIso };
              }
              // A prompt that failed or was interrupted after `turn.started`
              // still owes consumers a terminal event; without one the turn
              // renders as running forever even though sendTurn already
              // returned an error.
              if (!published) {
                return;
              }
              const state =
                stopReason === "cancelled" ? "cancelled" : promptSucceeded ? "completed" : "failed";
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { state, stopReason },
              });
              // `catchCause` rather than `catch`: a defect while stamping or
              // publishing would otherwise escape after `promptsInFlight` was
              // already decremented, stranding the turn as running.
            }).pipe(Effect.catchCause(() => Effect.void)),
          ),
        );
      });

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // Recorded before anything else: prompts already accepted but still
        // queued upstream compare against this and refuse to submit.
        ctx.cancelEpoch += 1;
        // Settled before the cancel goes out, as ACP requires: an outstanding
        // permission request has a hook process blocked behind it, and the
        // bridge turns "cancel" into a denial. Leaving it pending would hold
        // that tool until the hook's own timeout.
        const pending = approvalsByThread.get(threadId);
        if (pending) {
          for (const [, approval] of pending) {
            yield* Effect.ignore(Deferred.succeed(approval.decision, "cancel"));
          }
          pending.clear();
        }
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
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

    const stopAll: AntigravityAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
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

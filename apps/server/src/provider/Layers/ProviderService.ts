/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern) and does
 * not implement checkpoint persistence mechanics (checkpointing concern).
 *
 * @module ProviderServiceLive
 */
import { randomUUID } from "node:crypto";

import {
  providerGetCheckpointDiffInputSchema,
  providerInterruptTurnInputSchema,
  providerListCheckpointsInputSchema,
  providerRespondToRequestInputSchema,
  providerRevertToCheckpointInputSchema,
  providerSendTurnInputSchema,
  providerSessionStartInputSchema,
  providerStopSessionInputSchema,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnCompletedEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Queue, Ref, Stream } from "effect";

import { CheckpointService } from "../../checkpointing/Services/CheckpointService.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
}

function toCheckpointCaptureErrorEvent(
  event: ProviderRuntimeTurnCompletedEvent,
  error: { readonly message: string },
): ProviderRuntimeEvent {
  return {
    type: "runtime.error",
    eventId: randomUUID(),
    provider: event.provider,
    sessionId: event.sessionId,
    createdAt: new Date().toISOString(),
    ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    message: error.message,
  };
}

function toCheckpointCapturedEvent(input: {
  readonly event: ProviderRuntimeTurnCompletedEvent;
  readonly threadId: string;
  readonly turnCount: number;
}): ProviderRuntimeEvent {
  const { event, threadId, turnCount } = input;
  return {
    type: "checkpoint.captured",
    eventId: randomUUID(),
    provider: event.provider,
    sessionId: event.sessionId,
    createdAt: new Date().toISOString(),
    threadId,
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    turnCount,
    ...(event.status !== undefined ? { status: event.status } : {}),
  };
}

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const canonicalEventLogger =
      options?.canonicalEventLogPath !== undefined
        ? makeEventNdjsonLogger(options.canonicalEventLogPath)
        : undefined;

    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    const checkpointService = yield* CheckpointService;

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const routedSessionAliasesRef = yield* Ref.make<Map<string, string>>(new Map());

    const canonicalizeRuntimeEventSession = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<ProviderRuntimeEvent> =>
      Ref.get(routedSessionAliasesRef).pipe(
        Effect.map((aliases) => {
          for (const [staleSessionId, liveSessionId] of aliases) {
            if (liveSessionId === event.sessionId) {
              return {
                ...event,
                sessionId: staleSessionId,
              } satisfies ProviderRuntimeEvent;
            }
          }
          return event;
        }),
      );

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      canonicalizeRuntimeEventSession(event).pipe(
        Effect.tap((canonicalEvent) =>
          Effect.sync(() => {
            canonicalEventLogger?.write({
              observedAt: new Date().toISOString(),
              event: canonicalEvent,
            });
          }),
        ),
        Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
        Effect.asVoid,
      );

    const upsertSessionBinding = (
      session: ProviderSession,
      operation: string,
    ) =>
      Effect.gen(function* () {
        const threadId = session.threadId?.trim();
        if (!threadId) {
          return yield* toValidationError(
            operation,
            `Provider '${session.provider}' returned a session without threadId. threadId is required for checkpoint initialization.`,
          );
        }

        yield* directory.upsert({
          sessionId: session.sessionId,
          provider: session.provider,
          threadId,
        });

        return threadId;
      });

    const clearAliasKey = (staleSessionId: string) =>
      Ref.update(routedSessionAliasesRef, (current) => {
        if (!current.has(staleSessionId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(staleSessionId);
        return next;
      });

    const clearAliasesReferencing = (sessionId: string) =>
      Ref.update(routedSessionAliasesRef, (current) => {
        let changed = false;
        const next = new Map<string, string>();
        for (const [key, value] of current) {
          if (key === sessionId || value === sessionId) {
            changed = true;
            continue;
          }
          next.set(key, value);
        }
        return changed ? next : current;
      });

    const setAlias = (staleSessionId: string, liveSessionId: string) =>
      Ref.update(routedSessionAliasesRef, (current) => {
        const existing = current.get(staleSessionId);
        if (existing === liveSessionId) {
          return current;
        }
        const next = new Map(current);
        next.set(staleSessionId, liveSessionId);
        return next;
      });

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) =>
      registry.getByProvider(provider),
    );

    const onTurnCompleted = (event: ProviderRuntimeTurnCompletedEvent): Effect.Effect<void> =>
      checkpointService
        .captureCurrentTurn({
          providerSessionId: event.sessionId,
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          ...(event.status !== undefined ? { status: event.status } : {}),
        })
        .pipe(
          Effect.flatMap(() => checkpointService.listCheckpoints({ sessionId: event.sessionId })),
          Effect.flatMap((result) => {
            const currentCheckpoint =
              result.checkpoints.find((checkpoint) => checkpoint.isCurrent) ??
              result.checkpoints[result.checkpoints.length - 1];
            if (!currentCheckpoint) {
              return Effect.void;
            }

            return publishRuntimeEvent(
              toCheckpointCapturedEvent({
                event,
                threadId: result.threadId,
                turnCount: currentCheckpoint.turnCount,
              }),
            );
          }),
          Effect.catch((error) => publishRuntimeEvent(toCheckpointCaptureErrorEvent(event, error))),
        );

    const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      publishRuntimeEvent(event).pipe(
        Effect.flatMap(() => {
          if (event.type !== "turn.completed") {
            return Effect.void;
          }
          return onTurnCompleted(event);
        }),
      );

    const worker = Effect.forever(
      Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
    );
    yield* Effect.forkScoped(worker);

    yield* Effect.forEach(adapters, (adapter) =>
      Stream.runForEach(adapter.streamEvents, (event) =>
        Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      ).pipe(Effect.forkScoped),
    ).pipe(Effect.asVoid);

    const recoverSessionForThread = (input: {
      readonly staleSessionId: string;
      readonly provider: ProviderSession["provider"];
      readonly threadId: string;
      readonly operation: string;
    }) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(input.provider);
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId?.trim() === input.threadId,
        );
        if (existing) {
          const existingThreadId = yield* upsertSessionBinding(
            existing,
            `${input.operation}:upsertExistingSession`,
          );
          yield* directory.upsert({
            sessionId: input.staleSessionId,
            provider: existing.provider,
            threadId: existingThreadId,
          });
          if (existing.sessionId !== input.staleSessionId) {
            yield* setAlias(input.staleSessionId, existing.sessionId);
          } else {
            yield* clearAliasKey(input.staleSessionId);
          }
          return {
            adapter,
            sessionId: existing.sessionId,
          } as const;
        }

        const resumed = yield* adapter.startSession({
          provider: input.provider,
          resumeThreadId: input.threadId,
        });
        if (resumed.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering stale session '${input.staleSessionId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
          );
        }

        const resumedThreadId = yield* upsertSessionBinding(
          resumed,
          `${input.operation}:upsertRecoveredSession`,
        );
        if (resumedThreadId !== input.threadId) {
          return yield* toValidationError(
            input.operation,
            `Recovered session thread '${resumedThreadId}' does not match expected thread '${input.threadId}'.`,
          );
        }

        yield* directory.upsert({
          sessionId: input.staleSessionId,
          provider: resumed.provider,
          threadId: resumedThreadId,
        });

        const checkpointCwd = resumed.cwd ?? process.cwd();
        yield* checkpointService.initializeForSession({
          providerSessionId: resumed.sessionId,
          cwd: checkpointCwd,
        });

        if (resumed.sessionId !== input.staleSessionId) {
          yield* setAlias(input.staleSessionId, resumed.sessionId);
        } else {
          yield* clearAliasKey(input.staleSessionId);
        }

        return {
          adapter,
          sessionId: resumed.sessionId,
        } as const;
      });

    const resolveRoutableSession = (input: {
      readonly sessionId: string;
      readonly operation: string;
      readonly allowRecovery: boolean;
    }) =>
      Effect.gen(function* () {
        const provider = yield* directory.getProvider(input.sessionId);
        const adapter = yield* registry.getByProvider(provider);

        const hasRequestedSession = yield* adapter.hasSession(input.sessionId);
        if (hasRequestedSession) {
          yield* clearAliasKey(input.sessionId);
          return {
            adapter,
            sessionId: input.sessionId,
            isActive: true,
          } as const;
        }

        const alias = yield* Ref.get(routedSessionAliasesRef).pipe(
          Effect.map((aliases) => aliases.get(input.sessionId)),
        );
        if (alias) {
          const aliasIsActive = yield* adapter.hasSession(alias);
          if (aliasIsActive) {
            return {
              adapter,
              sessionId: alias,
              isActive: true,
            } as const;
          }
          yield* clearAliasKey(input.sessionId);
        }

        if (!input.allowRecovery) {
          return {
            adapter,
            sessionId: input.sessionId,
            isActive: false,
          } as const;
        }

        const threadIdOption = yield* directory.getThreadId(input.sessionId);
        const threadId = Option.getOrUndefined(threadIdOption)?.trim();
        if (!threadId) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover stale session '${input.sessionId}' because no thread id is persisted.`,
          );
        }

        const recovered = yield* recoverSessionForThread({
          staleSessionId: input.sessionId,
          provider,
          threadId,
          operation: input.operation,
        });

        return {
          adapter: recovered.adapter,
          sessionId: recovered.sessionId,
          isActive: true,
        } as const;
      });

    const startSession: ProviderServiceShape["startSession"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = providerSessionStartInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return yield* toValidationError(
            "ProviderService.startSession",
            parsed.error.message,
            parsed.error.cause,
          );
        }

        const input = parsed.data;
        const adapter = yield* registry.getByProvider(input.provider);
        const session = yield* adapter.startSession(input);

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* upsertSessionBinding(session, "ProviderService.startSession");

        const checkpointCwd = session.cwd ?? input.cwd ?? process.cwd();
        yield* checkpointService.initializeForSession({
          providerSessionId: session.sessionId,
          cwd: checkpointCwd,
        });

        return session;
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = providerSendTurnInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            parsed.error.message,
            parsed.error.cause,
          );
        }

        const input = parsed.data;
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
        return yield* routed.adapter.sendTurn({
          ...input,
          sessionId: routed.sessionId,
        });
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = providerInterruptTurnInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return yield* toValidationError(
            "ProviderService.interruptTurn",
            parsed.error.message,
            parsed.error.cause,
          );
        }

        const input = parsed.data;
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        yield* routed.adapter.interruptTurn(routed.sessionId, input.turnId);
      });

    const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = providerRespondToRequestInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return yield* toValidationError(
            "ProviderService.respondToRequest",
            parsed.error.message,
            parsed.error.cause,
          );
        }

        const input = parsed.data;
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        yield* routed.adapter.respondToRequest(routed.sessionId, input.requestId, input.decision);
      });

    const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = providerStopSessionInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return yield* toValidationError(
            "ProviderService.stopSession",
            parsed.error.message,
            parsed.error.cause,
          );
        }

        const input = parsed.data;
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.sessionId);
        }
        if (routed.sessionId !== input.sessionId) {
          yield* checkpointService.releaseSession({ providerSessionId: routed.sessionId });
          yield* directory.remove(routed.sessionId);
          yield* clearAliasesReferencing(routed.sessionId);
        }
        yield* checkpointService.releaseSession({ providerSessionId: input.sessionId });
        yield* directory.remove(input.sessionId);
        yield* clearAliasesReferencing(input.sessionId);
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.forEach(adapters, (adapter) => adapter.listSessions()).pipe(
        Effect.map((sessionsByProvider) => sessionsByProvider.flatMap((sessions) => sessions)),
      );

    const listCheckpoints: ProviderServiceShape["listCheckpoints"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = providerListCheckpointsInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return yield* toValidationError(
            "ProviderService.listCheckpoints",
            parsed.error.message,
            parsed.error.cause,
          );
        }

        const input = parsed.data;
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.listCheckpoints",
          allowRecovery: true,
        });
        return yield* checkpointService.listCheckpoints({
          ...input,
          sessionId: routed.sessionId,
        });
      });

    const getCheckpointDiff: ProviderServiceShape["getCheckpointDiff"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = providerGetCheckpointDiffInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return yield* toValidationError(
            "ProviderService.getCheckpointDiff",
            parsed.error.message,
            parsed.error.cause,
          );
        }

        const input = parsed.data;
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.getCheckpointDiff",
          allowRecovery: true,
        });
        return yield* checkpointService.getCheckpointDiff({
          ...input,
          sessionId: routed.sessionId,
        });
      });

    const revertToCheckpoint: ProviderServiceShape["revertToCheckpoint"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = providerRevertToCheckpointInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return yield* toValidationError(
            "ProviderService.revertToCheckpoint",
            parsed.error.message,
            parsed.error.cause,
          );
        }

        const input = parsed.data;
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.revertToCheckpoint",
          allowRecovery: true,
        });
        return yield* checkpointService.revertToCheckpoint({
          ...input,
          sessionId: routed.sessionId,
        });
      });

    const stopAll: ProviderServiceShape["stopAll"] = () =>
      Effect.gen(function* () {
        const sessionIds = yield* directory.listSessionIds();
        yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
        // Keep persisted session bindings so stale sessions can be resumed after
        // process restart via resumeThreadId.
        yield* Effect.forEach(sessionIds, (sessionId) =>
          checkpointService.releaseSession({ providerSessionId: sessionId }),
        ).pipe(Effect.asVoid);
        yield* Ref.set(routedSessionAliasesRef, new Map());
      });

    return {
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      stopSession,
      listSessions,
      listCheckpoints,
      getCheckpointDiff,
      revertToCheckpoint,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}

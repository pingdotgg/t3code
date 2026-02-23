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
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Queue, Stream } from "effect";

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

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.sync(() => {
        canonicalEventLogger?.write({
          observedAt: new Date().toISOString(),
          event,
        });
      }).pipe(
        Effect.flatMap(() => PubSub.publish(runtimeEventPubSub, event)),
        Effect.asVoid,
      );

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) => registry.getByProvider(provider));

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

  const worker = Effect.forever(Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)));
  yield* Effect.forkScoped(worker);

  yield* Effect.forEach(adapters, (adapter) =>
    Stream.runForEach(adapter.streamEvents, (event) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
    ).pipe(Effect.forkScoped),
  ).pipe(Effect.asVoid);

  const adapterForSession = (sessionId: string) =>
    directory
      .getProvider(sessionId)
      .pipe(Effect.flatMap((provider) => registry.getByProvider(provider)));

  const startSession: ProviderServiceShape["startSession"] = (rawInput) =>
    Effect.gen(function* () {
      const parsed = providerSessionStartInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.startSession",
            parsed.error.message,
            parsed.error.cause,
          ),
        );
      }

      const input = parsed.data;
      const adapter = yield* registry.getByProvider(input.provider);
      const session = yield* adapter.startSession(input);

      if (session.provider !== adapter.provider) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          ),
        );
      }

      const threadId = session.threadId?.trim();
      if (!threadId) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.startSession",
            `Provider '${adapter.provider}' returned a session without threadId. threadId is required for checkpoint initialization.`,
          ),
        );
      }

      yield* directory.upsert({
        sessionId: session.sessionId,
        provider: session.provider,
        threadId,
      });

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
        return yield* Effect.fail(
          toValidationError("ProviderService.sendTurn", parsed.error.message, parsed.error.cause),
        );
      }

      const input = parsed.data;
      const adapter = yield* adapterForSession(input.sessionId);
      return yield* adapter.sendTurn(input);
    });

  const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
    Effect.gen(function* () {
      const parsed = providerInterruptTurnInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.interruptTurn",
            parsed.error.message,
            parsed.error.cause,
          ),
        );
      }

      const input = parsed.data;
      const adapter = yield* adapterForSession(input.sessionId);
      yield* adapter.interruptTurn(input.sessionId, input.turnId);
    });

  const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
    Effect.gen(function* () {
      const parsed = providerRespondToRequestInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.respondToRequest",
            parsed.error.message,
            parsed.error.cause,
          ),
        );
      }

      const input = parsed.data;
      const adapter = yield* adapterForSession(input.sessionId);
      yield* adapter.respondToRequest(input.sessionId, input.requestId, input.decision);
    });

  const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
    Effect.gen(function* () {
      const parsed = providerStopSessionInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.stopSession",
            parsed.error.message,
            parsed.error.cause,
          ),
        );
      }

      const input = parsed.data;
      const adapter = yield* adapterForSession(input.sessionId);
      yield* adapter.stopSession(input.sessionId);
      yield* checkpointService.releaseSession({ providerSessionId: input.sessionId });
      yield* directory.remove(input.sessionId);
    });

  const listSessions: ProviderServiceShape["listSessions"] = () =>
    Effect.forEach(adapters, (adapter) => adapter.listSessions()).pipe(
      Effect.map((sessionsByProvider) => sessionsByProvider.flatMap((sessions) => sessions)),
    );

  const listCheckpoints: ProviderServiceShape["listCheckpoints"] = (rawInput) =>
    Effect.gen(function* () {
      const parsed = providerListCheckpointsInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.listCheckpoints",
            parsed.error.message,
            parsed.error.cause,
          ),
        );
      }

      const input = parsed.data;
      yield* directory.getProvider(input.sessionId);
      return yield* checkpointService.listCheckpoints(input);
    });

  const getCheckpointDiff: ProviderServiceShape["getCheckpointDiff"] = (rawInput) =>
    Effect.gen(function* () {
      const parsed = providerGetCheckpointDiffInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.getCheckpointDiff",
            parsed.error.message,
            parsed.error.cause,
          ),
        );
      }

      const input = parsed.data;
      yield* directory.getProvider(input.sessionId);
      return yield* checkpointService.getCheckpointDiff(input);
    });

  const revertToCheckpoint: ProviderServiceShape["revertToCheckpoint"] = (rawInput) =>
    Effect.gen(function* () {
      const parsed = providerRevertToCheckpointInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return yield* Effect.fail(
          toValidationError(
            "ProviderService.revertToCheckpoint",
            parsed.error.message,
            parsed.error.cause,
          ),
        );
      }

      const input = parsed.data;
      yield* directory.getProvider(input.sessionId);
      return yield* checkpointService.revertToCheckpoint(input);
    });

  const stopAll: ProviderServiceShape["stopAll"] = () =>
    Effect.gen(function* () {
      const sessionIds = yield* directory.listSessionIds();
      yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
      yield* Effect.forEach(
        sessionIds,
        (sessionId) =>
          checkpointService.releaseSession({ providerSessionId: sessionId }).pipe(
            Effect.flatMap(() => directory.remove(sessionId)),
          ),
      ).pipe(Effect.asVoid);
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

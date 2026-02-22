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

import type { ProviderEvent } from "@t3tools/contracts";
import {
  providerGetCheckpointDiffInputSchema,
  providerInterruptTurnInputSchema,
  providerListCheckpointsInputSchema,
  providerRespondToRequestInputSchema,
  providerRevertToCheckpointInputSchema,
  providerSendTurnInputSchema,
  providerSessionStartInputSchema,
  providerStopSessionInputSchema,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { CheckpointService } from "../../checkpointing/Services/CheckpointService.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTurnCompletionStatus(event: ProviderEvent): string | undefined {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  return asString(turn?.status);
}

function toCheckpointCaptureErrorEvent(
  event: ProviderEvent,
  error: { readonly message: string },
): ProviderEvent {
  return {
    id: randomUUID(),
    kind: "error",
    provider: event.provider,
    sessionId: event.sessionId,
    createdAt: new Date().toISOString(),
    method: "checkpoint/captureError",
    message: error.message,
    ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
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

const makeProviderService = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  const checkpointService = yield* CheckpointService;

  const eventSubscribers = new Set<(event: ProviderEvent) => void>();
  const notifySubscribers = (event: ProviderEvent): void => {
    for (const callback of eventSubscribers) {
      try {
        callback(event);
      } catch {
        // Subscriber callbacks must not destabilize provider event fanout.
      }
    }
  };

  const providers = yield* registry.listProviders();
  const adapters = yield* Effect.forEach(providers, (provider) => registry.getByProvider(provider));

  yield* Effect.acquireRelease(
    Effect.forEach(adapters, (adapter) =>
      adapter.subscribeToEvents((event) => {
        notifySubscribers(event);
        if (event.kind !== "notification" || event.method !== "turn/completed") {
          return;
        }

        const status = readTurnCompletionStatus(event);
        const captureInput = {
          providerSessionId: event.sessionId,
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          ...(status !== undefined ? { status } : {}),
        };

        Effect.runFork(
          checkpointService.captureCurrentTurn(captureInput).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                notifySubscribers(toCheckpointCaptureErrorEvent(event, error));
              }),
            ),
          ),
        );
      }),
    ),
    (unsubscribeAll) =>
      Effect.forEach(unsubscribeAll, (unsubscribe) =>
        Effect.sync(() => {
          unsubscribe();
        }),
      ).pipe(Effect.asVoid),
  );

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

      yield* directory.upsert({
        sessionId: session.sessionId,
        provider: session.provider,
        ...(session.threadId !== undefined ? { threadId: session.threadId } : {}),
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
      yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
      const sessionIds = yield* directory.listSessionIds();
      yield* Effect.forEach(sessionIds, (sessionId) => directory.remove(sessionId)).pipe(
        Effect.asVoid,
      );
    });

  const subscribeToEvents: ProviderServiceShape["subscribeToEvents"] = (callback) =>
    Effect.sync(() => {
      eventSubscribers.add(callback);
      return () => {
        eventSubscribers.delete(callback);
      };
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
    subscribeToEvents,
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService);

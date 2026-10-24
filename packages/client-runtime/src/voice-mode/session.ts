import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { request, runStream } from "../rpc/client.ts";
import type { VoiceModePlatform } from "./controller.ts";

class VoiceSessionUnavailable extends Data.TaggedError("VoiceSessionUnavailable")<{
  readonly message: string;
}> {}

function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error && typeof error === "object") {
    if ("detail" in error && typeof error.detail === "string") return error.detail;
    if ("message" in error && typeof error.message === "string" && error.message) {
      return error.message;
    }
  }
  return "Voice conversation failed.";
}

/**
 * Builds `VoiceModePlatform.openSession` on an app runtime that provides the
 * environment registry. Interrupting the returned fiber ends the conversation
 * server-side.
 */
export function makeVoiceSessionOpener(
  runFork: (effect: Effect.Effect<void, never, EnvironmentRegistry>) => Fiber.Fiber<void>,
): VoiceModePlatform["openSession"] {
  return ({ environmentId, threadId, offerSdp }, handlers) => {
    const fiber = runFork(
      EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          registry
            .runStream(
              EnvironmentId.make(environmentId),
              runStream(WS_METHODS.providerVoiceSession, {
                threadId: ThreadId.make(threadId),
                offerSdp,
              }),
            )
            .pipe(Stream.runForEach((event) => Effect.sync(() => handlers.onEvent(event)))),
        ),
        Effect.matchCause({
          onFailure: (cause) => {
            if (!Cause.hasInterruptsOnly(cause)) handlers.onError(failureMessage(cause));
          },
          onSuccess: () => handlers.onEnd(),
        }),
      ),
    );
    return () => fiber.interruptUnsafe();
  };
}

/** Refreshes the bound provider session before requesting microphone access. */
export function makeVoiceSessionValidator(
  runFork: (effect: Effect.Effect<void, never, EnvironmentRegistry>) => Fiber.Fiber<void>,
): NonNullable<VoiceModePlatform["validateTarget"]> {
  return ({ environmentId, threadId }) =>
    new Promise((resolve, reject) => {
      runFork(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const projection = yield* registry.run(
            EnvironmentId.make(environmentId),
            request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
              threadId: ThreadId.make(threadId),
            }),
          );
          const providerThread = projection.providerThreads.find(
            (thread) => thread.id === projection.thread.activeProviderThreadId,
          );
          const session = projection.providerSessions.find(
            (session) => session.id === providerThread?.providerSessionId,
          );
          if (!session || !["ready", "running", "waiting"].includes(session.status)) {
            return yield* Effect.fail(
              new VoiceSessionUnavailable({
                message: "The provider session is no longer running. Send a message first.",
              }),
            );
          }
        }).pipe(
          Effect.matchCause({
            onSuccess: () => resolve(),
            onFailure: (cause) => reject(new Error(failureMessage(cause))),
          }),
        ),
      );
    });
}

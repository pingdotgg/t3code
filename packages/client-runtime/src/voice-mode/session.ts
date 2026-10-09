import { EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import type { VoiceModePlatform } from "./controller.ts";

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

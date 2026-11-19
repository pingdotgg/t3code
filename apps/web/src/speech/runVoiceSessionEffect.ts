import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * Runs one request of a live recording, which rejects into the voice controller and ends with the
 * session's signal. Everything else in the app runs speech effects through `speechCommands`.
 */
export function runVoiceSessionEffect<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  options: { readonly signal: AbortSignal },
): Promise<A> {
  // Relay (DPoP) environments authorize through services only the connection runtime provides.
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) => Effect.provide(effect, context)),
    ),
    options,
  );
}

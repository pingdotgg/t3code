import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

// Relay (DPoP) environments authorize through services only the connection runtime provides.
export function runEnvironmentSpeech<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  options?: Effect.RunOptions,
): Promise<A> {
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) => Effect.provide(effect, context)),
    ),
    options,
  );
}

import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const speechRuntime = {
  runPromise: <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient>,
    options?: { signal?: AbortSignal },
  ) =>
    Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime.atom(effect)),
      options,
    ),
};

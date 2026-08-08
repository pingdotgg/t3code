/**
 * AetherAdapter — T1 skeleton adapter for the Aether cloud-task driver.
 *
 * Every session/turn operation fails loudly with a typed
 * `ProviderAdapterRequestError` until the REST client (T3) and event mapper
 * (T6) land. The event stream is a real, scope-owned queue that simply never
 * receives an event yet, so consumers can subscribe without special-casing
 * this driver.
 *
 * @module provider/Layers/AetherAdapter
 */
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("aether");

const NOT_IMPLEMENTED_DETAIL = "Aether driver: not implemented until T3/T6";

const notImplemented = (method: string): Effect.Effect<never, ProviderAdapterError> =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: NOT_IMPLEMENTED_DETAIL,
    }),
  );

export const makeAetherAdapter = Effect.fn("makeAetherAdapter")(function* (_input: {
  readonly instanceId: ProviderInstanceId;
}): Effect.fn.Return<ProviderAdapterShape<ProviderAdapterError>, never, Scope.Scope> {
  // Scope-owned so registry teardown shuts the stream down with the instance.
  const runtimeEvents = yield* Effect.acquireRelease(
    Queue.unbounded<ProviderRuntimeEvent>(),
    Queue.shutdown,
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "unsupported",
    },
    startSession: () => notImplemented("startSession"),
    sendTurn: () => notImplemented("sendTurn"),
    interruptTurn: () => notImplemented("interruptTurn"),
    respondToRequest: () => notImplemented("respondToRequest"),
    respondToUserInput: () => notImplemented("respondToUserInput"),
    stopSession: () => notImplemented("stopSession"),
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => notImplemented("readThread"),
    rollbackThread: () => notImplemented("rollbackThread"),
    stopAll: () => Effect.void,
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});

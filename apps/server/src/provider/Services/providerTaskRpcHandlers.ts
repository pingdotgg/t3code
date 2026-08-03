/**
 * fork: f3 — the `provider.stopTask` RPC handler, factored out of `ws.ts`.
 *
 * `ws.ts` is one of the hottest files in the repo for upstream conflicts, so
 * its share of this feature is three lines: one import, one service
 * acquisition, one spread into `WsRpcGroup.of`.
 *
 * The only real work here is the error boundary. `ProviderService` fails with
 * the server-internal `ProviderServiceError` union, which is not a wire type;
 * this module narrows it to the two-member `ProviderStopTaskError` the client
 * knows how to render — "this provider can't stop tasks" for a routed adapter
 * without the operation, and a carried detail for everything else.
 *
 * @module providerTaskRpcHandlers
 */
import * as Effect from "effect/Effect";

import {
  ProviderStopTaskInput,
  ProviderTaskStopFailedError,
  ProviderTaskStopUnsupportedError,
  WS_METHODS,
} from "@t3tools/contracts";
import type { EnvironmentAuthorizationError } from "@t3tools/contracts";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderServiceShape } from "./ProviderService.ts";

/**
 * `ws.ts`'s scope-checking wrapper. Declared as an interface so the generic
 * call signature survives being passed as a value.
 */
export interface ProviderTaskObserveRpcEffect {
  <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ): Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
}

export interface ProviderTaskRpcHandlerDeps {
  readonly providerService: ProviderServiceShape;
  readonly observeRpcEffect: ProviderTaskObserveRpcEffect;
}

const TRACE = { "rpc.aggregate": "provider" } as const;

/**
 * `ProviderUnsupportedError` is the one refusal the UI must phrase differently:
 * nothing went wrong, the provider simply has no per-task stop.
 */
export function toProviderStopTaskError(
  input: ProviderStopTaskInput,
  cause: ProviderServiceError,
): ProviderTaskStopUnsupportedError | ProviderTaskStopFailedError {
  if (cause._tag === "ProviderUnsupportedError") {
    return new ProviderTaskStopUnsupportedError({
      threadId: input.threadId,
      taskId: input.taskId,
    });
  }
  return new ProviderTaskStopFailedError({
    threadId: input.threadId,
    taskId: input.taskId,
    detail: cause.message,
  });
}

export function makeProviderTaskRpcHandlers(deps: ProviderTaskRpcHandlerDeps) {
  const { providerService, observeRpcEffect } = deps;

  return {
    [WS_METHODS.providerStopTask]: (input: ProviderStopTaskInput) =>
      observeRpcEffect(
        WS_METHODS.providerStopTask,
        providerService
          .stopTask(input)
          .pipe(Effect.mapError((cause) => toProviderStopTaskError(input, cause))),
        TRACE,
      ),
  };
}

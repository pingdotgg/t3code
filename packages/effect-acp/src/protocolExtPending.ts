import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type * as AcpError from "./errors.ts";
import { acpRequestIdentity } from "./protocolIdentity.ts";

export interface AcpPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, AcpError.AcpError>;
  readonly method: string;
}

type ExtPending = Ref.Ref<Map<string, AcpPendingRequest>>;

export interface AcpExtPendingOps {
  readonly resolve: (
    requestId: AcpError.AcpRequestId,
    onFound: (pendingRequest: AcpPendingRequest) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly remove: (requestId: AcpError.AcpRequestId) => Effect.Effect<void>;
  readonly completeFailure: (
    requestId: AcpError.AcpRequestId,
    error: AcpError.AcpError,
  ) => Effect.Effect<void>;
  readonly completeSuccess: (
    requestId: AcpError.AcpRequestId,
    value: unknown,
  ) => Effect.Effect<void>;
  readonly failAll: (error: AcpError.AcpError) => Effect.Effect<void>;
}

/** Bookkeeping for ACP extension requests that are still awaiting a response. */
export const makeAcpExtPendingOps = (extPending: ExtPending): AcpExtPendingOps => {
  const resolve = (
    requestId: AcpError.AcpRequestId,
    onFound: (pendingRequest: AcpPendingRequest) => Effect.Effect<void>,
  ) =>
    Ref.modify(extPending, (pending) => {
      const pendingKey = acpRequestIdentity(requestId);
      const pendingRequest = pending.get(pendingKey);
      if (!pendingRequest) {
        return [Effect.void, pending] as const;
      }
      const next = new Map(pending);
      next.delete(pendingKey);
      return [onFound(pendingRequest), next] as const;
    }).pipe(Effect.flatten);

  const remove = (requestId: AcpError.AcpRequestId) =>
    Ref.update(extPending, (pending) => {
      const pendingKey = acpRequestIdentity(requestId);
      if (!pending.has(pendingKey)) {
        return pending;
      }
      const next = new Map(pending);
      next.delete(pendingKey);
      return next;
    });

  return {
    resolve,
    remove,
    completeFailure: (requestId, error) =>
      resolve(requestId, ({ deferred }) => Deferred.fail(deferred, error)),
    completeSuccess: (requestId, value) =>
      resolve(requestId, ({ deferred }) => Deferred.succeed(deferred, value)),
    failAll: (error) =>
      Ref.getAndSet(extPending, new Map<string, AcpPendingRequest>()).pipe(
        Effect.flatMap((pending) =>
          Effect.forEach([...pending.values()], ({ deferred }) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
      ),
  };
};

// ACP session behaviour extracted from server/adapter.ts (sessionFinalizer).

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type { AcpSessionCtx22 } from "./acpSessionContext.ts";

export const createAcpSessionFinalizer = Effect.fn("acpSession.sessionFinalizer")(function* (ctx: AcpSessionCtx22) {
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* ctx.continuationPermit.withPermit(
        Effect.gen(function* () {
          yield* Ref.set(ctx.continuationClosed, true);
          yield* Ref.update(ctx.continuationGeneration, (value) => value + 1);
        }),
      );
      const requests = [...(yield* Ref.get(ctx.pendingRuntimeRequests)).values()];
      yield* Effect.forEach(
        requests,
        (request) =>
          request.type === "approval"
            ? Deferred.succeed(request.decision, "cancel").pipe(Effect.ignore)
            : Deferred.succeed(request.answers, null).pipe(Effect.ignore),
        { discard: true },
      );
      const closingError = new EffectAcpErrors.AcpTransportError({
        detail: "The ACP session closed before its admitted response reached the transport",
        cause: "ACP session transport closed",
      });
      yield* Effect.forEach(
        requests,
        (request) => Deferred.fail(request.nativeResponseAcknowledgement, closingError),
        { discard: true },
      );
      const transportHadOutstandingResponses = yield* ctx.closeNativeTransport;
      const sessionCapabilities =
        ctx.started.initializeResult.agentCapabilities?.sessionCapabilities;
      if (sessionCapabilities?.close != null) {
        yield* ctx.runtimeTransitionPermit.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            const teardownState = yield* Ref.get(ctx.runtimeTeardownState);
            const restartRequired = yield* Ref.get(ctx.runtimeRestartRequired);
            if (
              teardownState._tag === "Idle" &&
              !restartRequired &&
              !transportHadOutstandingResponses
            ) {
              yield* ctx.runtime.closeSession().pipe(Effect.ignore);
            }
          }),
        );
      }
      if (ctx.flavor.assertComplete !== undefined) {
        yield* ctx.flavor.assertComplete.pipe(Effect.orDie);
      }
      if (ctx.runtimeScope !== undefined) {
        yield* Scope.close(ctx.runtimeScope, Exit.void).pipe(Effect.ignore);
      }
    }),
  );
  return {};
});

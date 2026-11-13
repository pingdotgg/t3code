/**
 * OpenCode native event subscription: wires the SSE stream into the event handler.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as OpenCodeRuntime from "../../OpenCodeRuntime.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { Items } from "./items.ts";
import type { Turns } from "./turns.ts";
import type { Events } from "./events.ts";
import type { State } from "./base.ts";

export const makeSubscription = (deps: State & Items & Events & Turns) => {
  const {
    connection,
    client,
    scope,
    events,
    threads,
    busySessionIds,
    abortController,
    sdkCall,
    abortDescendants,
  } = deps;
  const m = deps.mutable;

  const startSubscription = Effect.fnUntraced(function* () {
  const subscription = yield* sdkCall("event.subscribe", {}, () =>
    client.event.subscribe(undefined, { signal: abortController.signal }),
  );
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => abortController.abort()),
  );
  yield* Stream.fromAsyncIterable(
    subscription.stream,
    (cause) =>
      new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "event.subscribe",
        detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
        cause,
      }),
  ).pipe(
    Stream.runForEach(deps.handleEvent),
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.gen(function* () {
        busySessionIds.clear();
        if (m.closing || abortController.signal.aborted) return;
        const detail = Exit.isSuccess(exit)
          ? "OpenCode event stream ended unexpectedly."
          : OpenCodeRuntime.openCodeRuntimeErrorDetail(Cause.squash(exit.cause));
        m.nativeStreamFailure = makeProviderFailure({
          message: detail,
          class: "transport_error",
        });
        yield* deps.updateProviderSession("error", detail);
        for (const state of threads.values()) {
          if (state.activeTurn !== null)
            yield* deps.finalizeTurn(state, state.activeTurn, "failed", {
              failure: makeProviderFailure({ message: detail, class: "transport_error" }),
              threadDisposition: "broken",
            });
        }
        yield* Queue.end(events);
      }),
    ),
    Effect.forkIn(scope),
  );

  const exitCodeEffect = connection.exitCode;
  if (!connection.external && exitCodeEffect !== null) {
    yield* exitCodeEffect.pipe(
      Effect.flatMap((code) =>
        abortController.signal.aborted
          ? Effect.void
          : Effect.gen(function* () {
              const detail = `OpenCode server exited unexpectedly (${code}).`;
              yield* deps.updateProviderSession("error", detail);
              for (const state of threads.values()) {
                if (state.activeTurn !== null) {
                  yield* deps.finalizeTurn(state, state.activeTurn, "failed", {
                    failure: makeProviderFailure({
                      message: detail,
                      class: "transport_error",
                    }),
                    threadDisposition: "broken",
                  });
                }
              }
            }),
      ),
      Effect.forkIn(scope),
    );
  }

  if (connection.external) {
    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(threads.values()).filter((state) => state.parentSubagent === null),
          (state) =>
            sdkCall("session.abort", { sessionID: state.nativeSessionId }, (signal) =>
              client.session.abort({ sessionID: state.nativeSessionId }, { signal }),
            ).pipe(
              Effect.timeout("1 second"),
              Effect.ignore({ log: true }),
              Effect.andThen(
                abortDescendants(state.nativeSessionId).pipe(
                  Effect.timeout("1 second"),
                  Effect.ignore({ log: true }),
                ),
              ),
            ),
          { concurrency: 8, discard: true },
        ),
      ),
    );
  }

  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      m.closing = true;
    }),
  );
  });

  return { startSubscription };
};

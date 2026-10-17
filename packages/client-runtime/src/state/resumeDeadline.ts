import { EnvironmentAuthorizationError } from "@t3tools/contracts";
import { traceSynchronization } from "@t3tools/shared/synchronization";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { isRpcClientError } from "../rpc/client.ts";

const RESUME_COMPLETION_DEADLINE_MS = 15_000;
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export class ResumeCompletionError extends Schema.TaggedError<ResumeCompletionError>()(
  "ResumeCompletionError",
  { reason: Schema.Literals(["deadline", "ended"]) },
) {}

/** Bound catch-up, not live traffic. Replay activity must not reset the deadline. */
export function withResumeDeadline<A extends { readonly kind: string }, E>(
  stream: Stream.Stream<A, E>,
  input: {
    readonly enabled: boolean;
    readonly resumed: boolean;
    readonly snapshotRetry: boolean;
    readonly environmentId: string;
    readonly threadId: string;
  },
): Stream.Stream<A, E> {
  if (!input.enabled) return stream;
  return Stream.unwrap(
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      const started = yield* Clock.currentTimeMillis;
      let synchronized = false;
      const transition = (
        state: "connecting" | "resuming" | "snapshot" | "marker_received" | "timeout",
      ) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            traceSynchronization(state, {
              stream: "thread",
              side: "client",
              mode: input.resumed ? "resume" : "snapshot",
              environmentId: input.environmentId,
              threadId: input.threadId,
              elapsedMs: now - started,
              reason: input.resumed ? "cached_cursor" : "no_cursor",
            }),
          ),
        );
      yield* transition("connecting");
      yield* transition(input.resumed ? "resuming" : "snapshot");
      const deadline = Deferred.await(completed).pipe(
        Effect.timeoutOrElse({
          duration: RESUME_COMPLETION_DEADLINE_MS,
          orElse: () =>
            transition("timeout").pipe(
              Effect.andThen(Effect.die(new ResumeCompletionError({ reason: "deadline" }))),
            ),
        }),
        Effect.andThen(Effect.never),
      );
      return stream.pipe(
        Stream.mapArrayEffect((items) => {
          if (!items.some((item) => item.kind === "synchronized")) return Effect.succeed(items);
          synchronized = true;
          return Deferred.succeed(completed, undefined).pipe(
            Effect.andThen(transition("marker_received")),
            Effect.as(items),
          );
        }),
        // A remote Interrupted exit ends this request, not its WebSocket.
        // Keep the catch-up watchdog alive for that case. Canceling this
        // subscription's scope still interrupts the watchdog and cannot retry.
        Stream.catchCause((cause) =>
          !synchronized && cause.reasons.every((reason) => reason._tag === "Interrupt")
            ? Stream.never
            : Stream.failCause(cause),
        ),
        Stream.concat(
          Stream.suspend(() =>
            synchronized
              ? Stream.empty
              : Stream.die(new ResumeCompletionError({ reason: "ended" })),
          ),
        ),
        Stream.interruptWhen(deadline),
        // RPC encodes a remote defect as a typed transport error. Let the
        // thread's bounded snapshot fallback see it instead of parking forever
        // on an otherwise healthy session. Real socket failures still wait for
        // the supervisor's replacement session.
        Stream.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Stream.failCause(cause);
          const rpcDefect = cause.reasons.some(
            (reason) =>
              reason._tag === "Fail" &&
              isRpcClientError(reason.error) &&
              reason.error.reason._tag === "RpcClientDefect",
          );
          const failedCatchUp =
            (input.resumed || input.snapshotRetry) &&
            !synchronized &&
            cause.reasons.some(
              (reason) =>
                reason._tag === "Fail" &&
                !isRpcClientError(reason.error) &&
                !isEnvironmentAuthorizationError(reason.error),
            );
          return rpcDefect || failedCatchUp
            ? Stream.die(Cause.squash(cause))
            : Stream.failCause(cause);
        }),
      );
    }),
  ).pipe(
    Stream.withSpan("orchestration.sync", {
      attributes: {
        "environment.id": input.environmentId,
        "thread.id": input.threadId,
        "sync.mode": input.resumed ? "resume" : "snapshot",
      },
    }),
  );
}

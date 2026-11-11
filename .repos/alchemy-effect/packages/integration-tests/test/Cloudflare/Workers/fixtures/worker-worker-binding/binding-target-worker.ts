import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export const streamScenarios = [
  "complete",
  "cancel",
  "empty",
  "head-failure",
  "tail-failure",
] as const;

class RpcStreamFixtureError extends Data.TaggedError("RpcStreamFixtureError")<{
  readonly phase: "head" | "tail";
}> {}

interface RpcStreamSnapshot {
  part: "head" | "tail";
  eventClosed: number;
  sourceClosed: number;
}

type RpcStreamValue = RpcStreamSnapshot | Uint8Array;

/**
 * Effect-native callee for the service-binding fixtures.
 */
export default class BindingTargetWorker extends Cloudflare.Worker<BindingTargetWorker>()(
  "BindingTargetWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      scopedStreamReady: () => Effect.succeed("rpc-stream-scopes"),
      scopedStream: (
        bytes: boolean,
        scenario: (typeof streamScenarios)[number],
      ): Effect.Effect<Stream.Stream<RpcStreamValue, RpcStreamFixtureError>, never, Scope.Scope> =>
        Effect.gen(function* () {
          let eventClosed = 0;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              eventClosed++;
            }),
          );

          return Stream.unwrap(
            Effect.gen(function* () {
              let sourceClosed = 0;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  sourceClosed++;
                }),
              );
              const value = (part: "head" | "tail"): RpcStreamValue => {
                const snapshot = { part, eventClosed, sourceClosed };
                return bytes ? new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`) : snapshot;
              };
              if (scenario === "empty") return Stream.empty;
              if (scenario === "head-failure") {
                return Stream.fail(new RpcStreamFixtureError({ phase: "head" }));
              }
              return Stream.concat(
                Stream.succeed(value("head")),
                Stream.fromEffect(
                  scenario === "cancel"
                    ? Effect.never
                    : Effect.gen(function* () {
                        // Force a later pull: a prematurely closed event or peeled
                        // source scope must be visible in the tail's snapshot.
                        yield* Effect.sleep("50 millis");
                        if (scenario === "tail-failure") {
                          return yield* Effect.fail(new RpcStreamFixtureError({ phase: "tail" }));
                        }
                        return value("tail");
                      }),
                ),
              );
            }),
          );
        }),
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("hello from BindingTargetWorker");
      }),
    };
  }),
) {}

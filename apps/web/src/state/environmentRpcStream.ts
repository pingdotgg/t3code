import {
  EnvironmentSupervisor,
  type EnvironmentRegistry,
} from "@t3tools/client-runtime/connection";
import { isRpcClientError, type RpcSession } from "@t3tools/client-runtime/rpc";
import { createEnvironmentSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/unstable/reactivity";

type ProtocolClient = RpcSession["client"];

type StreamRpcTag = {
  [K in keyof ProtocolClient & string]: ProtocolClient[K] extends (
    ...args: never[]
  ) => Stream.Stream<infer _A, infer _E, infer _R>
    ? K
    : never;
}[keyof ProtocolClient & string];

type StreamRpcInput<TTag extends StreamRpcTag> = Parameters<ProtocolClient[TTag]>[0];

type StreamRpcValue<TTag extends StreamRpcTag> = ProtocolClient[TTag] extends (
  ...args: never[]
) => Stream.Stream<infer A, infer _E, infer _R>
  ? A
  : never;

type StreamRpcFailure<TTag extends StreamRpcTag> = ProtocolClient[TTag] extends (
  ...args: never[]
) => Stream.Stream<infer _A, infer E, infer _R>
  ? E
  : never;

/**
 * Durable subscription to a streaming RPC: follows the environment's session,
 * resubscribes whenever a new session opens, and treats a lost transport as
 * "wait for the next session" instead of a failure. Mirrors the client
 * runtime's `subscribe` for methods its `EnvironmentSubscriptionRpcTag` list
 * does not name yet (the Tailcat and federation subscriptions).
 */
function subscribeStream<TTag extends StreamRpcTag>(
  tag: TTag,
  input: StreamRpcInput<TTag>,
): Stream.Stream<StreamRpcValue<TTag>, StreamRpcFailure<TTag>, EnvironmentSupervisor> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = session.client[tag] as (
                input: StreamRpcInput<TTag>,
              ) => Stream.Stream<StreamRpcValue<TTag>, StreamRpcFailure<TTag>>;
              return method(input).pipe(
                Stream.catchCause((cause) => {
                  const lostTransport =
                    cause.reasons.length > 0 &&
                    cause.reasons.every(
                      (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                    );
                  if (!lostTransport) {
                    return Stream.failCause(cause);
                  }
                  return Stream.fromEffect(
                    Effect.logWarning(
                      "Durable RPC subscription lost its transport; waiting for the next session.",
                      { method: tag, environmentId: supervisor.target.environmentId },
                    ),
                  ).pipe(Stream.drain);
                }),
              );
            },
          }),
        ),
      );
    }),
  ).pipe(Stream.withSpan("EnvironmentRpc.subscribe", { attributes: { "rpc.method": tag } }));
}

/** Per-environment atom family over a streaming RPC, keyed like the runtime's RPC families. */
export function createEnvironmentStreamAtomFamily<R, ER, TTag extends StreamRpcTag>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: { readonly label: string; readonly tag: TTag },
) {
  return createEnvironmentSubscriptionAtomFamily(runtime, {
    label: options.label,
    subscribe: (input: StreamRpcInput<TTag>) => subscribeStream(options.tag, input),
  });
}

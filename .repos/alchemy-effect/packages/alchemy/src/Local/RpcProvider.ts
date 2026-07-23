import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Scope } from "effect/Scope";
import * as Stream from "effect/Stream";
import { InstanceId } from "../InstanceId.ts";
import type { Platform } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { ResourceClass, ResourceLike } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { RpcProviderProxy } from "./RpcProviderProxy.ts";

/**
 * Constructs an RpcProvider for a given resource.
 *
 * An RpcProvider is a resource provider that can run in a separate process.
 * This is used for local development so that the resource provider and its state can outlive the user's code when it is hot-reloaded.
 * If the {@link RpcProviderProxy} is provided, the provider is run in a separate process, which we communicate with here using a websocket.
 * Otherwise, the given effect is used to construct the provider directly.
 *
 * @note If the provider is running in a separate process, you may not need to construct all of its layers in this process.
 *       You can use {@link providerServices} or {@link providerServicesEffect} to construct such layers only when they are needed.
 *
 * @example
 * ```ts
 * export const MyProvider = RpcProvider.effect(
 *   MyResource,
 *   import.meta.resolve("./my-rpc-provider-server.ts"),
 *   Effect.gen(function* () {
 *     return {
 *       diff: ...,
 *       reconcile: ...,
 *       delete: ...,
 *     }
 *   })
 * )
 * ```
 *
 * @param cls - The tag of the resource class to construct a provider for.
 * @param serverEntryUrl - The main file for the server entry point, if the provider is to be run in a separate process. This is typically obtained using `import.meta.url` or `import.meta.resolve`.
 * @param eff - The Effect to use to construct the provider.
 * @returns A layer containing the RpcProvider.
 */
export const effect = <
  R extends ResourceLike,
  Req = never,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  ReconcileReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
>(
  cls: ResourceClass<R> | Platform<R, any, any, any, any>,
  serverEntryUrl: string,
  eff: Effect.Effect<
    Provider.ProviderService<
      R,
      ReadReq,
      DiffReq,
      PrecreateReq,
      ReconcileReq,
      DeleteReq,
      TailReq,
      LogsReq
    >,
    never,
    Req
  >,
) =>
  Provider.effect(
    cls,
    Effect.gen(function* () {
      const client = yield* Effect.serviceOption(RpcProviderProxy);
      const stack = yield* Stack;

      if (client._tag === "None") {
        const provider = yield* eff;
        return new Proxy(provider, {
          get: (target, prop) => {
            const value = (target as any)[prop];
            if (!Predicate.isFunction(value)) return value;
            return (...args: any[]) => {
              const result = value(...args);
              const services = Layer.mergeAll(
                layerFallback(Stack, stack),
                layerFallback(Stage, stack.stage),
                Predicate.hasProperty(args[0], "instanceId") &&
                  Predicate.isString(args[0].instanceId)
                  ? layerFallback(InstanceId, args[0].instanceId)
                  : Layer.empty,
              );
              return result.pipe(
                Stream.isStream(result)
                  ? Stream.provide(services)
                  : Effect.provide(services),
              );
            };
          },
        });
      }
      return yield* client.value.get(serverEntryUrl, cls.Type);
    }),
  );

const layerFallback = <I, S>(
  service: Context.Key<I, S>,
  defaultValue: NoInfer<S>,
) =>
  Layer.effect(
    service,
    Effect.serviceOption(service).pipe(
      Effect.map(Option.getOrElse(() => defaultValue)),
    ),
  );

/**
 * Conditionally constructs a layer for use by an RpcProvider.
 * If the {@link RpcProviderProxy} is present in context, the layer is empty because it will not be used in this process.
 * Otherwise, the given layer is returned.
 * @param self - The layer that is used by the RpcProvider.
 * @returns A layer that is empty if the {@link RpcProviderProxy} is present in context, otherwise the given layer.
 */
export const providerServices = <ROut, E, RIn>(
  self: Layer.Layer<ROut, E, RIn>,
): Layer.Layer<ROut, E, RIn> => providerServicesEffect(Effect.succeed(self));

/**
 * Conditionally constructs a layer for use by an RpcProvider.
 * If the {@link RpcProviderProxy} is present in context, the layer is empty because it will not be used in this process.
 * Otherwise, the given layer is returned.
 * @param self - An effect which returns a layer that is used by the RpcProvider.
 */
export const providerServicesEffect = <A, E1, R1, E, R>(
  self: Effect.Effect<Layer.Layer<A, E1, R1>, E, R>,
): Layer.Layer<A, E | E1, R1 | Exclude<R, Scope>> =>
  Effect.serviceOption(RpcProviderProxy).pipe(
    Effect.flatMap((client) =>
      client._tag === "None" ? self : (Effect.succeed(Layer.empty) as never),
    ),
    Layer.unwrap,
  );

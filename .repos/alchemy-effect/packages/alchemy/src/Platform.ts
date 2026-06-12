import * as ConfigError from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Scope } from "effect/Scope";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { SingleShotGen } from "effect/Utils";
import type { PolicyLike } from "./Binding.ts";
import type { Dependencies } from "./Dependencies.ts";
import type { ExecutionContext } from "./ExecutionContext.ts";
import type { HttpEffect } from "./Http.ts";
import type { InputProps } from "./Input.ts";
import * as Output from "./Output.ts";
import { ALCHEMY_PHASE } from "./Phase.ts";
import type { Provider, ProviderCollectionLike } from "./Provider.ts";
import { Resource, type ResourceLike } from "./Resource.ts";
import type { Rpc } from "./Rpc.ts";
import {
  CurrentRuntimeContext,
  RuntimeContext,
  sanitizeKey,
  type BaseRuntimeContext,
} from "./RuntimeContext.ts";
import { Self } from "./Self.ts";
import type { Stack, StackServices } from "./Stack.ts";
import type { Stage } from "./Stage.ts";
import { effectClass } from "./Util/effect.ts";

export interface PlatformProps {
  /**
   * @internal type used to signal when this is an effect-native implementation
   * @default false
   */
  isExternal?: boolean;
}

export type Main<InitServices = never> = void | {
  fetch:
    | HttpEffect<InitServices | PlatformServices>
    | Effect.Effect<
        HttpEffect<InitServices | PlatformServices>,
        never,
        InitServices | PlatformServices
      >;
};

// services provided to the Resource
export type PlatformServices =
  | RuntimeContext
  | ExecutionContext
  | HttpClient
  | PolicyLike
  | Provider<any>
  | ProviderCollectionLike
  | Scope
  | Stack
  | StackServices
  | Stage;

export interface Platform<
  Resource extends ResourceLike<string, PlatformProps>,
  Services,
  MainShape,
  RuntimeContext extends BaseRuntimeContext,
  BaseShape = {},
> extends Effect.Effect<Resource & RuntimeContext, never, Resource> {
  Type: Resource["Type"];
  Provider: Provider<Resource>;

  <Self, Shape, Deps = never>(): {
    <PropsReq = never>(
      id: string,
      props:
        | InputProps<Resource["Props"]>
        | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
    ): Effect.Effect<
      Resource & Rpc<Self> & Dependencies<Deps>,
      never,
      Resource["Providers"] | PropsReq
    > & {
      make<InitReq = never>(
        impl: Effect.Effect<Shape, ConfigError.ConfigError, InitReq>,
      ): Layer.Layer<
        Self,
        never,
        | Resource["Providers"]
        | Exclude<PropsReq | InitReq, Services | PlatformServices | Resource>
      >;
      new (_: never): MakeShape<Shape, BaseShape>;
      of(shape: Shape & MainShape): MakeShape<Shape, BaseShape>;
    };
  };
  <Self>(): {
    <
      Shape extends MainShape,
      PropsReq = never,
      InitReq extends Services | PlatformServices | Resource = never,
    >(
      id: string,
      props:
        | InputProps<Resource["Props"]>
        | Effect.Effect<Resource["Props"], never, PropsReq>,
      impl: Effect.Effect<Shape, ConfigError.ConfigError, InitReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      | Resource["Providers"]
      | PropsReq
      | Exclude<InitReq, Services | PlatformServices | Resource>
    > & {
      new (_: never): MakeShape<Shape, BaseShape>;
    };
    <Shape, PropsReq = never>(
      id: string,
      props:
        | InputProps<Resource["Props"]>
        | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      Resource["Providers"] | PropsReq
    > & {
      make<InitReq extends Services | PlatformServices | Resource = never>(
        impl: Effect.Effect<Shape, ConfigError.ConfigError, InitReq>,
      ): Layer.Layer<
        Self,
        never,
        | Resource["Providers"]
        | Exclude<PropsReq | InitReq, Services | PlatformServices | Resource>
      >;
      new (_: never): MakeShape<Shape, BaseShape>;
    } & (<InitReq extends Services | PlatformServices | Resource = never>(
        impl: Effect.Effect<Shape, never, InitReq>,
      ) => Effect.Effect<
        Resource & Rpc<Self>,
        never,
        | Resource["Providers"]
        | PropsReq
        | Exclude<InitReq, Services | PlatformServices | Resource>
      >);
  };
  // <PropsReq = never, InitReq extends Services | PlatformServices = never>(
  //   id: string,
  //   props:
  //     | InputProps<Resource["Props"]>
  //     | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
  // ): Effect.Effect<
  //   Resource,
  //   never,
  //   | Resource["Providers"]
  //   | PropsReq
  //   | Exclude<InitReq, Services | PlatformServices>
  // >;
  <
    Shape extends MainShape,
    PropsReq = never,
    InitReq extends Services | PlatformServices = never,
  >(
    id: string,
    props:
      | InputProps<Resource["Props"]>
      | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
    impl: Effect.Effect<Shape, ConfigError.ConfigError, InitReq>,
  ): Effect.Effect<
    Resource & Rpc<Shape>,
    never,
    | Resource["Providers"]
    | PropsReq
    | Exclude<InitReq, Services | PlatformServices>
  >;
}

type MakeShape<Shape, BaseShape> = Shape extends never | undefined | void
  ? BaseShape
  : Shape & BaseShape;

export const Platform = <
  R extends ResourceLike<
    string,
    | {
        env?: Record<string, any>;
        exports?: string[] | Record<string, any>;
      }
    | undefined
  >,
>(
  type: R["Type"],
  hooks: {
    createRuntimeContext: (id: string) => BaseRuntimeContext;
    onCreate?: (resource: R, props: any) => Effect.Effect<void>;
  },
  methods?: { [key: string]: any },
): any => {
  type Props = any;
  type Impl = Effect.Effect<any>;

  const resource = Resource(type);
  const PlatformContext = RuntimeContext;

  const constructor = (
    id?: string,
    props?: any,
    impl?: Impl,
    isTag = false,
  ): any => {
    if (!id) {
      // impl was not provided inline, this is a tagged instance
      // e.g.
      // export class Sandbox extends Cloudflare.Container<Sandbox>()(..) {}
      //
      // export const SandboxLive = Sandbox.make(..)
      return (id: string, props?: any, impl?: Impl) =>
        constructor(id, props, impl, true);
    } else if (!impl) {
      const cls = makeClass(id, props);
      const asEffect = () =>
        (!isTag
          ? // this is a non-tagged resource yielded without providing an implementation
            // e.g.
            // yield* Cloudflare.Worker("id", { main: "./src/worker.ts" })
            //
            // This is where we bridge to non-effect, e.g. bundling an ordinary worker
            // export default {
            //   fetch: (request: Request) => {
            //     return new Response("Hello, world!");
            //   }
            // }
            resource(
              id,
              Effect.isEffect(props)
                ? Effect.map(props, (p: any) => ({ ...p, isExternal: true }))
                : {
                    ...props,
                    isExternal: true,
                  },
            )
          : Effect.flatMap(
              // this is a tagged resource
              Effect.serviceOption(cls.Self),
              Option.match({
                // we are likely running at runtime, so we create
                onNone: () => resource(id, props),
                onSome: Effect.succeed,
              }),
            )
        ).pipe(
          Effect.tap((resource) =>
            hooks.onCreate
              ? Effect.flatMap(
                  // `props` may itself be an Effect (e.g. when wrapped by
                  // `Cloudflare.Vite` via `Effect.map`); resolve it before
                  // handing it to the hook so `onCreate` always sees the
                  // plain props object — the second call site (in
                  // `cls.make`) already does this.
                  Effect.isEffect(props) ? props : Effect.succeed(props ?? {}),
                  (resolved) => hooks.onCreate!(resource as R, resolved),
                )
              : Effect.void,
          ),
        );
      return Object.assign(
        function (impl: Impl) {
          return cls.asEffect().pipe(Effect.provide(cls.make(impl)));
        },
        // we splice in the Effect so this can be yielded to indicate a non-Effect native instance
        // e.g. here, we yield it - in this case we don't want to provide an implementation
        // const worker = yield* Cloudflare.Worker("id", {
        //  main: "./src/worker.ts"
        // });
        cls,
        {
          asEffect,
          // @ts-expect-error
          pipe: (...args: any[]) => asEffect().pipe(...args),
          [Symbol.iterator]: () => new SingleShotGen(asEffect()),
        },
      );
    } else {
      // impl was provided inline, this is a non-tagged eager instance
      // e.g.
      // export default Cloudflare.Worker("id", { main: "./src/worker.ts" }, Effect.gen(function* () { .. })
      const cls = makeClass(id, props);
      return cls.asEffect().pipe(Effect.provide(cls.make(impl)), effectClass);
    }
  };

  const makeClass = (id: string, props: Props) => {
    return class Platform {
      static readonly Self = Self(`${type}<${id}>`);
      static readonly Platform = Context.Service<Platform, Platform>(
        `Platform<${type}<${id}>>`,
      );
      static [Symbol.iterator](): Iterator<
        Effect.Effect<void, never, Self>,
        Resource,
        void
      > {
        return new SingleShotGen(this.asEffect()) as any;
      }
      static asEffect() {
        return this.Self;
      }
      static pipe(...args: any[]) {
        // @ts-expect-error
        return pipe(this, ...args);
      }
      static of = (shape: any) => shape;
      static make = (impl: Impl) => {
        // build the Layer once for the root Self
        const SelfLayer = Layer.effect(
          Self,
          Effect.flatMap(
            Effect.all([
              Effect.isEffect(props) ? props : Effect.succeed(props ?? {}),
              Effect.sync(() => hooks.createRuntimeContext(id)),
              Effect.context<never>(),
            ]),
            Effect.fnUntraced(function* ([
              props,
              runtimeContext,
              outerServices,
            ]) {
              const instance = Object.assign(
                yield* resource(id, props as any).pipe(
                  Effect.flatMap(
                    (resource) =>
                      hooks
                        .onCreate?.(resource, props)
                        .pipe(Effect.map(() => resource)) ??
                      Effect.succeed(resource),
                  ),
                ),
                runtimeContext,
              );

              yield* impl.pipe(
                Effect.flatMap((impl) =>
                  impl?.fetch
                    ? // Hand the full impl to `serve` so the runtime can
                      // expose any non-handler methods on the impl shape
                      // (e.g. RPC methods on a Cloudflare Worker) alongside
                      // the standard `fetch` handler.
                      (runtimeContext.serve?.(impl.fetch, {
                        shape: impl as Record<string, unknown>,
                      }) ?? Effect.die("No serve handler"))
                    : Effect.void,
                ),

                Effect.provide(
                  Layer.effect(
                    ConfigProvider.ConfigProvider,
                    Effect.gen(function* () {
                      // a Config Provider that we use to intercept config lookups and bind them to the RuntimeContext
                      const configProvider =
                        yield* ConfigProvider.ConfigProvider;
                      const phase = yield* ALCHEMY_PHASE;

                      return ConfigProvider.make(
                        Effect.fnUntraced(function* (path) {
                          const ctx = yield* CurrentRuntimeContext;
                          // `set`/`get` store keys verbatim, so canonicalize the
                          // logical config path here (the caller's job) before
                          // handing it to the RuntimeContext.
                          const key = sanitizeKey(
                            path.map((p) => p.toString()).join("_"),
                          );
                          const node = yield* configProvider.get(path);
                          if (phase === "plan" && node) {
                            // bind it to the RuntimeContext if running in plan phase
                            const output = Output.literal(
                              Redacted.make(node.value),
                            );
                            yield* ctx?.set(key, output) ?? Effect.void;
                            return node;
                          } else if (phase === "runtime" && ctx) {
                            // retrieve from the RuntimeContext if running in runtime phase
                            const value =
                              yield* ctx.get<Redacted.Redacted<string>>(key);
                            if (value) {
                              return ConfigProvider.makeValue(
                                Redacted.isRedacted(value)
                                  ? Redacted.value(value)
                                  : value,
                              );
                            }
                          }
                          // fallback to the config provider otherwise
                          return node;
                        }),
                      );
                    }),
                  ).pipe(
                    Layer.provideMerge(
                      Layer.mergeAll(
                        Layer.succeed(Platform.Platform, runtimeContext),
                        Layer.succeed(PlatformContext, runtimeContext),
                        Layer.succeed(RuntimeContext, runtimeContext),
                        Layer.succeed(resource.Self, instance),
                        Layer.succeed(Platform.Self, instance),
                        Layer.succeed(Self, instance),
                        runtimeContext.planServices
                          ? Layer.unwrap(
                              ALCHEMY_PHASE.pipe(
                                Effect.map((phase) =>
                                  phase === "plan"
                                    ? runtimeContext.planServices!
                                    : Layer.empty,
                                ),
                              ),
                            )
                          : Layer.empty,
                      ),
                    ),
                    Layer.provideMerge(Layer.succeedContext(outerServices)),
                  ),
                ),
              );

              instance.Props = {
                ...props,
                env: {
                  ...props?.env,
                  ...runtimeContext.env,
                },
                exports: runtimeContext.exports
                  ? yield* runtimeContext.exports
                  : undefined,
              };

              return Object.assign(instance, {
                RuntimeContext: runtimeContext,
              }) as R;
            }),
          ),
        );
        const self = Self as any; // TODO(sam): why do we need to cast?

        return Layer.provideMerge(
          Layer.mergeAll(
            // sets the Context for all self-hierarchies
            // Self
            // Self<Cloudflare.Worker>
            // Self<Cloudflare.Worker<Api>>
            Layer.effect(Self<R>(type), self),
            Layer.effect(Self<R>(`${type}<${id}>`), self),
          ),
          // provide here so we build once and just mirror
          SelfLayer,
        );
      };
    };
  };

  const instance = Object.assign(constructor, resource, {
    Platform: Platform,
    asEffect: () => resource.Self,
    ...methods,
  }) as any;
  return instance;
};

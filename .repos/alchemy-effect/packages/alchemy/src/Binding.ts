import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SingleShotGen } from "effect/Utils";
import type { Input } from "./Input.ts";
import * as Namespace from "./Namespace.ts";
import { ALCHEMY_PHASE } from "./Phase.ts";
import { tryFindProviderByType } from "./Provider.ts";
import type { ResourceLike } from "./Resource.ts";
import { RuntimeContext } from "./RuntimeContext.ts";
import { Self } from "./Self.ts";
import { CurrentStack } from "./Stack.ts";

export interface ServiceLike {
  kind: "Service";
}

export interface ServiceShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends Context.ServiceClass.Shape<Identifier, Shape>, ServiceLike {}

export interface Service<
  Self,
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends Context.Service<Self, Shape>, ServiceLike {
  readonly key: Identifier;
  new (_: never): ServiceShape<Identifier, Shape>;
  bind: <Req = never>(
    ...args: BindParameters<Parameters<Shape>, Req>
  ) => Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | Effect.Services<ReturnType<Shape>> | Req
  >;
}

type BindParameters<
  Parameters extends any[],
  Req = never,
> = Parameters extends [infer First, ...infer Rest]
  ? [
      Input<First> | Effect.Effect<First, never, Req>,
      ...BindParameters<Rest, Req>,
    ]
  : [];

/**
 * Creates a runtime binding service.
 *
 * A `Binding.Service` is the runtime-facing half of an operation such as
 * `GetItem`, `PutObject`, or `Fetch`. It is provided on the function or worker
 * effect so user code can call `.bind(resource)` and receive a typed runtime
 * API that already knows how to talk to the target resource.
 */
export const Service =
  <Self, Shape extends (...args: any[]) => Effect.Effect<any, any, any>>() =>
  <Identifier extends string>(id: Identifier) => {
    const self = Context.Service<Self, Shape>(id) as Service<
      Self,
      Identifier,
      Shape
    >;
    return Object.assign(self, {
      bind: (...args: Parameters<Shape>) =>
        self.use((f) =>
          Effect.all(
            args.map((arg) =>
              Effect.isEffect(arg) ? arg : Effect.succeed(arg),
            ),
            {
              concurrency: "unbounded",
            },
          ).pipe(Effect.flatMap((args) => f(...args))),
        ),
    });
  };

export interface PolicyLike {
  kind: "Policy";
}

export interface PolicyShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends Context.ServiceClass.Shape<Identifier, Shape>, PolicyLike {}

export interface Policy<
  in out Self,
  in out Identifier extends string,
  in out Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
> extends Effect.Effect<Shape, never, Self> {
  readonly key: Identifier;
  new (_: never): PolicyShape<Identifier, Shape>;
  layer: {
    succeed(
      fn: (
        ctx: ResourceLike,
        ...args: Parameters<Shape>
      ) => Effect.Effect<void>,
    ): Layer.Layer<Self>;
    effect<Req = never>(
      fn: Effect.Effect<
        (ctx: ResourceLike, ...args: Parameters<Shape>) => Effect.Effect<void>,
        never,
        Req
      >,
    ): Layer.Layer<Self, never, Req>;
  };
  bind(
    ...args: Parameters<Shape>
  ): Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | RuntimeContext | Effect.Services<ReturnType<Shape>>
  >;
}

/**
 * Creates a deploy-time binding policy.
 *
 * A `Binding.Policy` attaches the infrastructure-side permissions or bindings
 * that make a runtime binding usable. At deploy time it records IAM statements
 * or host bindings on the target function/worker. At runtime the layer is
 * absent, so the policy gracefully becomes a no-op.
 */
export const Policy =
  <Self, Shape extends (...args: any[]) => Effect.Effect<void, any, any>>() =>
  <Identifier extends string>(
    Identifier: Identifier,
  ): Policy<Self, `Policy<${Identifier}>`, Shape> => {
    const self = Context.Service<Self, Shape>(`Policy<${Identifier}>`);

    // we use a service option because at runtime (e.g. in a Lambda Function or Cloudflare Worker)
    // the Policy Layer is not provided and this becomes a no-op
    const Service = tryFindProviderByType<Policy<Self, Identifier, Shape>>(
      self.key as Identifier,
    ).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.flatMap((service) =>
        service
          ? Effect.succeed(service)
          : Effect.all([CurrentStack, ALCHEMY_PHASE]).pipe(
              Effect.flatMap(([stack, phase]) =>
                stack && phase === "plan"
                  ? Effect.die(
                      `Binding.Policy provider 'Policy<${Identifier}>' was not provided at Plan Time in Stack '${stack.name}'`,
                    )
                  : Effect.succeed((() => Effect.void) as any as Shape),
              ),
            ),
      ),
    );

    const asEffect = () =>
      Effect.all([Self, Service]).pipe(
        Effect.map(
          ([resource, fn]) =>
            (...args: any[]) =>
              Effect.all(
                args.map((arg) =>
                  Effect.isEffect(arg) ? arg : Effect.succeed(arg),
                ),
              ).pipe(
                Effect.flatMap((args) =>
                  fn(...args).pipe(
                    Namespace.push((resource as ResourceLike).LogicalId),
                  ),
                ),
              ),
        ),
      );
    // @ts-expect-error
    return Object.assign(self, {
      [Symbol.iterator]() {
        return new SingleShotGen(asEffect());
      },
      asEffect,
      bind: (...args: any[]) =>
        asEffect().pipe(Effect.flatMap((fn) => fn(...args))),
      layer: {
        succeed: (
          fn: (
            self: ResourceLike,
            ...args: Parameters<Shape>
          ) => Effect.Effect<void>,
        ) =>
          Layer.succeed(
            self,
            // @ts-expect-error
            (...args: Parameters<Shape>) =>
              Self.use((self) => fn(self as ResourceLike, ...args)),
          ),
        effect: (
          fn: Effect.Effect<
            (
              self: ResourceLike,
              ...args: Parameters<Shape>
            ) => Effect.Effect<void>
          >,
        ) =>
          Layer.effect(
            self,
            // @ts-expect-error
            Effect.map(
              fn,
              (fn) =>
                (...args: Parameters<Shape>) =>
                  Self.use((self) => fn(self as ResourceLike, ...args)),
            ),
          ),
      },
    });
  };

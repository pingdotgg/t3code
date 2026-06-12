import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { pipeArguments, type Pipeable } from "effect/Pipeable";
import { SingleShotGen } from "effect/Utils";
import { toFqn } from "./FQN.ts";
import type { Input, InputProps } from "./Input.ts";
import { CurrentNamespace, type NamespaceNode } from "./Namespace.ts";
import * as Output from "./Output.ts";
import { Provider } from "./Provider.ts";
import { ref as makeRef } from "./Ref.ts";
import { RemovalPolicy } from "./RemovalPolicy.ts";
import { Self } from "./Self.ts";
import { Stack } from "./Stack.ts";

export type ResourceConstructor<R extends ResourceLike, Req = never> = {
  Type: R["Type"];
  Props: R["Props"];
  <const Methods extends { [key: string]: any }>(
    methods: Methods,
  ): ResourceClassWithMethods<R, Methods>;
  (
    id: string,
    ...args: {} extends R["Props"]
      ? [
          props?: {
            [prop in keyof R["Props"]]: Input<R["Props"][prop]>;
          },
        ]
      : [
          props: {
            [prop in keyof R["Props"]]: Input<R["Props"][prop]>;
          },
        ]
  ): Effect.Effect<R, never, Req>;
  <PropsReq = never>(
    id: string,
    props: Effect.Effect<InputProps<R["Props"]>, never, PropsReq>,
  ): Effect.Effect<R, never, PropsReq | Req>;
};

export type ResourceClassWithMethods<
  R extends ResourceLike,
  Methods extends { [key: string]: any },
> = ResourceConstructor<
  R,
  R["Providers"] extends undefined ? Provider<R> : R["Providers"]
> &
  Effect.Effect<ResourceConstructor<R>> & {
    Self: Self<R>;
    Provider: Provider<R>;
    ref(
      id: string,
      options?: { stage?: string; stack?: string },
    ): Effect.Effect<R>;
  } & Methods;

export type ResourceClass<R extends ResourceLike> = ResourceConstructor<
  R,
  R["Providers"] extends undefined ? Provider<R> : R["Providers"]
> &
  Effect.Effect<ResourceConstructor<R>> & {
    Self: Self<R>;
    Provider: Provider<R>;
    ref(
      id: string,
      options?: { stage?: string; stack?: string },
    ): Effect.Effect<R>;
  };

export type LogicalId = string;

export interface ResourceBinding<Data = any> {
  sid: string;
  data: Data;
}

export interface ResourceLike<
  Type extends string = string,
  Props extends object | undefined = any,
  Attributes extends object = object,
  Binding = any,
  Providers = any,
> {
  /**
   * Namespace containing this Resource.
   */
  Namespace: NamespaceNode | undefined;
  /**
   * Fully Qualified Name (namespace path + logical ID).
   * Used as the unique key for state storage.
   */
  FQN: string;
  /**
   * Type of the Resource (e.g. AWS.Lambda.Function)
   */
  Type: Type;
  /**
   * Logical ID of the Resource (e.g. MyFunction)
   */
  LogicalId: LogicalId;
  /**
   * Properties of the Resource.
   */
  Props: Props;
  /**
   * Removal Policy of the Resource.
   */
  RemovalPolicy: RemovalPolicy["Service"];
  /** @internal phantom */
  Attributes: Attributes;
  /** @internal phantom */
  Binding: Binding;
  /** @internal phantom */
  Providers: Providers;
}

export const isResource = (value: any): value is ResourceLike => {
  return typeof value === "object" && value !== null && "Type" in value;
};

export type Resource<
  Type extends string = any,
  Props extends object | undefined = any,
  Attributes extends object = any,
  Binding = never,
  Providers = undefined,
> = Pipeable &
  ResourceLike<Type, Props, Attributes, Binding, Providers> & {
    bind(sid: Input<string>, binding: Input<Binding>): Effect.Effect<void>;
    bind(
      template: TemplateStringsArray,
      ...args: any[]
    ): (binding: Input<Binding>) => Effect.Effect<void>;
  } & {
    [attr in keyof Attributes]-?: Output.Output<Attributes[attr], never>;
  };

export interface ResourceOptions {
  /**
   * Default removal policy for this resource type when the caller has not
   * explicitly provided one via `RemovalPolicy` / `destroy()` / `retain()`.
   *
   * Useful for resources that wrap unrecoverable real-world identifiers
   * (DNS zones, customer accounts, etc.) where the safe default is to
   * leave the cloud object alone on stack destroy.
   *
   * @default "destroy"
   */
  defaultRemovalPolicy?: RemovalPolicy["Service"];
}

/**
 * Creates a resource constructor for a concrete resource type.
 *
 * The returned constructor registers the resource on the current stack,
 * resolves input props, exposes output attributes as `Output` expressions, and
 * records bindings contributed by policies and event sources. Resource
 * providers are attached separately through `.provider`.
 */
export function Resource<R extends ResourceLike>(
  type: R["Type"],
  options?: ResourceOptions,
): ResourceClass<R> {
  const defaultRemovalPolicy = options?.defaultRemovalPolicy ?? "destroy";
  type Props = Input<R["Props"]>;
  const self = Self<R>(type);
  const constructor = (
    id: string,
    props: Props | Effect.Effect<Props> | undefined,
  ) =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      const namespace = yield* CurrentNamespace;
      const fqn = toFqn(namespace, id);

      const existing = stack.resources[fqn];
      if (existing) {
        // // TODO(sam): check if props are different and die
        return existing;
      }
      const bind = (
        ...args:
          | [sid: string, data: R["Binding"]]
          | [template: TemplateStringsArray, ...args: any[]]
      ) =>
        typeof args[0] === "string"
          ? Effect.gen(function* () {
              const [sid, data] = args as [sid: string, data: R["Binding"]];
              (stack.bindings[fqn] ??= []).push({
                sid,
                data,
              });
              return undefined;
            })
          : (data: R["Binding"]) => {
              const stringifyBindArg = (arg: any): string | undefined => {
                if (arg === undefined) {
                  return undefined;
                }

                if (Array.isArray(arg)) {
                  return arg
                    .flatMap((item) => {
                      const stringified = stringifyBindArg(item);
                      return stringified === undefined ? [] : [stringified];
                    })
                    .join(", ");
                }

                if (
                  arg &&
                  (typeof arg === "object" || typeof arg === "function")
                ) {
                  if ("LogicalId" in arg && typeof arg.LogicalId === "string") {
                    return arg.LogicalId;
                  }

                  if ("id" in arg && typeof arg.id === "string") {
                    return arg.id;
                  }
                }

                return String(arg);
              };

              return bind(
                `${(args[0] as TemplateStringsArray)
                  .flatMap((text, i) => {
                    const stringified = stringifyBindArg(args[i + 1]);
                    return stringified !== undefined
                      ? [text, stringified]
                      : [text];
                  })
                  .join("")}`,
                data,
              );
            };

      const target: any = {
        Type: type,
        Namespace: namespace,
        FQN: fqn,
        LogicalId: id,
        Props: props,
        Provider: ProviderTag as Provider<any>,
        RemovalPolicy: yield* Effect.serviceOption(RemovalPolicy).pipe(
          Effect.map(Option.getOrElse(() => defaultRemovalPolicy)),
        ),
        bind,
        toString(this: typeof target) {
          return `Resource<${this.Type}>(${this.LogicalId})`;
        },
        [Symbol.toPrimitive](this: typeof target, hint: string) {
          return hint === "number" ? NaN : this.toString();
        },
      };

      const Resource: R = (stack.resources[fqn] = new Proxy(target, {
        set: (t, prop, value) => {
          t[prop as keyof typeof t] = value;
          return true;
        },
        get: (t, prop) =>
          typeof prop === "symbol" || prop in t
            ? t[prop as keyof typeof t]
            : new Output.PropExpr<any, string>(Output.of(Resource), prop),
      })) as R;
      Resource.Props = Effect.isEffect(props)
        ? yield* props.pipe(
            Effect.provideService(Self, Resource),
            Effect.provideService(Self(type), Resource),
          )
        : props;
      return Resource;
    });

  const ProviderTag = Provider(type);

  const Service = {
    [Symbol.iterator]() {
      return new SingleShotGen(this.asEffect());
    },
    pipe() {
      return pipeArguments(this, arguments);
    },
    asEffect() {
      return Effect.succeed((id: string, props: R["Props"]) =>
        constructor(id, props),
      );
    },
    /**
     * Build a typed reference to a deployed instance of this resource
     * — in the current stack/stage by default, or in another via
     * `options`. Resolves to the same shape as `yield*
     * MyResource("id", props)` so downstream code can read attributes
     * (`ref.someAttr`) exactly the way it would for a locally-declared
     * resource.
     */
    ref: (
      id: string,
      options?: { stage?: string; stack?: string },
    ): Effect.Effect<R> =>
      Effect.succeed(Output.of(makeRef<R>(id, options)) as unknown as R),

    Type: type,
    Provider: ProviderTag,
    Self: self,
  };

  const ResourceClass = Object.assign(
    (...args: [id: string, props: R["Props"]] | [methods: object]) =>
      typeof args[0] === "object"
        ? Object.assign(ResourceClass, args[0])
        : constructor(...(args as [string, R["Props"]])),
    Service,
  ) as any;

  return ResourceClass;
}

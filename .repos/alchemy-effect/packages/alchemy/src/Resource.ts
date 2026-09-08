import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Pipeable } from "effect/Pipeable";
import { AdoptPolicy } from "./AdoptPolicy.ts";
import { toFqn } from "./FQN.ts";
import type { Input, InputProps, PropsInput } from "./Input.ts";
import { CurrentNamespace, type NamespaceNode } from "./Namespace.ts";
import * as Output from "./Output.ts";
import { Provider } from "./Provider.ts";
import {
  ConflictingProviderModeError,
  ProviderModePolicy,
  type ProviderMode,
} from "./ProviderMode.ts";
import { ref as makeRef } from "./Ref.ts";
import { RemovalPolicy } from "./RemovalPolicy.ts";
import { RenamePolicy } from "./Rename.ts";
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
    // PropsInput distributes over union Props so discriminated-union
    // resources keep the correlation between discriminant and payload.
    ...args: {} extends R["Props"]
      ? [props?: PropsInput<R["Props"]>]
      : [props: PropsInput<R["Props"]>]
  ): Effect.Effect<R, never, Req>;
  <PropsReq = never>(
    id: string,
    props: Effect.Effect<InputProps<R["Props"]>, never, PropsReq>,
  ): Effect.Effect<R, never, PropsReq | Req>;
};

export interface ResourceClassLike<R extends ResourceLike> {
  Type: R["Type"];
  Props: R["Props"];
  Self: Self<R>;
  Provider: Provider<R>;
  /**
   * Legacy type names this resource was previously registered under
   * (see {@link ResourceOptions.aliases}). Copied onto the
   * `ProviderService` by `Provider.succeed`/`Provider.effect` so provider
   * lookup can resolve state persisted under a pre-rename type.
   *
   * `undefined` is accepted explicitly so `ResourceClass` (whose `Aliases`
   * is `readonly string[] | undefined`) stays assignable to
   * `ResourceClassLike` under `exactOptionalPropertyTypes`.
   */
  Aliases?: readonly string[] | undefined;
}

export type ResourceClass<R extends ResourceLike> = ResourceConstructor<
  R,
  R["Providers"] extends undefined ? Provider<R> : R["Providers"]
> &
  Effect.Effect<ResourceConstructor<R>> & {
    Self: Self<R>;
    Provider: Provider<R>;
    Aliases: readonly string[] | undefined;
    ref(
      id: string,
      options?: { stage?: string; stack?: string },
    ): Effect.Effect<R>;
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
    Aliases: readonly string[] | undefined;
    ref(
      id: string,
      options?: { stage?: string; stack?: string },
    ): Effect.Effect<R>;
  } & Methods;

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
  /**
   * Per-resource adoption policy captured from the ambient {@link AdoptPolicy}
   * at registration time (e.g. via `.pipe(adopt(true))`). `undefined` means no
   * resource-scoped override — the planner falls back to the stack/CLI default.
   */
  Adopt: boolean | undefined;
  /**
   * Per-resource provider mode captured from the ambient
   * {@link ProviderModePolicy} at registration time. `"live"` when the
   * resource was pinned via `.pipe(remote())` (opting out of local emulation
   * during dev); `undefined` means the run default (`AlchemyContext.dev`).
   */
  Mode: ProviderMode | undefined;
  /**
   * Copied from {@link ResourceOptions.requiresImplementation} at
   * registration: `true` for platform-typed resources, whose registrations
   * must have resolved {@link Props} by plan time. `Plan.make` fails fast
   * with {@link MissingImplementationError} when this is set and `Props`
   * are still `undefined` after the whole program has evaluated — a bare
   * tag was yielded but its `.make(props, impl)` Layer was never provided.
   */
  RequiresImplementation: boolean | undefined;
  /**
   * Former FQNs this resource's state may still be persisted under,
   * captured from the ambient {@link RenamePolicy} at registration (via
   * `.pipe(renamedFrom("OldId"))`) and resolved against the same namespace
   * as the resource's own FQN. The planner migrates a state row found at a
   * former FQN to {@link FQN} instead of planning a create+delete
   * replacement — see `renamedFrom` in Rename.ts for the full semantics.
   */
  FormerFqns: readonly string[] | undefined;
  /** @internal phantom */
  Attributes: Attributes;
  /** @internal phantom */
  Binding: Binding;
  /** @internal phantom */
  Providers: Providers;
}

export const isResource = (value: any): value is ResourceLike => {
  // Require the full resource identity (Type AND FQN), not just `Type`:
  // user-authored prop objects legitimately carry a `Type` field (e.g.
  // Amazon States Language states like `{ Type: "Pass", End: true }` in a
  // Step Functions definition) and must not be mistaken for resources.
  // Locally-declared resources always expose both as own keys; refs
  // (`Resource.ref(...)`) deliberately report neither via `in` so they keep
  // routing through Output resolution.
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    "FQN" in value
  );
};

/**
 * Does `value` reference an instance of the resource type `type` —
 * either a locally-declared resource or a `Resource.ref(...)` to one?
 *
 * Two constraints that ad-hoc guards get wrong for refs, which resolve
 * to Output-expression proxies:
 *
 * - Read `.Type` via property access (never `in`): the proxy answers
 *   property reads with statically-known values but deliberately does
 *   not report key existence (so {@link isResource} keeps routing refs
 *   through Output resolution instead of the upstream-node lookup).
 * - Accept `typeof value === "function"`: the proxy's target is
 *   callable (it needs an `apply` trap), so refs are not `"object"`.
 *
 * Either mistake silently rejects refs — in a Worker `env` that
 * degrades the binding to a plain JSON var.
 */
export const isResourceOfType = (value: unknown, type: string): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as { Type?: unknown }).Type === type;

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
    [attr in keyof Attributes]-?: AttrOutput<Attributes[attr]>;
  };

/**
 * Accessor type for one attribute. Pure object attributes upgrade to
 * {@link Output.ObjectExpr} so nested access is typed —
 * `hyperpod.instanceGroups.workers` — while primitives, unions with
 * `undefined`, branded string unions (`"a" | (string & {})`), and arrays
 * stay plain {@link Output.Output} (running them through `ToOutput` would
 * classify the `string & {}` branch as an object and explode into
 * String-method mapped types).
 */
type AttrOutput<A> = [A] extends [
  string | number | boolean | bigint | null | undefined | Date | any[],
]
  ? Output.Output<A, never>
  : [A] extends [Record<string, any>]
    ? Output.ObjectExpr<A, never>
    : Output.Output<A, never>;

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
  /**
   * Legacy type names this resource was previously registered under.
   *
   * When a resource type is renamed (e.g. `"Cloudflare.Queue"` →
   * `"Cloudflare.Queues.Queue"`), state persisted under the old name must
   * still resolve to this resource's provider. Listing the old names here
   * makes provider lookup fall back from the legacy name to this type, so
   * existing stacks keep planning, updating, and deleting cleanly across
   * the rename. The state row migrates to the new type on its next write.
   *
   * ```ts
   * export const Queue = Resource<Queue>("Cloudflare.Queues.Queue", {
   *   aliases: ["Cloudflare.Queue"],
   * });
   * ```
   */
  aliases?: string[];
  /**
   * Marks every registration of this type as requiring resolved props by
   * plan time. Set by `Platform(...)` on its resource class: every
   * legitimate platform construction (a `.make(props, impl)` Layer build,
   * a tag declared with props, a plain `Worker("id", props)` call) produces
   * defined `Props` — the only way a platform-typed registration reaches
   * the planner with `Props === undefined` is a bare-tag FORWARD REFERENCE
   * whose `.make` Layer never built. `Plan.make` fails fast with
   * {@link MissingImplementationError} in that case, instead of letting a
   * provider read `undefined` props. Plain (non-platform) resources leave
   * this unset so a no-props reference yield (`yield* Queue("MyQueue")`)
   * keeps planning as a noop.
   */
  requiresImplementation?: boolean;
}

/**
 * A tagged platform resource declared with neither props nor an inline
 * implementation was `yield*`ed, but its `.make(props, impl)` Layer never
 * built.
 *
 * Such a tag carries no configuration on its own — props AND impl both live
 * on the Layer — so its registration is a forward reference with `undefined`
 * props that the Layer's build repairs (in either order; see the #874
 * circular env-tag pattern). Props still `undefined` once the whole program
 * has evaluated means the Layer was never provided; `Plan.make` fails fast
 * with this error instead of letting the failure surface deep inside
 * whichever provider first reads a prop (e.g. `TypeError: undefined is not
 * an object (evaluating 'news.name')` in the Cloudflare Worker pre-create).
 */
export class MissingImplementationError extends Data.TaggedError(
  "MissingImplementationError",
)<{
  message: string;
  /** Resource type of the platform, e.g. `Cloudflare.Worker`. */
  type: string;
  /** Logical id of the tagged resource (its class name by convention). */
  id: string;
}> {}

export const missingImplementation = (type: string, id: string) =>
  new MissingImplementationError({
    type,
    id,
    message: [
      `${type}<${id}> was yielded without its implementation.`,
      "",
      `\`${id}\` is declared as a bare tag — no props, no inline implementation — so both come from its \`.make(...)\` Layer:`,
      "",
      `  export class ${id} extends ${type}<${id}>()("${id}") {}`,
      `  export const ${id}Live = ${id}.make({ /* props */ }, Effect.gen(function* () { /* ... */ }));`,
      "",
      `That Layer is not in scope where \`${id}\` is yielded. Provide it to the Stack's program:`,
      "",
      "  Alchemy.Stack(",
      `    "my-stack",`,
      "    { providers, state },",
      "    Effect.gen(function* () {",
      `      const instance = yield* ${id};`,
      `    }).pipe(Effect.provide([${id}Live])),`,
      "  )",
      "",
      `If \`${id}\` is not Effect-native, declare it with props instead: \`()("${id}", { /* props */ })\`.`,
    ].join("\n"),
  });

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

      // `remote()` opts resources out of local emulation during dev. The
      // captured Mode is either "live" (pinned) or undefined (run default).
      // The Reference default is `undefined` — "no explicit decoration" —
      // which is distinct from an explicit `remote(false)`.
      const ambientPolicy = yield* ProviderModePolicy;
      const ambientMode: ProviderMode | undefined = ambientPolicy
        ? "live"
        : undefined;

      const existing = stack.resources[fqn];
      if (existing) {
        // A resource may be `yield*`ed from several places (idempotent
        // registration). If a later site carries an *explicit* ambient
        // ProviderModePolicy that disagrees with what the resource was
        // registered with, the decorations are conflicting — fail loudly
        // instead of silently picking one. A later site with NO ambient
        // policy simply inherits the registered resource (the common
        // "reference it from elsewhere" pattern).
        if (ambientPolicy !== undefined && existing.Mode !== ambientMode) {
          return yield* Effect.die(
            new ConflictingProviderModeError({
              message:
                `Resource '${fqn}' was registered with provider mode ` +
                `'${existing.Mode ?? "default"}' but is now being registered ` +
                `with conflicting mode '${ambientMode ?? "default"}'. A ` +
                "resource must resolve to a single provider mode: register " +
                "it once and close over the returned value, or make both " +
                "registration sites agree (e.g. wrap both in the same " +
                "`remote()` scope).",
              fqn,
              existingMode: existing.Mode,
              conflictingMode: ambientMode,
            }),
          );
        }
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
        Adopt: yield* Effect.serviceOption(AdoptPolicy).pipe(
          Effect.map(Option.getOrUndefined),
        ),
        Mode: ambientMode,
        RequiresImplementation: options?.requiresImplementation || undefined,
        // Bare-string former ids resolve against the SAME namespace as the
        // resource's own id, so `renamedFrom("Site/Worker")` declared at the
        // caller's level claims `<callerNs>/Site/Worker`; the `{ fqn }` form
        // is absolute (cross-namespace moves).
        FormerFqns: yield* Effect.serviceOption(RenamePolicy).pipe(
          Effect.map(
            Option.match({
              onNone: () => undefined,
              onSome: (formerIds) =>
                formerIds.map((formerId) =>
                  typeof formerId === "string"
                    ? toFqn(namespace, formerId)
                    : formerId.fqn,
                ),
            }),
          ),
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
        ? // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          yield* props.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(Self, Resource),
                Layer.succeed(Self(type), Resource),
              ),
            ),
          )
        : props;
      return Resource;
    });

  const ProviderTag = Provider(type);

  const Service = {
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
      Effect.succeed(Output.of(makeRef<R>(id, options, type)) as unknown as R),

    Type: type,
    Provider: ProviderTag,
    Self: self,
    Aliases: options?.aliases,
  };

  const ResourceClass = Object.assign(
    (...args: [id: string, props: R["Props"]] | [methods: object]) =>
      typeof args[0] === "object"
        ? Object.assign(ResourceClass, args[0])
        : constructor(...(args as [string, R["Props"]])),
    Service,
    // Make the constructor itself a real Effect: `yield* MyResource` resolves
    // to the constructor function (same as the old `asEffect()`), and
    // `Effect.isEffect(MyResource)` is now true so `Effect.all`/`forEach` work.
    Effectable.Prototype({
      label: `Resource<${type}>`,
      evaluate: () =>
        Effect.succeed((id: string, props: R["Props"]) =>
          constructor(id, props),
        ),
    }),
  ) as any;

  return ResourceClass;
}

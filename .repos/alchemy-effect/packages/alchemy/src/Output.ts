import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import type { Pipeable } from "effect/Pipeable";
import * as Redacted from "effect/Redacted";
import { SingleShotGen } from "effect/Utils";
import { getRefMetadata, isRef, type Ref } from "./Ref.ts";
import { isResource, type Resource, type ResourceLike } from "./Resource.ts";
import { RuntimeContext, sanitizeKey } from "./RuntimeContext.ts";
import { Stack } from "./Stack.ts";
import { Stage } from "./Stage.ts";
import * as State from "./State/State.ts";
import { isPrimitive } from "./Util/data.ts";

const inspect = Symbol.for("nodejs.util.inspect.custom");

export const of = <R extends ResourceLike>(
  resource: Ref<R> | R,
): R extends ResourceLike
  ? ResourceExpr<R["Attributes"]>
  : RefExpr<R["Attributes"]> => {
  if (isRef(resource)) {
    const metadata = getRefMetadata(resource);
    return new RefExpr(metadata.stack, metadata.stage, metadata.id) as any;
  }
  return new ResourceExpr(resource) as any;
};

export const asOutput = <T>(t: T | Output<T> | Effect.Effect<T>): Output<T> =>
  isOutput(t)
    ? t
    : Effect.isEffect(t)
      ? new EffectExpr(VoidExpr, () => t)
      : new LiteralExpr(t);

export const isOutput = (value: any): value is Output<any> =>
  value &&
  (typeof value === "object" || typeof value === "function") &&
  ExprSymbol in value;

export interface Output<A = any, Req = any> extends Pipeable {
  /** @internal phantom */
  readonly kind: string;
  /** @internal phantom */
  readonly A: A;
  /** @internal phantom */
  readonly req: Req;
  /** @internal phantom */
  [Symbol.iterator](): Iterator<
    Effect.Effect<void, never, Req>,
    Accessor<A>,
    void
  >;
  bind(id: string): Effect.Effect<Effect.Effect<A>, never, RuntimeContext>;
  asEffect(): Effect.Effect<Accessor<A>, never, Req>;
  as<T>(): Output<T, Req>;
}

export interface Accessor<A> extends Effect.Effect<A> {}

export type ToOutput<A, Req = never> = [Extract<A, object>] extends [never]
  ? Output<A, Req>
  : [Extract<A, any[]>] extends [never]
    ? ObjectExpr<
        {
          [attr in keyof A]: A[attr];
        },
        Req
      >
    : ArrayExpr<Extract<A, any[]>, Req>;

export const ExprSymbol = Symbol.for("alchemy/Expr");

export const isExpr = (value: any): value is Expr<any> =>
  value &&
  (typeof value === "object" || typeof value === "function") &&
  ExprSymbol in value;

export type Expr<A = any, Req = any> =
  | AllExpr<Expr<A, Req>[]>
  | ApplyExpr<any, A, Req>
  | EffectExpr<any, A, Req>
  | FlatMapExpr<any, A, Req>
  | LiteralExpr<A>
  | NamedExpr<A, Req>
  | PropExpr<A, keyof A, Req>
  | ResourceExpr<A, Req>
  | RefExpr<A>
  | StackRefExpr<A>;

export abstract class BaseExpr<A = any, Req = any> implements Output<A, Req> {
  declare readonly kind: any;
  declare readonly A: A;
  declare readonly src: ResourceLike;
  declare readonly req: Req;
  // we use a kind tag instead of instanceof to protect ourselves from duplicate alchemy module imports
  constructor() {}
  as<T>(): Output<T, Req> {
    return this as any;
  }

  [Symbol.iterator](): Iterator<
    Effect.Effect<void, never, Req>,
    Accessor<A>,
    void
  > {
    // @ts-expect-error - TODO(sam): fix this (works at runtime, but maybe indicates a bad assumption)
    return new SingleShotGen(this.asEffect());
  }

  asEffect(): any {
    return this.bind(this.toString());
  }

  public bind(id: string): any {
    // `set`/`get` store keys verbatim, so canonicalize here (the caller's job).
    const key = sanitizeKey(id);
    return RuntimeContext.pipe(
      Effect.flatMap((ctx) =>
        Effect.map(ctx.set(key, this), (k) => ctx.get<A>(k)),
      ),
    );
  }

  public pipe(...fns: any[]): any {
    // @ts-expect-error
    return pipe(this, ...fns);
  }
  public abstract [inspect](): string;
  public toString(): string {
    return this[inspect]();
  }
}
export type ObjectExpr<A, Req = any> = Output<A, Req> & {
  [Prop in keyof Exclude<A, undefined>]-?: ToOutput<
    Exclude<A, undefined>[Prop] | Extract<A, undefined>,
    Req
  >;
};

export type ArrayExpr<A extends any[], Req = any> = Output<A, Req> & {
  [i in Extract<keyof A, number>]: ToOutput<A[i], Req>;
};

export const isResourceExpr = <Value = any, Req = any>(
  node: Expr<Value, Req> | any,
): node is ResourceExpr<Value, Req> => node?.kind === "ResourceExpr";

export class ResourceExpr<Value, Req = never> extends BaseExpr<Value, Req> {
  readonly kind = "ResourceExpr";
  constructor(
    readonly src: ResourceLike,
    readonly stables?: Record<string, any>,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return this.src.LogicalId;
  }
}

export const isPropExpr = <A = any, Prop extends keyof A = keyof A, Req = any>(
  node: any,
): node is PropExpr<A, Prop, Req> => node?.kind === "PropExpr";

export class PropExpr<
  A = any,
  Id extends keyof A = keyof A,
  Req = any,
> extends BaseExpr<A[Id], Req> {
  readonly kind = "PropExpr";
  constructor(
    public readonly expr: Expr<A, Req>,
    public readonly identifier: Id,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `${this.expr[inspect]()}.${this.identifier.toString()}`;
  }
}

export const literal = <A>(value: A) => new LiteralExpr(value);

export const isLiteralExpr = <A = any>(node: any): node is LiteralExpr<A> =>
  node?.kind === "LiteralExpr";

export class LiteralExpr<A> extends BaseExpr<A, never> {
  readonly kind = "LiteralExpr";
  constructor(public readonly value: A) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return String(this.value);
  }
}

export const VoidExpr = new LiteralExpr(void 0);

export const map: {
  <A, B>(
    fn: (value: A) => B,
  ): <Req>(output: Output<A, Req>) => ToOutput<B, Req>;
  <A, B, Req>(output: Output<A, Req>, fn: (value: A) => B): ToOutput<B, Req>;
} = (<A, B, Req>(
  ...args: [fn: (value: A) => B] | [output: Output<A, Req>, fn: (value: A) => B]
) =>
  args.length === 1
    ? <Req>(output: Output<A, Req>): ToOutput<B, Req> =>
        new ApplyExpr(output as Expr<A, Req>, args[0]) as any
    : new ApplyExpr(args[0] as any, args[1])) as any;

//Output.ApplyExpr<any, any, ResourceLike, any>
export const isApplyExpr = <In = any, Out = any, Req = any>(
  node: Output<Out, Req>,
): node is ApplyExpr<In, Out, Req> => node?.kind === "ApplyExpr";

export class ApplyExpr<A, B, Req = never> extends BaseExpr<B, Req> {
  readonly kind = "ApplyExpr";
  constructor(
    public readonly expr: Expr<A, Req>,
    public readonly f: (value: A) => B,
  ) {
    super();
    return proxy(this);
  }

  [inspect](): string {
    return `${this.expr[inspect]()}.map(${this.f.toString()})`;
  }
}

export const mapEffect =
  <A, B, Req2>(fn: (value: A) => Effect.Effect<B, never, Req2>) =>
  <Req>(output: Output<A, Req>): ToOutput<B, Req | Req2> =>
    new EffectExpr(output as Expr<A, Req>, fn) as any;

export const flatMap: {
  <A, B, Req2>(
    fn: (value: A) => Output<B, Req2>,
  ): <Req>(output: Output<A, Req>) => ToOutput<B, Req | Req2>;
  <A, B, Req, Req2>(
    output: Output<A, Req>,
    fn: (value: A) => Output<B, Req2>,
  ): ToOutput<B, Req | Req2>;
} = (<A, B, Req, Req2>(
  ...args:
    | [fn: (value: A) => Output<B, Req2>]
    | [output: Output<A, Req>, fn: (value: A) => Output<B, Req2>]
) =>
  args.length === 1
    ? <Req>(output: Output<A, Req>): ToOutput<B, Req | Req2> =>
        new FlatMapExpr(output as Expr<A, Req>, args[0]) as any
    : new FlatMapExpr(args[0] as any, args[1])) as any;

export const isFlatMapExpr = <In = any, Out = any, Req = any, Req2 = any>(
  node: any,
): node is FlatMapExpr<In, Out, Req, Req2> => node?.kind === "FlatMapExpr";

export class FlatMapExpr<A, B, Req = never, Req2 = never> extends BaseExpr<
  B,
  Req | Req2
> {
  readonly kind = "FlatMapExpr";
  constructor(
    public readonly expr: Expr<A, Req>,
    public readonly f: (value: A) => Output<B, Req2>,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `${this.expr[inspect]()}.flatMap(${this.f.toString()})`;
  }
}

export const isEffectExpr = <In = any, Out = any, Req = any, Req2 = any>(
  node: any,
): node is EffectExpr<In, Out, Req, Req2> => node?.kind === "EffectExpr";

export class EffectExpr<A, B, Req = never, Req2 = never> extends BaseExpr<
  B,
  Req
> {
  readonly kind = "EffectExpr";
  constructor(
    public readonly expr: Expr<A, Req>,
    public readonly f: (value: A) => Effect.Effect<B, never, Req2>,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `${this.expr[inspect]()}.mapEffect(${this.f.toString()})`;
  }
}

export const isNamedExpr = <A = any, Req = any>(
  node: any,
): node is NamedExpr<A, Req> => node?.kind === "NamedExpr";

/**
 * Wraps another `Expr` and overrides its `toString()` / inspect output.
 *
 * `BaseExpr` derives the binding id from `this.toString()`, so
 * wrapping an expression in `NamedExpr` makes that derived id stable and
 * caller-controlled (e.g. an env var name like `"API_KEY"`).
 */
export class NamedExpr<A, Req = never> extends BaseExpr<A, Req> {
  readonly kind = "NamedExpr";
  constructor(
    public readonly expr: Expr<A, Req>,
    public readonly bindingName: string,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return this.bindingName;
  }
}

export const named = <A, Req>(
  expr: Output<A, Req>,
  name: string,
): Output<A, Req> => new NamedExpr(expr as Expr<A, Req>, name) as any;

export const all = <Outs extends (Output | Expr)[]>(...outs: Outs) =>
  new AllExpr(outs as any) as unknown as All<Outs>;

export type All<Outs extends (Output | Expr)[]> = number extends Outs["length"]
  ? [Outs[number]] extends [
      Output<infer V, infer Req> | Expr<infer V, infer Req>,
    ]
    ? Output<V, Req>
    : never
  : Tuple<Outs>;

type Tuple<
  Outs extends (Output | Expr)[],
  Values extends any[] = [],
  Req = never,
> = Outs extends [infer H, ...infer Tail extends (Output | Expr)[]]
  ? H extends Output<infer V, infer Req2>
    ? Tuple<Tail, [...Values, V], Req | Req2>
    : never
  : Output<Values, Req>;

export const isAllExpr = <Outs extends Expr[] = Expr[]>(
  node: any,
): node is AllExpr<Outs> => node?.kind === "AllExpr";

export class AllExpr<Outs extends Expr[]> extends BaseExpr<Outs> {
  readonly kind = "AllExpr";
  constructor(public readonly outs: Outs) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `all(${this.outs.map((out) => out[inspect]()).join(", ")})`;
  }
}

export const isRefExpr = <A = any>(node: any): node is RefExpr<A> =>
  node?.kind === "RefExpr";

export class RefExpr<A> extends BaseExpr<A, never> {
  readonly kind = "RefExpr";
  constructor(
    public readonly stack: string | undefined,
    public readonly stage: string | undefined,
    public readonly resourceId: string,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `ref(${this.resourceId}, { stack: ${this.stack}, stage: ${this.stage} })`;
  }
}

export const isStackRefExpr = <A = any>(node: any): node is StackRefExpr<A> =>
  node?.kind === "StackRefExpr";

/**
 * A reference to the persisted output of a Stack at `(stack, stage)`.
 *
 * Resolved at evaluation time by reading `state.getOutput({ stack,
 * stage })`. Distinct from {@link RefExpr}, which references a
 * single resource's attributes within a stack/stage. `stage` may be
 * `undefined`, in which case it falls back to the current stage.
 */
export class StackRefExpr<A> extends BaseExpr<A, never> {
  readonly kind = "StackRefExpr";
  constructor(
    public readonly stack: string,
    public readonly stage: string | undefined,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `stackRef(${this.stack}${
      this.stage ? `, { stage: ${this.stage} }` : ""
    })`;
  }
}

/**
 * Build an `Output<A>` referencing the persisted output of another
 * Stack. The returned Effect resolves to a lazy `Output<A>` whose
 * value is read from the state store at plan/apply time.
 *
 * Returns `Effect<Output<A>>` (not `Output<A>` directly) so that
 * `yield* Output.stackRef(...)` reads ergonomically inside an Effect
 * generator and lines up with `Resource.ref` and `Stack.stage.<name>`.
 */
export const stackRef = <A>(
  stack: string,
  options: { stage?: string } = {},
): Effect.Effect<Output<A, never>> =>
  Effect.succeed(new StackRefExpr<A>(stack, options.stage) as any);

export const filter = <Outs extends any[]>(...outs: Outs) =>
  outs.filter(isOutput) as unknown as Filter<Outs>;

export type Filter<Outs extends any[]> = number extends Outs["length"]
  ? Output<
      Extract<Outs[number], Output>["value"],
      Extract<Outs[number], Output>["req"]
    >
  : FilterTuple<Outs>;

export type FilterTuple<
  Outs extends (Output | Expr)[],
  Values extends any[] = [],
> = Outs extends [infer H, ...infer Tail extends (Output | Expr)[]]
  ? H extends Output<infer V>
    ? FilterTuple<Tail, [...Values, V]>
    : FilterTuple<Tail, Values>
  : Output<Values>;

export const interpolate = <Args extends any[]>(
  template: TemplateStringsArray,
  ...args: Args
): All<Args> extends Output<any, infer Req> ? Output<string, Req> : never =>
  all(...args.map((arg) => (isOutput(arg) ? arg : literal(arg)))).pipe(
    map((args) =>
      template
        .map((str, i) => str + (args[i] == null ? "" : String(args[i])))
        .join(""),
    ),
  ) as any;

function proxy(self: any): any {
  const target = Object.assign(() => {}, self);
  if (inspect in self) {
    Object.defineProperty(target, inspect, {
      value: self[inspect].bind(self),
      configurable: true,
    });
  }
  const proxy = new Proxy(target, {
    has: (_, prop) =>
      prop === ExprSymbol || prop === inspect ? true : prop in self,
    get: (target, prop) =>
      prop === Symbol.toPrimitive
        ? (hint: string) => {
            // Any JS-level coercion of an unresolved Output produces a
            // placeholder that *looks* like a real value but isn't:
            //
            //   - `string` / `default` hints (`${output}`, `output + ""`,
            //     `==` against a primitive) previously fell through to
            //     `self.toString()` and returned the inspect form
            //     (e.g. "tunnel.tunnelId"). The bogus string flowed
            //     into resource props and into the cloud — only
            //     surfacing as an opaque downstream error (see PR
            //     description for a real Cloudflare DNS landing).
            //
            //   - `number` hint (`+output`, `output * 2`,
            //     `Math.max(0, output)`) previously returned NaN, which
            //     propagates silently through arithmetic and lands as
            //     "the API rejected a NaN field" much later.
            //
            // All three hints fail loud at the coercion site with a
            // pointer to the right composition API.
            throw new Error(
              `Cannot coerce Output<${self[inspect]()}> to a ` +
                `${hint === "number" ? "number" : "string"} via JS coercion. ` +
                `Use Output.interpolate\`...\` or Output.map(output, fn) ` +
                `to compose Outputs — the value isn't known until deploy time.`,
            );
          }
        : prop === ExprSymbol
          ? self
          : prop === inspect
            ? target[inspect]
            : isResourceExpr(self) && self.stables && prop in self.stables
              ? self.stables[prop as keyof typeof self.stables]
              : prop in self
                ? typeof self[prop as keyof typeof self] === "function" &&
                  !("kind" in self)
                  ? new PropExpr(proxy, prop as never)
                  : self[prop as keyof typeof self]
                : new PropExpr(proxy, prop as never),
    apply: (_, thisArg, args) => {
      if (isPropExpr(self)) {
        // Method-style combinators on an Output proxy. `map`/`apply` and
        // `mapEffect`/`effect` are aliases that mirror the standalone
        // `Output.map` / `Output.mapEffect` / `Output.flatMap` functions.
        if (self.identifier === "map" || self.identifier === "apply") {
          return new ApplyExpr(self.expr, args[0]);
        } else if (
          self.identifier === "mapEffect" ||
          self.identifier === "effect"
        ) {
          return new EffectExpr(self.expr, args[0]);
        } else if (self.identifier === "flatMap") {
          return new FlatMapExpr(self.expr, args[0]);
        }
      }
      return undefined;
    },
  });
  return proxy;
}

/// Evaluation

export class MissingSourceError extends Data.TaggedError("MissingSourceError")<{
  message: string;
  srcId: string;
}> {}

export class InvalidReferenceError extends Data.TaggedError(
  "InvalidReferenceError",
)<{
  message: string;
  stack: string;
  stage: string;
  resourceId: string;
}> {}

export const evaluate: <A, Req = never>(
  expr: Output<A, Req> | A,
  upstream: {
    [Id in string]: any;
  },
) => Effect.Effect<
  A,
  InvalidReferenceError | MissingSourceError,
  State.State | Req
> = (expr, upstream) =>
  Effect.gen(function* () {
    if (isResource(expr)) {
      const srcId = expr.FQN;
      const src = upstream[srcId as keyof typeof upstream];
      if (!src) {
        // type-safety should prevent this but let the caller decide how to handle it
        return yield* new MissingSourceError({
          message: `Source ${srcId} not found`,
          srcId,
        });
      }
      return src;
    } else if (isOutput(expr)) {
      if (isResourceExpr(expr)) {
        const srcId = expr.src.FQN;
        const src = upstream[srcId as keyof typeof upstream];
        if (!src) {
          // type-safety should prevent this but let the caller decide how to handle it
          return yield* new MissingSourceError({
            message: `Source ${srcId} not found`,
            srcId,
          });
        }
        return src;
      } else if (isLiteralExpr(expr)) {
        return expr.value;
      } else if (isApplyExpr(expr)) {
        return expr.f(yield* evaluate(expr.expr, upstream));
      } else if (isEffectExpr(expr)) {
        // TODO(sam): the same effect shoudl be memoized so that it's not run multiple times
        return yield* expr.f(yield* evaluate(expr.expr, upstream));
      } else if (isFlatMapExpr(expr)) {
        // Resolve the source, hand it to `f` to produce a new Output, then
        // recursively evaluate that Output (flattening one level).
        const value = yield* evaluate(expr.expr, upstream);
        return yield* evaluate(expr.f(value), upstream);
      } else if (isAllExpr(expr)) {
        return yield* Effect.all(
          expr.outs.map((out) => evaluate(out, upstream)),
        );
      } else if (isPropExpr(expr)) {
        return (yield* evaluate(expr.expr, upstream))?.[expr.identifier];
      } else if (isNamedExpr(expr)) {
        return yield* evaluate(expr.expr, upstream);
      } else if (isRefExpr(expr)) {
        const state = yield* yield* State.State;
        const stack = expr.stack ?? (yield* Stack).name;
        const stage = expr.stage ?? (yield* Stage);
        const resource = yield* state.get({
          stack,
          stage,
          fqn: expr.resourceId,
        });
        if (!resource) {
          return yield* Effect.fail(
            new InvalidReferenceError({
              message: `Reference to '${expr.resourceId}' in stack '${stack}' and stage '${stage}' not found. Have you deployed '${stage}' or '${stack}'?`,
              stack,
              stage,
              resourceId: expr.resourceId,
            }),
          );
        }
        // RefExpr targets persisted resources; tasks aren't cross-stack
        // referenceable. Return the resource's output attrs, otherwise the
        // task's output value, otherwise undefined.
        return (resource as any).attr ?? (resource as any).output;
      } else if (isStackRefExpr(expr)) {
        const state = yield* yield* State.State;
        const stack = expr.stack;
        const stage = expr.stage ?? (yield* Stage);
        const output = yield* state.getOutput({ stack, stage });
        if (output == null) {
          return yield* Effect.fail(
            new InvalidReferenceError({
              message: `Reference to stack '${stack}' at stage '${stage}' not found. Have you deployed stage '${stage}' of '${stack}'?`,
              stack,
              stage,
              resourceId: stack,
            }),
          );
        }
        return output;
      }
    }
    if (Array.isArray(expr)) {
      return yield* Effect.all(expr.map((item) => evaluate(item, upstream)));
    } else if (Redacted.isRedacted(expr)) {
      return expr;
    } else if (Duration.isDuration(expr)) {
      // Opaque value — see resolveInput in Plan.ts for rationale.
      return expr;
    } else if (typeof expr === "object" && expr !== null) {
      return Object.fromEntries(
        yield* Effect.all(
          Object.entries(expr).map(([key, value]) =>
            evaluate(value, upstream).pipe(Effect.map((value) => [key, value])),
          ),
        ),
      );
    }
    return expr;
  }) as Effect.Effect<any>;

export const hasOutputs = (value: any): value is Output<any, any> =>
  Object.keys(upstreamAny(value)).length > 0;

export const upstreamAny = (
  value: any,
): {
  [ID in string]: Resource;
} => {
  if (isResource(value)) {
    return { [value.FQN]: value as Resource };
  } else if (isExpr(value)) {
    return upstream(value);
  } else if (Array.isArray(value)) {
    return Object.assign({}, ...value.map(resolveUpstream));
  } else if (
    value &&
    (typeof value === "object" || typeof value === "function")
  ) {
    return Object.assign(
      {},
      ...Object.values(value).map((value) => resolveUpstream(value)),
    );
  }
  return {};
};

// TODO(sam): add a type
export const upstream = <E extends Output<any, any>>(expr: E): any => {
  if (isResource(expr)) {
    return {
      [(expr as unknown as Resource).FQN]: expr,
    };
  } else if (isResourceExpr(expr)) {
    return {
      [expr.src.FQN]: expr.src,
    };
  } else if (isPropExpr(expr)) {
    return upstream(expr.expr);
  } else if (isAllExpr(expr)) {
    return Object.assign({}, ...expr.outs.map((out) => upstream(out)));
  } else if (
    isEffectExpr(expr) ||
    isApplyExpr(expr) ||
    isFlatMapExpr(expr) ||
    isNamedExpr(expr)
  ) {
    return upstream(expr.expr);
  } else if (Array.isArray(expr)) {
    return expr.map(upstream).reduce(toObject, {});
  } else if (typeof expr === "object" && expr !== null) {
    return Object.values(expr)
      .map((v) => upstream(v))
      .reduce(toObject, {});
  }
  return {};
};

// TODO(sam): add a type
export const resolveUpstream = <const A>(value: A): any => {
  if (isPrimitive(value)) {
    return {} as any;
  } else if (isResource(value)) {
    return { [(value as unknown as Resource).FQN]: value } as any;
  } else if (isOutput(value)) {
    return upstream(value) as any;
  } else if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((v) => resolveUpstream(v)).flatMap(Object.entries),
    ) as any;
  } else if (typeof value === "object" || typeof value === "function") {
    return Object.fromEntries(
      Object.values(value as any)
        .map(resolveUpstream)
        .flatMap(Object.entries),
    ) as any;
  }
  return {} as any;
};

const toObject = <A, B>(acc: B, v: A) => ({
  ...acc,
  ...v,
});

export const log = <A>(_value: A) =>
  Effect.gen(function* () {
    // TODO(sam): implement a log effect
  });

export const toEnvKey = <const ID extends string, const Suffix extends string>(
  id: ID,
  suffix: Suffix,
) => `${replace(toUpper(id))}_${replace(toUpper(suffix))}` as const;

export const toUpper = <const S extends string>(str: S) =>
  str.toUpperCase() as string extends S ? S : Uppercase<S>;

const replace = <const S extends string>(str: S) =>
  str.replace(/-/g, "_") as Replace<S>;

type Replace<S extends string, Accum extends string = ""> = string extends S
  ? S
  : S extends ""
    ? Accum
    : S extends `${infer S}${infer Rest}`
      ? S extends "-"
        ? Replace<Rest, `${Accum}_`>
        : Replace<Rest, `${Accum}${S}`>
      : Accum;

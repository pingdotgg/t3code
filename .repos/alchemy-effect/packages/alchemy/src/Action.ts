import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Pipeable } from "effect/Pipeable";
import { makeCaptureContext } from "./ActionRuntimeContext.ts";
import { toFqn } from "./FQN.ts";
import type { Input } from "./Input.ts";
import { CurrentNamespace, type NamespaceNode } from "./Namespace.ts";
import * as Output from "./Output.ts";
import { RuntimeContext } from "./RuntimeContext.ts";
import { Stack } from "./Stack.ts";

/**
 * An Action is a node in the dependency graph that runs an Effect with its
 * resolved input during {@link plan}/{@link apply}. It is similar to a
 * Resource but without a Provider lifecycle:
 *
 *   - It has a LogicalId and typed Input.
 *   - The body Effect is called when input changes (diff) or `--force` is set.
 *   - There is no replace/precreate/read/delete: removing an Action from the
 *     stack simply drops its persisted state without invoking the body.
 *   - Dependencies pulled in by the init Effect surface as `Req` on the
 *     call site, exactly like a Resource's provider services.
 *
 * Actions are recorded on {@link Stack.actions} and produce a single output
 * value; `yield*` on the constructor returns `Output<Out>` for use as
 * input to downstream Resources / Actions.
 */
export interface ActionLike<
  Type extends string = string,
  In extends object | undefined = any,
  Out = any,
> {
  readonly Kind: "action";
  readonly Namespace: NamespaceNode | undefined;
  readonly FQN: string;
  readonly Type: Type;
  readonly LogicalId: string;
  readonly Input: In;
  /**
   * Resource Outputs referenced via `yield* output` inside the init Effect,
   * keyed by the Output's sanitized key. They become dependency edges (the
   * Action waits for these upstreams) and are resolved against the tracker at
   * apply time, then exposed to the body through the resolve
   * {@link RuntimeContext}. Empty when the Action captures nothing.
   */
  readonly Captures: Record<string, Output.Output>;
  /** Resolved runner — populated by the init effect (if any). */
  readonly Run: (input: In) => Effect.Effect<Out, any, any>;
  /** @internal phantom */
  Output: Out;
}

export const isAction = (value: any): value is ActionLike =>
  typeof value === "object" && value !== null && value?.Kind === "action";

/** Body function — runs each time the resolved input changes. */
export type ActionRunner<In extends object | undefined, Out, Req = any> = (
  input: In,
) => Effect.Effect<Out, any, Req>;

/**
 * Init Effect — declares dependencies via `yield*` and returns the runner.
 * Lets multiple Action definitions share resolved services.
 */
export type ActionInit<In extends object | undefined, Out, Req> = Effect.Effect<
  ActionRunner<In, Out, any>,
  any,
  Req
>;

// ── Public API ─────────────────────────────────────────────────────────────
//
// Direct runner:
//
//   const Sync = Action("Sync", Effect.fn(function* (input: { table: string }) {
//     return { rows: 42 };
//   }));
//
// Init constructor — pulls in dependencies, returns the runner. The init
// Effect's `Req` channel bubbles up to the call site:
//
//   const Sync = Action("Sync", Effect.gen(function* () {
//     const db = yield* Database;
//     return Effect.fn(function* (input: { table: string }) {
//       return { rows: yield* db.count(input.table) };
//     });
//   }));
//
// Either way, call it inside a stack to register an instance — `yield*`
// returns `Output<Out>` ready to feed into downstream nodes:
//
//   const rows = yield* Sync({ table: bucket.name });
//   // rows: Output<{ rows: number }, never>
//
// Tagged form for split contract/implementation — declare the type with an
// interface, build the value with the no-arg overload, then supply the runner
// via `.make` (add the returned Layer to the stack's `providers`, or provide it
// locally with `Effect.provide`). The init passed to `.make` runs under the
// same capture context as the inline form, so `yield* output` accessors work:
//
//   interface Sync extends Action<"Sync", { table: string }, { rows: number }> {}
//   const Sync = Action<Sync, { table: string }, { rows: number }>()("Sync");
//   const SyncLive = Sync.make(Effect.gen(function* () { /* ... */ }));

export function Action<
  Type extends string,
  In extends object | undefined,
  Out,
  Req = never,
>(
  type: Type,
  initOrRun: ActionRunner<In, Out, Req> | ActionInit<In, Out, Req>,
): ActionClass<never, Type, In, Out, Req>;

export function Action<Self, In extends object | undefined, Out>(): <
  Type extends string,
>(
  type: Type,
) => ActionClass<Self, Type, In, Out, Self>;

export function Action(...args: any[]): any {
  if (args.length === 0) {
    // Tagged form: Action<Self, In, Out>()(type)
    return (type: string) => makeActionClass(type, undefined);
  }
  // Inline form: Action(type, runnerOrInit)
  const [type, initOrRun] = args as [
    string,
    ActionRunner<any, any, any> | ActionInit<any, any, any>,
  ];
  return makeActionClass(type, initOrRun);
}

export interface ActionClass<
  Self,
  Type extends string,
  In extends object | undefined,
  Out,
  Req,
> {
  readonly Type: Type;
  /**
   * Default form — uses `Type` as the LogicalId. One instance per Action
   * definition (the common case for deploy-time work). Returns the Action's
   * output as `Output<Out>`.
   */
  (input: { [k in keyof In]: Input<In[k]> }): Effect.Effect<
    Output.ToOutput<Out, never>,
    never,
    Req | Stack
  >;
  /**
   * Explicit-id form — register multiple instances of the same Action
   * definition under distinct logical ids.
   */
  (
    id: string,
    input: { [k in keyof In]: Input<In[k]> },
  ): Effect.Effect<Output.ToOutput<Out, never>, never, Req | Stack>;
  /**
   * Tagged-only: bind an init Effect to this Action's Self tag. Add the
   * returned Layer to the stack's `providers`.
   */
  make: [Self] extends [never]
    ? never
    : <R = never>(
        init: ActionRunner<In, Out, R> | ActionInit<In, Out, R>,
      ) => Layer.Layer<Self, never, R>;
  /** Tagged-only: the Context tag holding the resolved runner. */
  readonly Self: [Self] extends [never]
    ? never
    : Context.Service<Self, ActionRunner<In, Out, any>>;
}

const isRunnerEffect = (
  v: ActionRunner<any, any, any> | ActionInit<any, any, any>,
): v is ActionInit<any, any, any> => Effect.isEffect(v as any);

const makeActionClass = (
  type: string,
  baked: ActionRunner<any, any, any> | ActionInit<any, any, any> | undefined,
): any => {
  // Pre-resolve baked init/runner into a single Effect<Runner, _, Req>. Use
  // Effect.cached so the init's body runs at most once per process — every
  // action instance after the first reuses the resolved runner without paying
  // the init cost (or re-yielding its dependencies).
  let resolveRunner:
    | Effect.Effect<ActionRunner<any, any, any>, any, any>
    | undefined;
  if (baked !== undefined) {
    resolveRunner = isRunnerEffect(baked)
      ? Effect.runSync(Effect.cached(baked))
      : Effect.succeed(baked);
  }

  // Tagged form needs a Context tag so the user can supply the runner
  // through a Layer. Inline form bakes the runner in and skips the tag.
  const SelfTag = baked
    ? undefined
    : Context.Service<any, ActionRunner<any, any, any>>(
        `alchemy/Action<${type}>`,
      );

  // Outputs referenced via `yield* output` inside the init Effect land here,
  // recorded by the capture RuntimeContext. Shared per definition — the init
  // runs at most once (Effect.cached), so captures are inherently
  // per-definition, matching how the init's `Req` bubbles per definition.
  const captures: Record<string, Output.Output> = {};
  const captureContext = makeCaptureContext(captures);

  const constructor = (...args: [any] | [string, any]) => {
    const [id, input] =
      args.length === 1 ? [type, args[0]] : (args as [string, any]);
    return Effect.gen(function* () {
      const run = resolveRunner
        ? yield* resolveRunner.pipe(
            Effect.provideService(RuntimeContext, captureContext),
          )
        : ((yield* SelfTag!) as ActionRunner<any, any, any>);
      return yield* registerAction(type, id, input, run, captures);
    });
  };

  const extra: Record<string, any> = { Type: type };
  if (SelfTag) {
    extra.Self = SelfTag;
    // `.make(initOrRun)` — accepts either a direct runner or an init Effect.
    // For init form we use `Layer.effect` so the init's Req surfaces on the
    // Layer, and run it under the capture RuntimeContext so `yield* output`
    // accessors are recorded just like the inline form; for runners we use
    // `Layer.succeed` (nothing to capture).
    extra.make = <R>(
      initOrRun: ActionRunner<any, any, R> | ActionInit<any, any, R>,
    ) =>
      isRunnerEffect(initOrRun)
        ? Layer.effect(
            SelfTag,
            (initOrRun as ActionInit<any, any, R>).pipe(
              Effect.provideService(RuntimeContext, captureContext),
            ),
          )
        : Layer.succeed(SelfTag, initOrRun as ActionRunner<any, any, any>);
  }
  return Object.assign(constructor, extra);
};

const registerAction = <
  Type extends string,
  In extends object | undefined,
  Out,
>(
  type: Type,
  id: string,
  input: any,
  run: ActionRunner<In, Out, any>,
  captures: Record<string, Output.Output>,
): Effect.Effect<Output.ToOutput<Out, never>, never, Stack> =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const namespace = yield* CurrentNamespace;
    const fqn = toFqn(namespace, id);

    const actions = (stack.actions ??= {});
    const existing = actions[fqn];
    if (existing)
      return Output.of(existing as any) as unknown as Output.ToOutput<
        Out,
        never
      >;

    // FQN collision check: actions share the same FQN namespace as resources
    // so the dependency graph stays unified. Rejecting overlaps here makes
    // the constraint obvious at registration time.
    if (stack.resources[fqn]) {
      return yield* Effect.die(
        new Error(
          `Action '${fqn}' collides with a Resource of the same logical id`,
        ),
      );
    }

    const target: ActionLike<Type, In, Out> = {
      Kind: "action" as const,
      Type: type,
      Namespace: namespace,
      FQN: fqn,
      LogicalId: id,
      Input: input,
      Captures: captures,
      Run: run,
      Output: undefined as any,
    };
    (target as any).toString = () => `Action<${type}>(${id})`;

    actions[fqn] = target as any;
    // `yield* Sync({...})` returns `Output<Out>`. The engine writes the
    // materialized value into `tracker[fqn]` during apply; `Output.of(action)`
    // resolves a ResourceExpr by looking up `outputs[fqn]` — which is
    // precisely that materialized value. Property access into the returned
    // Output chains through the standard PropExpr proxy.
    return Output.of(target as any) as unknown as Output.ToOutput<Out, never>;
  });

/**
 * Pipeable Action instance used internally by Plan/Apply. Users get an
 * `Output<Out>` from `yield*` and don't normally see this.
 */
export type Action<
  Type extends string = string,
  In extends object | undefined = any,
  Out = any,
> = Pipeable & ActionLike<Type, In, Out>;

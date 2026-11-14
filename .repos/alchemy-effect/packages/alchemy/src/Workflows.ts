import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Schema from "effect/Schema";
import { type DurableDeferred, type Workflow, WorkflowEngine } from "effect/workflow";
import type { RuntimeContext } from "./RuntimeContext.ts";

declare const ImplementedTypeId: unique symbol;

/**
 * Annotates a workflow with the name an engine stores its runs under, when
 * that differs from the workflow's own name. An engine that names storage
 * after the workflow, like Cloudflare's Durable Object engine with one class
 * per workflow, uses it as given.
 */
export class StorageName extends Context.Service<StorageName, string>()(
  "alchemy/Workflows/StorageName",
) {}

/**
 * Marks a workflow as runnable here: something in the context implements it.
 * `Workflows.layer` provides it for the workflow it implements, and a remote
 * engine, like `AWS.Lambda.DurableFunctionEngine`, for the workflows its
 * hosts run. `Workflows.RunWorkflow` requires it, so running a workflow
 * nothing implements is a type error.
 */
export interface Implemented<Name extends string> {
  readonly [ImplementedTypeId]: Name;
}

/** @internal */
export const Implemented = <Name extends string>(name: Name) =>
  Context.Service<Implemented<Name>, true>(`alchemy/Workflows/Implemented/${name}`);

/** @internal */
export const implemented = <Name extends string>(
  names: ReadonlyArray<Name>,
): Layer.Layer<Implemented<Name>> =>
  Layer.succeedContext(
    names.reduce(
      (context, name) => Context.add(context, Implemented(name), true),
      Context.empty() as Context.Context<Implemented<Name>>,
    ),
  );

type Requirements<L> = L extends Layer.Layer<any, any, infer R> ? R : never;

/** A workflow's handler: runs it for a payload, inside a run. */
export type Execute<
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
> = (
  payload: Payload["Type"],
  executionId: string,
) => Effect.Effect<Success["Type"], Error["Type"], R>;

/**
 * Implement a workflow. Like `workflow.toLayer(execute)`, it registers the
 * handler with the engine, and it marks the workflow as implemented, so
 * `RunWorkflow` can run it.
 *
 * Pass the handler, or an Effect that builds it. The Effect runs once, when
 * the Layer is built, so resolve bindings and services there and use them in
 * the handler it returns.
 *
 * Handlers can call runtime-only APIs, like a bucket's `put` or another
 * Durable Object's methods. A runtime-only API requires `RuntimeContext`,
 * which a Worker's or Lambda function's init doesn't have. A handler only
 * runs inside a run, and every run has one, so this Layer doesn't ask for it.
 *
 * ### Implementing a workflow
 * **Example:** A handler
 * ```typescript
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import { Activity } from "effect/workflow";
 *
 * export const GreetLive = Workflows.layer(
 *   Greet,
 *   Effect.fn(function* ({ name }) {
 *     return yield* Activity.make({
 *       name: "greet",
 *       success: Schema.String,
 *       execute: Effect.succeed(`hello ${name}`),
 *     });
 *   }),
 * );
 * ```
 *
 * **Example:** A handler that uses a binding
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import { Activity } from "effect/workflow";
 * import { Receipts } from "./Receipts.ts";
 *
 * export const CheckoutLive = Workflows.layer(
 *   Checkout,
 *   Effect.gen(function* () {
 *     const receipts = yield* Cloudflare.R2.WriteBucket(Receipts);
 *     return Effect.fn(function* ({ orderId }) {
 *       yield* Activity.make({
 *         name: "receipt",
 *         execute: receipts.put(`${orderId}.json`, JSON.stringify({ orderId })).pipe(Effect.orDie),
 *       });
 *     });
 *   }),
 * );
 * ```
 *
 * @primitive
 */
export function layer<
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
>(
  workflow: Workflow.Workflow<Name, Payload, Success, Error>,
  execute: Execute<Payload, Success, Error, R>,
): Layer.Layer<
  Implemented<Name>,
  never,
  Exclude<Requirements<ReturnType<typeof workflow.toLayer<R>>>, RuntimeContext>
>;
export function layer<
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
  InitE,
  InitR,
>(
  workflow: Workflow.Workflow<Name, Payload, Success, Error>,
  make: Effect.Effect<Execute<Payload, Success, Error, R>, InitE, InitR>,
): Layer.Layer<
  Implemented<Name>,
  InitE,
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- generic in R; only looks like `never` to the linter
  InitR | Exclude<Requirements<ReturnType<typeof workflow.toLayer<R>>>, RuntimeContext>
>;
export function layer(
  workflow: Workflow.Workflow<string, Workflow.AnyStructSchema, Schema.Top, Schema.Top>,
  execute:
    | Execute<Workflow.AnyStructSchema, Schema.Top, Schema.Top, unknown>
    | Effect.Effect<
        Execute<Workflow.AnyStructSchema, Schema.Top, Schema.Top, unknown>,
        unknown,
        unknown
      >,
): Layer.Layer<any, any, any> {
  return Effect.isEffect(execute)
    ? Layer.unwrap(Effect.map(execute, (handler) => layer(workflow, handler)))
    : Layer.merge(
        workflow.toLayer(execute as any) as Layer.Layer<never, never, any>,
        implemented([workflow._tag]),
      );
}

type NameOf<W> = W extends Workflow.Workflow<infer Name, any, any, any> ? Name : never;
type SuccessOf<W> = W extends Workflow.Workflow<any, any, infer S, any> ? S["Type"] : never;
type ErrorOf<W> = W extends Workflow.Workflow<any, any, any, infer E> ? E["Type"] : never;
type PayloadOf<W> =
  W extends Workflow.Workflow<any, infer P, any, any> ? P["~type.make.in"] : never;

/** Where a run is. */
export type Status<A, E> =
  | { readonly _tag: "NotStarted" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Completed"; readonly result: A }
  | { readonly _tag: "Failed"; readonly error: E }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Died"; readonly defect: unknown };

/** One run of a workflow. */
export interface Run<A, E> {
  /** The run's id. Store it to read the run again later, with `get`. */
  readonly executionId: string;
  /** Where the run is now. */
  readonly status: Effect.Effect<Status<A, E>>;
  /**
   * Wait for the run to finish: its result, or its failure. A run can take
   * days, so wait in tests and scripts, not in a request.
   */
  readonly result: Effect.Effect<A, E>;
  /** Complete a `DurableDeferred` the run waits on. */
  readonly signal: <Success extends Schema.Constraint>(
    deferred: DurableDeferred.DurableDeferred<Success, any>,
    value: Success["Type"],
  ) => Effect.Effect<void>;
  /** Stop the run: it fails where it waits, and its compensations run. */
  readonly interrupt: Effect.Effect<void>;
}

/** Starts and reads runs of one workflow. */
export interface WorkflowClient<W> {
  /** Start a run, or return the run already started with the same key. Returns at once. */
  readonly start: (payload: PayloadOf<W>) => Effect.Effect<Run<SuccessOf<W>, ErrorOf<W>>>;
  /** A run started earlier, by its id. */
  readonly get: (executionId: string) => Run<SuccessOf<W>, ErrorOf<W>>;
}

/** How often to check a run while waiting for it. */
const POLL = Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("5 seconds")]);

/**
 * Start and read runs of a workflow, on whichever engine the runtime
 * provides. Resolve it once, during init; its methods need nothing else.
 *
 * It needs the workflow implemented: by `Workflows.layer` in the same
 * runtime, or by a host a remote engine routes to. Running a workflow nothing
 * implements is a type error.
 *
 * ### Running a workflow
 * **Example:** Start a run from a request
 * ```typescript
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * const app = Effect.gen(function* () {
 *   const greet = yield* Workflows.RunWorkflow(Greet);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const run = yield* greet.start({ name: "sam" });
 *       return HttpServerResponse.text(run.executionId);
 *     }),
 *   };
 * });
 * ```
 *
 * **Example:** Read a run later
 * ```typescript
 * const run = greet.get(executionId);
 * const status = yield* run.status;
 * yield* run.signal(Approval, "agent-7");
 * ```
 *
 * @primitive
 */
export const RunWorkflow = <W extends Workflow.Any>(
  workflow: W,
): Effect.Effect<
  WorkflowClient<W>,
  never,
  WorkflowEngine.WorkflowEngine | Implemented<NameOf<W>>
> =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const typed = workflow as unknown as Workflow.Workflow<string, any, any, any>;
    const run = (executionId: string) =>
      makeRun(engine, typed, executionId) as Run<SuccessOf<W>, ErrorOf<W>>;
    return {
      start: (payload) =>
        typed
          .execute(payload, { discard: true })
          .pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            Effect.map(run),
          ) as Effect.Effect<Run<SuccessOf<W>, ErrorOf<W>>>,
      get: run,
    } satisfies WorkflowClient<W>;
  });

/**
 * A handle to one run of a workflow on an engine.
 *
 * @internal
 */
export const makeRun = (
  engine: WorkflowEngine.WorkflowEngine["Service"],
  workflow: Workflow.Workflow<string, any, any, any>,
  executionId: string,
): Run<unknown, unknown> => {
  const poll = engine.poll(workflow, executionId);
  return {
    executionId,
    status: Effect.map(poll, (result): Status<unknown, unknown> => {
      if (Option.isNone(result)) return { _tag: "NotStarted" };
      if (result.value._tag === "Suspended") return { _tag: "Running" };
      const exit = result.value.exit;
      if (Exit.isSuccess(exit)) return { _tag: "Completed", result: exit.value };
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      if (failure?._tag === "Fail") return { _tag: "Failed", error: failure.error };
      const defect = exit.cause.reasons.find((reason) => reason._tag === "Die");
      return defect?._tag === "Die"
        ? { _tag: "Died", defect: defect.defect }
        : { _tag: "Interrupted" };
    }) as Effect.Effect<Status<unknown, unknown>>,
    result: poll.pipe(
      Effect.flatMap((result) =>
        Option.isSome(result) && result.value._tag === "Complete"
          ? Effect.succeed(result.value.exit)
          : Effect.fail("running" as const),
      ),
      Effect.retry({ schedule: POLL }),
      Effect.orDie,
      Effect.flatten,
    ) as Effect.Effect<unknown, unknown>,
    signal: (deferred, value) =>
      engine.deferredDone(deferred, {
        workflowName: workflow._tag,
        executionId,
        deferredName: deferred.name,
        exit: Exit.succeed(value),
      }) as Effect.Effect<void>,
    interrupt: engine.interrupt(workflow, executionId),
  };
};

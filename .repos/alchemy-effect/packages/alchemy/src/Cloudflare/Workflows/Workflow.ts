import type * as runtime from "@cloudflare/workers-types";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Scope } from "effect/Scope";
import * as Stream from "effect/Stream";
import { OwnedBySomeoneElse, Unowned } from "../../AdoptPolicy.ts";
import { havePropsChanged, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import type * as Output from "../../Output.ts";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import type { PlatformServices } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localAccountId } from "../LocalAccount.ts";
import { generateLocalId } from "../LocalRuntime.ts";
import {
  Worker,
  WorkerEnvironment,
  type WorkerServices,
} from "../Workers/Worker.ts";
import { generateWorkflowName } from "./WorkflowName.ts";
import {
  type WorkflowEvent,
  WorkflowStep,
  WorkflowStepContext,
} from "./WorkflowRuntime.ts";

export {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepContext,
} from "./WorkflowRuntime.ts";

type TypeId = "Cloudflare.Workflow";
const TypeId = "Cloudflare.Workflow" as const;

/**
 * Cron trigger metadata on a Workflow instance created by a native
 * `schedules` expression. Mirrors Cloudflare's `event.schedule`.
 */
export interface WorkflowCronSchedule {
  /**
   * The matching cron expression that created this instance.
   */
  cron: string;
  /**
   * The scheduled fire time, milliseconds since the Unix epoch.
   */
  scheduledTime: number;
}

export type WorkflowBackoff = "constant" | "linear" | "exponential";

export interface WorkflowStepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: WorkflowBackoff;
  };
  timeout?: string | number;
}

export interface WorkflowStepContextData {
  step: {
    name: string;
    count: number;
  };
  attempt: number;
  config: WorkflowStepConfig;
}

export interface WorkflowRollbackContext<Output = unknown> {
  error: Error;
  output: Output | undefined;
}

export interface WorkflowRollbackOptions<Output = unknown, R = never> {
  rollback: (
    context: WorkflowRollbackContext<Output>,
  ) => Effect.Effect<void, unknown, R>;
  rollbackConfig?: WorkflowStepConfig;
}

/**
 * Optional configuration for a `task` step: retry policy, timeout, and a
 * rollback handler with its own retry config.
 */
export interface WorkflowTaskConfig<
  Output = unknown,
  RollbackReq = never,
> extends WorkflowStepConfig {
  rollback?: (
    context: WorkflowRollbackContext<Output>,
  ) => Effect.Effect<void, unknown, RollbackReq>;
  rollbackConfig?: WorkflowStepConfig;
}

/**
 * Internal step descriptor passed from `task` to the bridge. Bundles the step
 * name and Effect together with the `WorkflowTaskConfig` fields.
 */
export interface WorkflowTaskOptions<
  Output = unknown,
  R = never,
  RollbackReq = never,
  E = never,
> extends WorkflowTaskConfig<Output, RollbackReq> {
  name: string;
  effect: Effect.Effect<Output, E, R>;
}

export interface WorkflowWaitForEventOptions {
  type: string;
  timeout?: string | number;
}

/**
 * The event delivered to a `waitForEvent` step. Mirrors the native
 * `WorkflowStepEvent` shape from `cloudflare:workers` 1:1.
 */
export interface WorkflowStepEvent<Payload = unknown> {
  payload: Payload;
  timestamp: Date;
  type: string;
}

type ExcludeWorkflowStepContext<R> = R extends {
  readonly key: "Cloudflare.WorkflowStepContext";
}
  ? never
  : R;

// ---------------------------------------------------------------------------
// User-facing step primitives
// ---------------------------------------------------------------------------

/**
 * Execute a named, durable workflow step. The effect is run inside the
 * Cloudflare step transaction so its result is automatically persisted
 * and replayed on retries.
 *
 * Any services the inner effect requires (e.g. `WorkerEnvironment` from a
 * binding like `kv.put` / `kv.get`) are threaded through automatically by
 * capturing the surrounding workflow body's context and providing it to
 * the inner effect before it runs inside `step.do`.
 *
 * The step name comes first, followed by the Effect. Retry config, timeout,
 * and a rollback handler can be passed in the optional third `options` arg.
 * Each attempt and rollback handler has a fresh Scope; its resources close
 * before that callback completes. Interrupting a task waits for the active
 * attempt's cleanup without waiting for Cloudflare's native retry delays.
 *
 * `Effect.fail` uses the native retry policy. On exhaustion, application failure
 * data is returned in the error channel, including on cached rejection replay.
 * The active invocation retains its original Cause; replay restores serialized
 * tags and fields, not custom prototypes, methods, or object identity.
 * Failure data supports primitives, dense arrays, records, errors, Date, bigint,
 * Uint8Array, ArrayBuffer, Map, and Set, within a 16 KiB encoded / 64-level limit.
 * Functions, symbols, cycles, shared object references, accessors, and unsupported
 * class instances fail explicitly as terminal serialization defects. Error data
 * must form a tree, including objects used as Map keys or Set members.
 * `Effect.die` and `Effect.orDie`
 * stop retries. Native timeout, validation, pause, and abort errors stay defects.
 */
export function task<T, R = never, RollbackReq = never, E = never>(
  name: string,
  effect: Effect.Effect<T, E, R>,
  options?: WorkflowTaskConfig<T, RollbackReq>,
): Effect.Effect<
  T,
  E,
  WorkflowStep | ExcludeWorkflowStepContext<Exclude<R | RollbackReq, Scope>>
> {
  return Effect.gen(function* () {
    const step = yield* WorkflowStep;
    const context = (yield* Effect.context<
      ExcludeWorkflowStepContext<Exclude<R | RollbackReq, Scope>>
    >()).pipe(Context.omit(Scope, WorkflowStepContext));
    const rollbackEffect = options?.rollback;
    return yield* step.do({
      ...options,
      name,
      effect: effect.pipe(Effect.provide(context)),
      rollback: rollbackEffect
        ? (rollbackContext: WorkflowRollbackContext<T>) =>
            rollbackEffect(rollbackContext).pipe(Effect.provide(context))
        : undefined,
    } as WorkflowTaskOptions<T, any, any, E>);
  });
}

/**
 * Pause the workflow for the given duration.
 */
export const sleep = (
  name: string,
  duration: string | number,
): Effect.Effect<void, never, WorkflowStep> =>
  Effect.gen(function* () {
    const step = yield* WorkflowStep;
    yield* step.sleep(name, duration);
  }).pipe(Effect.orDie);

/**
 * Pause the workflow until the given timestamp.
 */
export const sleepUntil = (
  name: string,
  timestamp: Date | number,
): Effect.Effect<void, never, WorkflowStep> =>
  Effect.gen(function* () {
    const step = yield* WorkflowStep;
    yield* step.sleepUntil(name, timestamp);
  }).pipe(Effect.orDie);

/**
 * Pause the workflow until an external event is delivered with
 * `WorkflowInstance.sendEvent`. Resolves with the full
 * {@link WorkflowStepEvent} (`{ payload, timestamp, type }`), exactly like
 * the native `step.waitForEvent`.
 */
export const waitForEvent = <T = unknown>(
  name: string,
  options: WorkflowWaitForEventOptions,
): Effect.Effect<WorkflowStepEvent<T>, never, WorkflowStep> =>
  Effect.gen(function* () {
    const step = yield* WorkflowStep;
    return yield* step.waitForEvent<T>(name, options);
  }).pipe(Effect.orDie);

/**
 * The services available inside a workflow run body.
 *
 * `WorkerEnvironment` is provided to the body at runtime by the workflow
 * export wrapper (see `make(env)` below), so users can access env bindings
 * from inside workflow steps via `yield* WorkerEnvironment` — the type must
 * reflect that or `yield* WorkerEnvironment` fails to type-check inside a
 * body even though it succeeds at runtime.
 *
 * A fresh `Scope` is provided per run-invocation by `WorkflowBridge.run` and
 * threaded into every `task` via the surrounding body context, so `@binding`
 * helpers that acquire per-run resources against the ambient scope (e.g.
 * `Drizzle.Postgres`) resolve them inside workflow steps just as they do in
 * a Worker `fetch`/`queue` handler.
 */
export type WorkflowRunServices =
  | WorkflowEvent
  | WorkflowStep
  | WorkerServices
  | Scope;

export type WorkflowServices =
  | WorkflowRunServices
  | PlatformServices
  | RuntimeContext;

/**
 * Metadata stored in the worker export map to distinguish workflow exports
 * from durable object exports at bundle-generation time.
 */
export interface WorkflowExport {
  readonly kind: "workflow";
  readonly make: (
    env: unknown,
  ) => Effect.Effect<WorkflowImpl<any, any, unknown>>;
}

/**
 * A workflow implementation is a function from a typed `Input` payload to
 * an Effect that produces the workflow's `Result`. The Effect requires
 * `WorkflowRunServices` (event + step + env) to execute.
 */
export type WorkflowImpl<Input = unknown, Result = unknown, E = never> = (
  input: Input,
) => Effect.Effect<Result, E, WorkflowServices>;

export const isWorkflowExport = (value: unknown): value is WorkflowExport =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as any).kind === "workflow";

/**
 * Limits applied to the workflow on create or update.
 */
export interface WorkflowLimits {
  /**
   * Maximum number of steps a single workflow instance may execute.
   */
  steps?: number;
}

/**
 * Props for the reference (async) form of {@link Workflow}. Used when binding
 * a Workflow class to a plain async Worker (one without an Effect runtime) via
 * the Worker's `env`. Mirrors `DurableObjectProps`.
 */
export interface WorkflowRefProps {
  /**
   * Account-global Workflow name. Adopting an existing Workflow requires
   * `--adopt`; unused names do not. If omitted, Alchemy preserves the deployed
   * name or derives a stage-scoped default from the hosting Worker and class.
   * Changing this name replaces the Workflow. Fixed names must be unique to
   * each independently managed stack and stage.
   */
  workflowName?: string;
  /**
   * Name of the exported `WorkflowEntrypoint` class.
   *
   * @default name
   */
  className?: string;
  /**
   * Worker script that hosts the Workflow class. Omit this when the workflow
   * is hosted by the Worker that declares the binding.
   */
  scriptName?: Input<string>;
  /**
   * Limits applied to the workflow. Only applies when the workflow is hosted by
   * the Worker that declares the binding; ignored when `scriptName` is set.
   */
  limits?: WorkflowLimits;
  /**
   * Cron expressions that create a new Workflow instance on each match.
   * Wrangler-compatible: `schedules: ["0 * * * *"]`.
   *
   * Native Workflow schedules replace a Worker Cron Trigger whose
   * `scheduled` handler called `workflow.create()`. Pass an empty
   * array to remove all schedules.
   *
   * Only applies when the workflow is hosted by the Worker that declares
   * the binding; ignored when `scriptName` is set.
   *
   * Account-wide limit: 100 cron expressions.
   */
  schedules?: string[];
}

/**
 * Props for the Effect-native form of {@link Workflow}
 * (`Workflow(name, props, impl)`). Used when the workflow's implementation is
 * defined inline by the hosting Worker.
 */
export interface WorkflowProps {
  /**
   * Account-global Workflow name. Adopting an existing Workflow requires
   * `--adopt`; unused names do not. If omitted, Alchemy preserves the deployed
   * name or derives a stage-scoped default from the hosting Worker and class.
   * Changing this name replaces the Workflow. Fixed names must be unique to
   * each independently managed stack and stage.
   */
  workflowName?: string;
  /**
   * Limits applied to the workflow.
   */
  limits?: WorkflowLimits;
  /**
   * Cron expressions that create a new Workflow instance on each match.
   * Wrangler-compatible: `schedules: ["0 * * * *"]`.
   *
   * Native Workflow schedules replace a Worker Cron Trigger whose
   * `scheduled` handler called `workflow.create()`. Pass an empty
   * array to remove all schedules.
   *
   * Account-wide limit: 100 cron expressions.
   */
  schedules?: string[];
}

/**
 * A lightweight reference to a Workflow, produced by the props-only form of
 * {@link Workflow} (`Workflow(name, { className })`). Carries just enough
 * metadata to emit the `workflow` binding for an async Worker and to drive
 * the `putWorkflow` lifecycle. Mirrors `DurableObjectLike`.
 */
export interface WorkflowLike<Params = unknown> {
  kind: TypeId;
  name: string;
  /** Account-global Workflow name, when explicitly configured. */
  workflowName?: string;
  /** @internal phantom */
  className?: string;
  /** @internal phantom */
  scriptName?: Input<string>;
  /** @internal phantom */
  limits?: WorkflowLimits;
  /** @internal phantom */
  schedules?: string[];
  /** @internal phantom */
  Params?: Params;
}

/**
 * A Workflow bound on an external/async Worker's `env`, exposed on
 * `worker.env.<name>` at declaration time, not on persisted Worker references
 * or Effect-native Workers. Carries the binding's identity as `Output`s
 * of the current deploy pass, so a sibling resource in the same stack — a
 * Queue subscription to the Workflow's lifecycle events, for instance — can
 * consume the Workflow's physical name on its very first deployment without
 * reading persisted state or re-deriving the name.
 *
 * For a locally-hosted Workflow, `workflowName` and `scriptName` resolve from
 * the {@link WorkflowResource} the binding registers, so a consumer deploys
 * after `putWorkflow` has run. A cross-script reference (`scriptName` set)
 * registers no resource; both outputs derive from the declared host script.
 */
export interface WorkflowBinding<Params = unknown> {
  kind: TypeId;
  /** Logical name of the Workflow, as passed to `Workflow(name, …)`. */
  name: string;
  /** Name of the exported `WorkflowEntrypoint` class. */
  className: string;
  /** Account-global physical Workflow name, resolved in the current deploy. */
  workflowName: Output.Output<string>;
  /** Script name of the Worker hosting the Workflow class. */
  scriptName: Output.Output<string>;
  /** @internal phantom */
  Params?: Params;
}

/**
 * Type guard for the reference (async) form of a Workflow.
 */
export const isWorkflowLike = (value: unknown): value is WorkflowLike =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === TypeId;

/**
 * Type guard for workflow binding metadata in the Worker binding contract.
 */
export const isWorkflowBinding = (binding: {
  type: string;
}): binding is {
  type: "workflow";
  name: string;
  workflowName: string;
  className: string;
  scriptName?: string;
} => binding.type === "workflow";

export type WorkflowBatchDeleteResult = runtime.WorkflowBatchDeleteResult;
export type WorkflowSubscriptionEvent = runtime.WorkflowInstanceEvent;
export type WorkflowInstanceSubscribeOptions =
  runtime.WorkflowInstanceSubscribeOptions;

/**
 * Handle returned to the caller at deploy/bind time. Allows starting
 * workflow instances and checking their status from the Api layer.
 */
export interface WorkflowHandle<Input = unknown, Result = unknown> {
  Type: TypeId;
  name: string;
  /**
   * Start a workflow instance. Pass payload through `params`; omit `id` to let
   * Cloudflare generate an instance ID.
   */
  create(
    options?: WorkflowInstanceCreateOptions<Input>,
  ): Effect.Effect<WorkflowInstance<Result>>;
  createBatch(
    batch: WorkflowInstanceCreateOptions<Input>[],
  ): Effect.Effect<WorkflowInstance<Result>[]>;
  get(instanceId: string): Effect.Effect<WorkflowInstance<Result>>;
  /** Delete up to 100 instances and their stored state, returning per-instance results. */
  deleteBatch(instanceIds: string[]): Effect.Effect<WorkflowBatchDeleteResult>;
}

/** Options for starting a workflow instance. */
export interface WorkflowInstanceCreateOptions<Input = unknown> {
  id?: string;
  params?: Input;
  retention?: WorkflowInstanceRetention;
}

export interface WorkflowInstanceRetention {
  successRetention?: string | number;
  errorRetention?: string | number;
}

/** Handle for a single Cloudflare workflow instance. */
export interface WorkflowInstance<Result = unknown> {
  id: string;
  status(): Effect.Effect<WorkflowInstanceStatus<Result>>;
  pause(): Effect.Effect<void>;
  resume(): Effect.Effect<void>;
  restart(options?: WorkflowInstanceRestartOptions): Effect.Effect<void>;
  terminate(): Effect.Effect<void>;
  /** Stop execution and delete this instance and its stored state. */
  delete(): Effect.Effect<void>;
  /** Stream historical and new events; release the subscription when consumption ends. */
  subscribe(
    options?: WorkflowInstanceSubscribeOptions,
  ): Stream.Stream<WorkflowSubscriptionEvent>;
  sendEvent<Event = unknown>(
    event: WorkflowInstanceEvent<Event>,
  ): Effect.Effect<void>;
}

export interface WorkflowInstanceRestartOptions {
  from?: {
    name: string;
    count?: number;
    type?: "do" | "sleep" | "waitForEvent";
  };
}

export interface WorkflowInstanceEvent<Payload = unknown> {
  type: string;
  payload?: Payload;
}

export interface WorkflowInstanceStatus<Result = unknown> {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown"
    | (string & {});
  output?: Result;
  error?: { name: string; message: string } | null;
  rollback?: {
    outcome: "complete" | "failed";
    error: { name: string; message: string } | null;
  } | null;
}

export interface WorkflowClass extends Effect.Effect<
  WorkflowHandle,
  never,
  WorkflowHandle
> {
  /** Reference a deployed Workflow by logical ID, optionally in another stack or stage. */
  ref: typeof WorkflowResource.ref;
  <_Self>(): {
    <Input = unknown, Result = unknown, InitReq = never, E = never>(
      name: string,
      impl: Effect.Effect<WorkflowImpl<Input, Result, E>, ConfigError, InitReq>,
    ): Effect.Effect<
      WorkflowHandle<Input, Result>,
      never,
      Worker | Exclude<InitReq, WorkflowServices>
    > & {
      new (_: never): WorkflowImpl<Input, Result, E>;
    };
    <Input = unknown, Result = unknown, InitReq = never, E = never>(
      name: string,
      props: WorkflowProps,
      impl: Effect.Effect<WorkflowImpl<Input, Result, E>, ConfigError, InitReq>,
    ): Effect.Effect<
      WorkflowHandle<Input, Result>,
      never,
      Worker | Exclude<InitReq, WorkflowServices>
    > & {
      new (_: never): WorkflowImpl<Input, Result, E>;
    };
  };
  <Params = unknown>(
    name: string,
    props?: WorkflowRefProps,
  ): WorkflowLike<Params>;
  <Input = unknown, Result = unknown, InitReq = never, E = never>(
    name: string,
    impl: Effect.Effect<WorkflowImpl<Input, Result, E>, ConfigError, InitReq>,
  ): Effect.Effect<
    WorkflowHandle<Input, Result>,
    never,
    Worker | Exclude<InitReq, WorkflowServices>
  >;
  <Input = unknown, Result = unknown, InitReq = never, E = never>(
    name: string,
    props: WorkflowProps,
    impl: Effect.Effect<WorkflowImpl<Input, Result, E>, ConfigError, InitReq>,
  ): Effect.Effect<
    WorkflowHandle<Input, Result>,
    never,
    Worker | Exclude<InitReq, WorkflowServices>
  >;
}

export class WorkflowScope extends Context.Service<
  WorkflowScope,
  WorkflowHandle
>()("Cloudflare.Workflow") {}

/**
 * A Cloudflare Workflow that orchestrates durable, multi-step tasks with
 * automatic retries and at-least-once delivery.
 *
 * A Workflow follows the same two-phase pattern as Workers and Durable
 * Objects. The outer `Effect.gen` resolves shared dependencies. The inner
 * `Effect.fn` is the workflow body — a function from a typed `input`
 * payload to an Effect that runs steps using `task`, `sleep`, and
 * `sleepUntil`. `task` takes the step name and Effect, plus an optional
 * config object for retries, timeout, and a rollback handler.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   // Phase 1: resolve dependencies
 *   const notifier = yield* NotificationService;
 *
 *   return Effect.fn(function* (input: { orderId: string }) {
 *     // Phase 2: workflow body (durable steps)
 *     const result = yield* Cloudflare.Workflows.task("process", doWork(input.orderId));
 *     yield* Cloudflare.Workflows.sleep("cooldown", "10 seconds");
 *     return result;
 *   });
 * })
 * ```
 *
 *
 * ### Defining a Workflow
 * **Example:** Minimal workflow
 * ```typescript
 * export default class MyWorkflow extends Cloudflare.Workflow<MyWorkflow>()(
 *   "MyWorkflow",
 *   Effect.gen(function* () {
 *     return Effect.fn(function* (input: { name: string }) {
 *       return { received: input.name };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Preserving an existing Workflow name
 *
 * An existing Workflow has no ownership marker, so the first deployment must
 * opt in with `--adopt`. Keep fixed names unique per independently managed
 * stack and stage; unlike the default, they are not stage-scoped by Alchemy.
 *
 * ```typescript
 * export default class MyWorkflow extends Cloudflare.Workflow<MyWorkflow>()(
 *   "MyWorkflow",
 *   { workflowName: "my-existing-workflow" },
 *   Effect.gen(function* () {
 *     return Effect.fn(function* (input: { name: string }) {
 *       return { received: input.name };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Setting a step limit
 * ```typescript
 * export default class MyWorkflow extends Cloudflare.Workflow<MyWorkflow>()(
 *   "MyWorkflow",
 *   { limits: { steps: 25000 } },
 *   Effect.gen(function* () {
 *     return Effect.fn(function* (input: { name: string }) {
 *       return { received: input.name };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * ### Scheduling instances
 * Each matching cron expression creates a new instance automatically —
 * no Worker Cron Trigger or `scheduled` handler required.
 * **Example:** Native cron schedules
 * ```typescript
 * export default class HourlyWorkflow extends Cloudflare.Workflow<HourlyWorkflow>()(
 *   "HourlyWorkflow",
 *   { schedules: ["0 * * * *"] },
 *   Effect.gen(function* () {
 *     return Effect.fn(function* () {
 *       const event = yield* Cloudflare.Workflows.WorkflowEvent;
 *       if (event.schedule) {
 *         return { cron: event.schedule.cron };
 *       }
 *       return {};
 *     });
 *   }),
 * ) {}
 * ```
 *
 * ### Step Primitives
 * **Example:** Running a named task
 * ```typescript
 * const result = yield* Cloudflare.Workflows.task(
 *   "process-order",
 *   Effect.succeed({ orderId: "abc", total: 42 }),
 * );
 * ```
 *
 * **Example:** Configuring retries and reading step context
 * ```typescript
 * const result = yield* Cloudflare.Workflows.task(
 *   "call-api",
 *   Effect.gen(function* () {
 *     const context = yield* Cloudflare.Workflows.WorkflowStepContext;
 *     return { attempt: context.attempt };
 *   }),
 *   { retries: { limit: 3, delay: "5 seconds", backoff: "linear" } },
 * );
 * ```
 *
 * **Example:** Registering rollback
 * ```typescript
 * yield* Cloudflare.Workflows.task("reserve-inventory", reserveInventory, {
 *   rollback: ({ output }) =>
 *     output ? releaseInventory(output.reservationId) : Effect.void,
 *   rollbackConfig: { retries: { limit: 3, delay: "10 seconds" } },
 * });
 * ```
 *
 * **Example:** Sleeping between steps
 * ```typescript
 * yield* Cloudflare.Workflows.sleep("cooldown", "30 seconds");
 * ```
 *
 * **Example:** Waiting for an external event
 * ```typescript
 * const event = yield* Cloudflare.Workflows.waitForEvent<{ approved: boolean }>(
 *   "approval",
 *   { type: "approval", timeout: "1 day" },
 * );
 * // Same shape as the native step.waitForEvent result:
 * event.payload.approved;
 * ```
 *
 * **Example:** Accessing env bindings inside a task
 * Bind a resource (e.g. `Namespace`, `Bucket`) in the workflow's
 * outer init phase to get a typed Effect-native client, then use it
 * directly inside `task`. `task` threads the binding's service
 * requirement (`WorkerEnvironment`) through automatically so the inner
 * Effect needs no extra plumbing.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const kv = yield* Cloudflare.KV.ReadWriteNamespace(KV);
 *
 *   return Effect.fn(function* (input: { roomId: string; message: string }) {
 *     const { roomId, message } = input;
 *
 *     const stored = yield* Cloudflare.Workflows.task(
 *       "kv-roundtrip",
 *       Effect.gen(function* () {
 *         const key = `workflow:${roomId}`;
 *         yield* kv.put(key, message);
 *         return yield* kv.get(key);
 *       }).pipe(Effect.orDie),
 *     );
 *
 *     return stored;
 *   });
 * });
 * ```
 *
 * ### Starting and Monitoring Instances
 * `create` mirrors Cloudflare's native Workflow API: pass workflow input in
 * `params`, pass `id` only when you need a deterministic instance ID, and omit
 * `id` to let Cloudflare generate one.
 *
 * **Example:** Creating an instance from a Worker
 * ```typescript
 * const workflow = yield* MyWorkflow;
 * const instance = yield* workflow.create({ params: { orderId: "abc" } });
 * ```
 *
 * **Example:** Creating an instance with id and retention
 * ```typescript
 * const instance = yield* workflow.create({
 *   id: "order-abc",
 *   params: { orderId: "abc" },
 *   retention: { successRetention: "1 day", errorRetention: "7 days" },
 * });
 * ```
 *
 * **Example:** Creating a batch
 * ```typescript
 * const instances = yield* workflow.createBatch([
 *   { id: "order-a", params: { orderId: "a" } },
 *   { id: "order-b", params: { orderId: "b" } },
 * ]);
 * ```
 *
 * **Example:** Checking instance status
 * ```typescript
 * const workflow = yield* MyWorkflow;
 * const handle = yield* workflow.get(instanceId);
 * const status = yield* handle.status();
 * ```
 *
 * **Example:** Sending events and restarting instances
 * ```typescript
 * const instance = yield* workflow.get(instanceId);
 * yield* instance.sendEvent({ type: "approval", payload: { approved: true } });
 * yield* instance.restart({ from: { name: "approval", type: "waitForEvent" } });
 * ```
 *
 * ### Triggering from a Worker
 * Wire the workflow into HTTP routes so callers can fire instances
 * and poll for completion.
 *
 * **Example:** Workflow start + status routes
 * ```typescript
 * // src/worker.ts
 * const notifier = yield* MyWorkflow;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *
 *     if (request.url.startsWith("/workflow/start/")) {
 *       const id = request.url.split("/").pop()!;
 *       const instance = yield* notifier.create({ params: { orderId: id } });
 *       return HttpServerResponse.json({ instanceId: instance.id });
 *     }
 *
 *     if (request.url.startsWith("/workflow/status/")) {
 *       const id = request.url.split("/").pop()!;
 *       const instance = yield* notifier.get(id);
 *       return HttpServerResponse.json(yield* instance.status());
 *     }
 *
 *     return HttpServerResponse.text("Not Found", { status: 404 });
 *   }),
 * };
 * ```
 *
 * ### Binding in an Async Worker
 * When using an Async Worker (plain `async fetch` handler, no Effect
 * runtime), declare Workflows in the `env` prop of the Worker resource.
 * Pass a `Workflow` reference with a `className` matching the exported
 * `WorkflowEntrypoint` subclass in your worker source file. If `className`
 * is omitted, it defaults to the binding name. Use `Cloudflare.InferEnv`
 * to get a fully typed `env` object that includes the workflow binding.
 *
 * **Example:** Declaring a Workflow binding in the stack
 * ```typescript
 * // alchemy.run.ts
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>("MyWorkflow", {
 *       className: "MyWorkflow",
 *       workflowName: "my-existing-workflow",
 *     }),
 *   },
 * });
 * ```
 *
 * **Example:** Native cron schedules on an async Workflow binding
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     HOURLY: Cloudflare.Workflow("HourlyWorkflow", {
 *       className: "HourlyWorkflow",
 *       schedules: ["0 * * * *"],
 *     }),
 *   },
 * });
 * ```
 *
 * **Example:** Using the Workflow from a plain async handler
 * ```typescript
 * // src/worker.ts
 * import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
 * import type { WorkerEnv } from "../alchemy.run.ts";
 *
 * export class MyWorkflow extends WorkflowEntrypoint<WorkerEnv, { value: string }> {
 *   async run(event: Readonly<WorkflowEvent<{ value: string }>>, step: WorkflowStep) {
 *     return await step.do("greet", async () => `Hello, ${event.payload.value}!`);
 *   }
 * }
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv) {
 *     const instance = await env.MY_WORKFLOW.create({ params: { value: "world" } });
 *     return Response.json({ instanceId: instance.id });
 *   },
 * };
 * ```
 *
 * ### Consuming the Workflow's Physical Name
 * An external/async Worker declaration exposes each Workflow binding on `worker.env` with
 * the Workflow's account-global `workflowName` as an `Output` of the
 * current deploy. Pass the binding directly as a Queue subscription's
 * `source`; it deploys after the Workflow is registered, including on the
 * first deployment. Explicit source descriptors remain supported for
 * Workflows referenced by physical name.
 *
 * **Example:** Subscribing a Queue to the Workflow's events
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     FILE_URL_INGESTION: Cloudflare.Workflow("FileUrlIngestion", {
 *       className: "FileUrlIngestionWorkflow",
 *     }),
 *   },
 * });
 *
 * yield* Cloudflare.Queues.Subscription("WorkflowEvents", {
 *   source: worker.env.FILE_URL_INGESTION,
 *   events: ["instance.completed", "instance.errored"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * ### Referencing a Deployed Workflow
 * `Workflow.ref` reads the same persisted resource as `WorkflowResource.ref`.
 * Use its logical ID (including any namespace), not its physical name or
 * Worker env key. Omitting `stack` and `stage` uses the current stack/stage.
 * Deploy the host first; a reference does not register or own the Workflow
 * and returns resource attributes, not a runtime `WorkflowHandle`.
 *
 * **Example:** Subscribe to a Workflow in another stack
 * ```typescript
 * yield* Cloudflare.Queues.Subscription("WorkflowEvents", {
 *   source: yield* Cloudflare.Workflow.ref("Ingestion", {
 *     stack: "workflow-host",
 *     stage: "production",
 *   }),
 *   events: ["instance.completed", "instance.errored"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * ### Cross-Script Binding in an Async Worker
 * Async Workers can also bind to a Workflow hosted by another Worker
 * script. The host Worker declares and exports the `WorkflowEntrypoint`
 * class. The consumer Worker declares a `Workflow` with `scriptName` set
 * to the host Worker's script name. Cross-script references are bindings
 * only — Alchemy does not drive `putWorkflow` for the foreign class, so
 * deploy the host first.
 *
 * **Example:** Consumer Worker binds to the host script
 * ```typescript
 * const consumer = yield* Cloudflare.Worker("Consumer", {
 *   main: "./src/consumer.ts",
 *   env: {
 *     MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
 *       className: "MyWorkflow",
 *       scriptName: host.workerName,
 *       // Repeat the host's explicit or preserved physical name when it
 *       // does not use Alchemy's current generated default.
 *       workflowName: "my-existing-workflow",
 *     }),
 *   },
 * });
 * ```
 *
 * ### Testing Workflows
 * Workflows run asynchronously, so tests start an instance and poll until it
 * reaches a terminal status. Keep polling bounded with `Effect.repeat`.
 *
 * **Example:** Polling for workflow completion
 * ```typescript
 * test(
 *   "workflow completes",
 *   Effect.gen(function* () {
 *     const { url } = yield* stack;
 *
 *     const start = yield* HttpClient.post(`${url}/workflow/start/x`);
 *     const { instanceId } = (yield* start.json) as { instanceId: string };
 *
 *     const status = yield* HttpClient.get(
 *       `${url}/workflow/status/${instanceId}`,
 *     ).pipe(
 *       Effect.flatMap((res) => res.json),
 *       Effect.map((json) => json as { status: string }),
 *       Effect.repeat({
 *         schedule: Schedule.spaced("2 seconds"),
 *         until: (status) =>
 *           status.status === "complete" || status.status === "errored",
 *         times: 30,
 *       }),
 *     );
 *
 *     expect(status.status).toBe("complete");
 *   }),
 *   { timeout: 120_000 },
 * );
 * ```
 *
 * ### Observing and Deleting Instances
 * **Example:** Read an event and remove stored state
 * ```typescript
 * const instance = yield* workflow.get("report-123");
 * const events = yield* instance.subscribe({ filter: ["workflow_queued"] }).pipe(
 *   Stream.take(1),
 *   Stream.runCollect,
 * );
 * yield* instance.delete();
 * const result = yield* workflow.deleteBatch(["report-456", "report-789"]);
 * // result.deleted contains successful IDs; result.errors contains per-instance failures.
 * ```
 *
 * @resource
 * @product Workflows
 * @category Workers & Compute
 */
export const Workflow: WorkflowClass = taggedFunction(WorkflowScope, ((
  ...args:
    | []
    | [name: string, impl: Effect.Effect<WorkflowImpl<any, any, unknown>>]
    | [
        name: string,
        props: WorkflowProps,
        impl: Effect.Effect<WorkflowImpl<any, any, unknown>>,
      ]
    | [name: string, props?: WorkflowRefProps]
) => {
  if (args.length === 0) {
    return Workflow;
  }
  const [name, second, third] = args;
  const impl = Effect.isEffect(second)
    ? second
    : Effect.isEffect(third)
      ? third
      : undefined;
  if (impl === undefined) {
    // Props-only (async) reference form: returns a plain `WorkflowLike` that an
    // async Worker binds via `env`. `WorkerAsyncBindings` emits the `workflow`
    // binding and drives `putWorkflow` for locally-hosted workflows.
    const refProps = second as WorkflowRefProps | undefined;
    return {
      kind: TypeId,
      name,
      workflowName: refProps?.workflowName,
      className: refProps?.className ?? name,
      scriptName: refProps?.scriptName,
      limits: refProps?.limits,
      schedules: refProps?.schedules,
    } satisfies WorkflowLike;
  }
  const props = Effect.isEffect(second) ? undefined : (second as WorkflowProps);
  return effectClass(
    Effect.gen(function* () {
      const worker = yield* Worker;

      const workflow = yield* WorkflowResource(name, {
        workflowName: props?.workflowName,
        className: name,
        scriptName:
          props?.workflowName === undefined ? worker.workerName : undefined,
        limits: props?.limits,
        schedules: props?.schedules,
      });
      // Keep named identities resolvable for the engine's cold-adoption probe.
      if (props?.workflowName !== undefined) {
        yield* workflow.bind`${worker}`({ scriptName: worker.workerName });
      }

      // Add the workflow binding to the Worker metadata
      yield* worker.bind`${name}`({
        bindings: [
          {
            type: "workflow",
            name,
            workflowName: props?.workflowName ?? workflow.workflowName,
            className: name,
          },
        ],
      });

      const services = yield* Effect.context<Effect.Services<typeof impl>>();

      const binding = yield* Effect.all([
        WorkerEnvironment,
        ALCHEMY_PHASE,
      ]).pipe(
        Effect.flatMap(([env, phase]) => {
          if (env === undefined || phase === "plan") {
            return Effect.succeed(undefined as any);
          }
          const wf = env[name];
          if (!wf) {
            return Effect.die(new Error(`Workflow '${name}' not found in env`));
          }
          return Effect.succeed(wf);
        }),
      );

      const self: WorkflowHandle<any, any> = {
        Type: TypeId,
        name,
        create: (options?: WorkflowInstanceCreateOptions<any>) =>
          Effect.tryPromise(() => binding.create(options)).pipe(
            Effect.map(wrapInstance),
            Effect.orDie,
          ),
        createBatch: (batch: WorkflowInstanceCreateOptions<any>[]) =>
          Effect.tryPromise(
            () => binding.createBatch(batch) as Promise<any[]>,
          ).pipe(
            Effect.map((instances: any[]) => instances.map(wrapInstance)),
            Effect.orDie,
          ),
        deleteBatch: (instanceIds) =>
          Effect.tryPromise(
            () =>
              binding.deleteBatch(
                instanceIds,
              ) as Promise<WorkflowBatchDeleteResult>,
          ).pipe(Effect.orDie),
        get: (instanceId: string) =>
          Effect.tryPromise(() => binding.get(instanceId)).pipe(
            Effect.map(wrapInstance),
            Effect.orDie,
          ),
      };

      const fn = yield* impl.pipe(
        Effect.provideService(WorkflowScope, self as any),
      );

      yield* worker.export(name, {
        kind: "workflow",
        make: (env: unknown) =>
          Effect.succeed(((input: unknown) =>
            fn(input).pipe(
              Effect.provideService(
                WorkerEnvironment,
                env as Record<string, any>,
              ),
            )) as WorkflowImpl<any, any, unknown>).pipe(
            Effect.provideContext(services),
          ),
      } satisfies WorkflowExport);

      return self;
    }),
  );
}) as any);

Workflow.ref = (id, options) => WorkflowResource.ref(id, options);

// ---------------------------------------------------------------------------
// WorkflowResource -- manages the Cloudflare Workflows API lifecycle
// ---------------------------------------------------------------------------

export interface WorkflowResourceProps {
  /**
   * Account-global Workflow name. If omitted, a deterministic name is derived
   * from `scriptName` and `className`.
   *
   * @internal
   */
  workflowName?: string;
  className: string;
  /** Hosting Worker script, supplied here or through a host binding. */
  scriptName?: string;
  limits?: WorkflowLimits;
  /**
   * Cron expressions that create a new Workflow instance on each match.
   * Pass an empty array to remove all schedules.
   */
  schedules?: string[];
}

export interface WorkflowResourceAttrs {
  workflowId: string;
  workflowName: string;
  className: string;
  scriptName: string;
  accountId: string;
  /**
   * Cron expressions currently attached to this Workflow.
   */
  schedules: string[];
}

const WorkflowResourceTypeId = "Cloudflare.Workflow";

export interface WorkflowResource extends Resource<
  typeof WorkflowResourceTypeId,
  WorkflowResourceProps,
  WorkflowResourceAttrs,
  { scriptName: string }
> {}

export const WorkflowResource = Resource<WorkflowResource>(
  WorkflowResourceTypeId,
);

const getWorkflowOrUndefined = (accountId: string, workflowName: string) =>
  workflows
    .getWorkflow({ accountId, workflowName })
    .pipe(Effect.catchTag("WorkflowNotFound", () => Effect.succeed(undefined)));

export const ProviderLive = () =>
  Provider.succeed(WorkflowResource, {
    // `workflowId` is stable across live updates: `putWorkflow` is a
    // PUT-as-upsert keyed by the account-global `workflowName`, so re-putting
    // the same name (className/scriptName changes) preserves the workflow's
    // id. The dev→deploy id change that used to force `workflowId` out of
    // this list is now an engine-orchestrated mode-switch REPLACEMENT (the
    // persisted `providerMode` stamp differs), so the live provider never
    // sees a `dev:` id.
    stables: ["workflowId", "accountId", "workflowName"],
    // Workflows are account-scoped. Enumerate every workflow in the account
    // via the paginated list API and hydrate each into the same Attributes
    // shape `reconcile` returns (id/name/className/scriptName are all on the
    // list item, so no per-item get is needed).
    list: () =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* workflows.listWorkflows.pages({ accountId }).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((wf) => ({
                workflowId: wf.id,
                workflowName: wf.name,
                // `className`/`scriptName` can be null/absent in the list
                // payload on some accounts — fall back so listing succeeds.
                className: wf.className ?? "",
                scriptName: wf.scriptName ?? "",
                accountId,
                schedules: fromObservedSchedules(wf.schedules),
              })),
            ),
          ),
        );
      }),
    diff: Effect.fn(function* ({
      id,
      olds,
      news,
      output,
      oldBindings,
      newBindings,
    }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.accountId !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }

      // The host script may be unresolved even when the physical name is known.
      const explicitName =
        "workflowName" in news && isResolved(news.workflowName)
          ? news.workflowName
          : undefined;
      const oldName =
        output?.workflowName ??
        olds.workflowName ??
        (olds.scriptName === undefined
          ? undefined
          : yield* generateWorkflowName(olds.scriptName, olds.className));
      // Omitting the name preserves the deployed identity, including legacy names.
      if (explicitName !== undefined && explicitName !== oldName) {
        const existing = yield* getWorkflowOrUndefined(accountId, explicitName);
        if (existing !== undefined) {
          return yield* new OwnedBySomeoneElse({
            message: `Cannot replace Workflow '${oldName}' with occupied name '${explicitName}'. Choose an unused name.`,
            resourceType: WorkflowResourceTypeId,
            logicalId: id,
            physicalName: explicitName,
          });
        }
        return { action: "replace" } as const;
      }
      if (
        !isResolved(newBindings) ||
        havePropsChanged(oldBindings, newBindings)
      ) {
        return { action: "update" } as const;
      }
    }),
    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workflowName =
        output?.workflowName ??
        olds?.workflowName ??
        (olds?.scriptName === undefined
          ? undefined
          : yield* generateWorkflowName(olds.scriptName, olds.className));
      if (workflowName === undefined) return undefined;

      const acct = output?.accountId ?? accountId;
      const workflow = yield* getWorkflowOrUndefined(acct, workflowName);
      if (workflow === undefined) return undefined;
      const attrs = {
        workflowId: workflow.id,
        workflowName: workflow.name,
        className: workflow.className,
        scriptName: workflow.scriptName,
        accountId: acct,
        schedules: fromObservedSchedules(workflow.schedules),
      };
      // Explicit names carry no ownership marker; cold reads require adoption.
      return output === undefined && olds?.workflowName !== undefined
        ? Unowned(attrs)
        : attrs;
    }),
    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const scriptName = yield* resolveWorkflowScriptName(news, bindings);
      const acct = output?.accountId ?? accountId;
      const workflowName =
        news.workflowName ??
        output?.workflowName ??
        (yield* generateWorkflowName(scriptName, news.className));

      if (
        news.workflowName !== undefined &&
        output?.workflowName !== undefined &&
        news.workflowName !== output.workflowName
      ) {
        return yield* Effect.fail(
          new Error(
            `Workflow physical name changed from '${output.workflowName}' to '${news.workflowName}' during an in-place update; a replacement is required.`,
          ),
        );
      }

      const existing = yield* getWorkflowOrUndefined(acct, workflowName);
      // Re-check occupied names at apply time; replacement is not adoption.
      if (
        news.workflowName !== undefined &&
        output === undefined &&
        existing !== undefined
      ) {
        return yield* new OwnedBySomeoneElse({
          message:
            `Cannot create Workflow '${workflowName}': an existing ` +
            "Workflow has that account-global name. Choose an unused name, " +
            "or adopt it into a resource with no prior state by re-planning " +
            "with --adopt.",
          resourceType: WorkflowResourceTypeId,
          logicalId: id,
          physicalName: workflowName,
        });
      }
      // PUT clears omitted schedules; preserve observed state unless explicitly set.
      const schedules =
        news.schedules ?? fromObservedSchedules(existing?.schedules);

      yield* Effect.logInfo(`Cloudflare Workflow reconcile: ${workflowName}`);
      // Cloudflare's `putWorkflow` is a true PUT-as-upsert: identical
      // payloads converge to the same state and a missing workflow is
      // created on the spot.
      const result = yield* workflows.putWorkflow({
        accountId: acct,
        workflowName,
        className: news.className,
        scriptName,
        limits: news.limits,
        schedules: toPutSchedules(schedules),
      });
      return {
        workflowId: result.id,
        workflowName: result.name,
        className: result.className,
        scriptName: result.scriptName,
        accountId: acct,
        schedules,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* Effect.logInfo(
        `Cloudflare Workflow delete: ${output.workflowName}`,
      );
      yield* workflows
        .deleteWorkflow({
          accountId: output.accountId,
          workflowName: output.workflowName,
        })
        .pipe(Effect.catchTag("WorkflowNotFound", () => Effect.void));
    }),
  });

/**
 * Local (dev) provider — the workflow is purely virtual: a `dev:` id keyed
 * into the local workerd workflow engine. The host worker's `workflow`
 * binding is lowered onto the local runtime's Workflow Engine DO by
 * `LocalWorkerProvider` (`Workflows.local(...)`), so no runtime layer is
 * needed here; instance state persists under the worker's local storage.
 */
export const ProviderLocal = () =>
  Provider.succeed(WorkflowResource, {
    stables: ["accountId"],
    diff: Effect.fn(function* ({ news, output, oldBindings, newBindings }) {
      const accountId = yield* localAccountId;
      if (!output?.workflowId) return { action: "update" } as const;
      if (output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // The host script may be unresolved even when the physical name is known.
      const explicitName =
        "workflowName" in news && isResolved(news.workflowName)
          ? news.workflowName
          : undefined;
      if (explicitName !== undefined && explicitName !== output.workflowName) {
        return { action: "replace" } as const;
      }
      if (
        !isResolved(newBindings) ||
        havePropsChanged(oldBindings, newBindings)
      ) {
        return { action: "update" } as const;
      }
      // Fall through to the engine's default prop diff (className /
      // scriptName changes update in place).
    }),
    read: Effect.fn(function* ({ output }) {
      // Purely virtual — the persisted state row is the source of truth.
      return output ?? undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output, bindings }) {
      const accountId = yield* localAccountId;
      const scriptName = yield* resolveWorkflowScriptName(news, bindings);
      if (
        news.workflowName !== undefined &&
        output?.workflowName !== undefined &&
        news.workflowName !== output.workflowName
      ) {
        return yield* Effect.fail(
          new Error(
            `Workflow physical name changed from '${output.workflowName}' to '${news.workflowName}' during an in-place update; a replacement is required.`,
          ),
        );
      }
      return {
        workflowId: output?.workflowId ?? generateLocalId(),
        workflowName:
          news.workflowName ??
          output?.workflowName ??
          (yield* generateWorkflowName(scriptName, news.className)),
        className: news.className,
        scriptName,
        accountId: output?.accountId ?? accountId,
        schedules: news.schedules ?? output?.schedules ?? [],
      };
    }),
    delete: Effect.fn(function* () {
      // The simulator's on-disk instance state lives under the local worker's
      // storage; dropping the state row is enough — orphaned data is
      // reclaimed with `.alchemy`.
    }),
  });

export const WorkflowProvider = () =>
  ProviderLayer.dual(WorkflowResource, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolveWorkflowScriptName = (
  props: WorkflowResourceProps,
  bindings: ReadonlyArray<{ data: { scriptName: string } }>,
) => {
  const scripts = [
    ...new Set(
      [
        props.scriptName,
        ...bindings.map((binding) => binding.data.scriptName),
      ].filter((name) => name !== undefined),
    ),
  ];
  return scripts.length === 1
    ? Effect.succeed(scripts[0]!)
    : Effect.fail(
        new Error("Workflow requires exactly one hosting Worker script"),
      );
};

const toPutSchedules = (
  schedules: string[],
): workflows.UpdateRequestSchedulesList => schedules.map((cron) => ({ cron }));

const fromObservedSchedules = (
  schedules?: ReadonlyArray<{ cron: string }> | null,
): string[] => (schedules ?? []).map((s) => s.cron);

const wrapInstance = <Result>(raw: any): WorkflowInstance<Result> => ({
  id: raw.id,
  status: () =>
    Effect.tryPromise(() => raw.status()).pipe(
      Effect.map((s: any) => ({
        status: s.status as string,
        output: s.output as Result,
        error: s.error,
        rollback: s.rollback,
      })),
      Effect.orDie,
    ),
  pause: () => Effect.tryPromise(() => raw.pause()).pipe(Effect.orDie),
  resume: () => Effect.tryPromise(() => raw.resume()).pipe(Effect.orDie),
  restart: (options?: WorkflowInstanceRestartOptions) =>
    Effect.tryPromise(() => raw.restart(options)).pipe(Effect.orDie),
  terminate: () => Effect.tryPromise(() => raw.terminate()).pipe(Effect.orDie),
  delete: () => Effect.tryPromise(() => raw.delete()).pipe(Effect.orDie),
  subscribe: (options) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.tryPromise(
          () =>
            raw.subscribe(options) as Promise<
              runtime.WorkflowInstanceSubscription & Disposable
            >,
        ).pipe(Effect.orDie),
        (subscription) => Effect.sync(() => subscription[Symbol.dispose]()),
      ).pipe(
        Effect.map((subscription) =>
          Stream.fromAsyncIterable(
            {
              [Symbol.asyncIterator]: () => ({
                next: () => subscription.next(),
              }),
            },
            (error) => error,
          ).pipe(Stream.orDie),
        ),
      ),
    ),
  sendEvent: <Event = unknown>(event: WorkflowInstanceEvent<Event>) =>
    Effect.tryPromise(() => raw.sendEvent(event)).pipe(Effect.orDie),
});

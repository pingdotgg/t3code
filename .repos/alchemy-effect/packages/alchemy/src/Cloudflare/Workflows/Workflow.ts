import * as workflows from "@distilled.cloud/cloudflare/workflows";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { Input } from "../../Input.ts";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import type { PlatformServices } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  Worker,
  WorkerEnvironment,
  type WorkerServices,
} from "../Workers/Worker.ts";
import { makeWorkflowName } from "./WorkflowName.ts";

type TypeId = "Cloudflare.Workflow";
const TypeId = "Cloudflare.Workflow" as const;

// ---------------------------------------------------------------------------
// Runtime services -- provided by the bridge when the workflow executes
// ---------------------------------------------------------------------------

/**
 * Service that carries the current workflow event payload.
 * `yield* WorkflowEvent` inside a workflow body to access it.
 */
export class WorkflowEvent extends Context.Service<
  WorkflowEvent,
  {
    payload: unknown;
    timestamp: Date;
    instanceId: string;
    workflowName: string;
    schedule?: WorkflowCronSchedule;
  }
>()("Cloudflare.Workflows.WorkflowEvent") {}

export interface WorkflowCronSchedule {
  cron: string;
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

/**
 * Runtime information for the current `task` attempt.
 */
export class WorkflowStepContext extends Context.Service<
  WorkflowStepContext,
  WorkflowStepContextData
>()("Cloudflare.WorkflowStepContext") {}

export interface WorkflowRollbackContext<Output = unknown> {
  error: Error;
  output: Output | undefined;
}

export interface WorkflowRollbackOptions<Output = unknown, R = never> {
  rollback: (
    context: WorkflowRollbackContext<Output>,
  ) => Effect.Effect<void, never, R>;
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
  ) => Effect.Effect<void, never, RollbackReq>;
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
> extends WorkflowTaskConfig<Output, RollbackReq> {
  name: string;
  effect: Effect.Effect<Output, never, R>;
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

/**
 * Internal service that wraps the Cloudflare `WorkflowStep` object.
 * Not accessed directly by users -- use `task`, `sleep`, `sleepUntil`, and
 * `waitForEvent` instead.
 */
export class WorkflowStep extends Context.Service<
  WorkflowStep,
  {
    do<T>(options: WorkflowTaskOptions<T, any, any>): Effect.Effect<T>;
    sleep(name: string, duration: string | number): Effect.Effect<void>;
    sleepUntil(name: string, timestamp: Date | number): Effect.Effect<void>;
    waitForEvent<T>(
      name: string,
      options: WorkflowWaitForEventOptions,
    ): Effect.Effect<WorkflowStepEvent<T>>;
  }
>()("Cloudflare.Workflows.WorkflowStep") {}

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
 */
export function task<T, R = never, RollbackReq = never>(
  name: string,
  effect: Effect.Effect<T, never, R>,
  options?: WorkflowTaskConfig<T, RollbackReq>,
): Effect.Effect<
  T,
  never,
  WorkflowStep | ExcludeWorkflowStepContext<R | RollbackReq>
> {
  return Effect.gen(function* () {
    const step = yield* WorkflowStep;
    const context =
      yield* Effect.context<ExcludeWorkflowStepContext<R | RollbackReq>>();
    const rollbackEffect = options?.rollback;
    return yield* step.do({
      ...options,
      name,
      effect: effect.pipe(Effect.provide(context)),
      rollback: rollbackEffect
        ? (rollbackContext: WorkflowRollbackContext<T>) =>
            rollbackEffect(rollbackContext).pipe(Effect.provide(context))
        : undefined,
    } as WorkflowTaskOptions<T, any, any>);
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
  readonly make: (env: unknown) => Effect.Effect<WorkflowImpl<any, any>>;
}

/**
 * A workflow implementation is a function from a typed `Input` payload to
 * an Effect that produces the workflow's `Result`. The Effect requires
 * `WorkflowRunServices` (event + step + env) to execute.
 */
export type WorkflowImpl<Input = unknown, Result = unknown> = (
  input: Input,
) => Effect.Effect<Result, never, WorkflowServices>;

export const isWorkflowExport = (value: unknown): value is WorkflowExport =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as any).kind === "workflow";

/**
 * Props for the reference (async) form of {@link Workflow}. Used when binding
 * a Workflow class to a plain async Worker (one without an Effect runtime) via
 * the Worker's `env`. Mirrors `DurableObjectProps`.
 */
export interface WorkflowRefProps {
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
  /** @internal phantom */
  workflowName?: string;
  /** @internal phantom */
  className?: string;
  /** @internal phantom */
  scriptName?: Input<string>;
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
  <_Self>(): {
    <Input = unknown, Result = unknown, InitReq = never>(
      name: string,
      impl: Effect.Effect<WorkflowImpl<Input, Result>, ConfigError, InitReq>,
    ): Effect.Effect<
      WorkflowHandle<Input, Result>,
      never,
      Worker | Exclude<InitReq, WorkflowServices>
    > & {
      new (_: never): WorkflowImpl<Input, Result>;
    };
  };
  <Params = unknown>(
    name: string,
    props?: WorkflowRefProps,
  ): WorkflowLike<Params>;
  <Input = unknown, Result = unknown, InitReq = never>(
    name: string,
    impl: Effect.Effect<WorkflowImpl<Input, Result>, ConfigError, InitReq>,
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
 * @resource
 * @product Workflows
 * @category Workers & Compute
 *
 * @section Defining a Workflow
 * @example Minimal workflow
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
 * @section Step Primitives
 * @example Running a named task
 * ```typescript
 * const result = yield* Cloudflare.Workflows.task(
 *   "process-order",
 *   Effect.succeed({ orderId: "abc", total: 42 }),
 * );
 * ```
 *
 * @example Configuring retries and reading step context
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
 * @example Registering rollback
 * ```typescript
 * yield* Cloudflare.Workflows.task("reserve-inventory", reserveInventory, {
 *   rollback: ({ output }) =>
 *     output ? releaseInventory(output.reservationId) : Effect.void,
 *   rollbackConfig: { retries: { limit: 3, delay: "10 seconds" } },
 * });
 * ```
 *
 * @example Sleeping between steps
 * ```typescript
 * yield* Cloudflare.Workflows.sleep("cooldown", "30 seconds");
 * ```
 *
 * @example Waiting for an external event
 * ```typescript
 * const event = yield* Cloudflare.Workflows.waitForEvent<{ approved: boolean }>(
 *   "approval",
 *   { type: "approval", timeout: "1 day" },
 * );
 * // Same shape as the native step.waitForEvent result:
 * event.payload.approved;
 * ```
 *
 * @example Accessing env bindings inside a task
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
 * @section Starting and Monitoring Instances
 * `create` mirrors Cloudflare's native Workflow API: pass workflow input in
 * `params`, pass `id` only when you need a deterministic instance ID, and omit
 * `id` to let Cloudflare generate one.
 *
 * @example Creating an instance from a Worker
 * ```typescript
 * const workflow = yield* MyWorkflow;
 * const instance = yield* workflow.create({ params: { orderId: "abc" } });
 * ```
 *
 * @example Creating an instance with id and retention
 * ```typescript
 * const instance = yield* workflow.create({
 *   id: "order-abc",
 *   params: { orderId: "abc" },
 *   retention: { successRetention: "1 day", errorRetention: "7 days" },
 * });
 * ```
 *
 * @example Creating a batch
 * ```typescript
 * const instances = yield* workflow.createBatch([
 *   { id: "order-a", params: { orderId: "a" } },
 *   { id: "order-b", params: { orderId: "b" } },
 * ]);
 * ```
 *
 * @example Checking instance status
 * ```typescript
 * const workflow = yield* MyWorkflow;
 * const handle = yield* workflow.get(instanceId);
 * const status = yield* handle.status();
 * ```
 *
 * @example Sending events and restarting instances
 * ```typescript
 * const instance = yield* workflow.get(instanceId);
 * yield* instance.sendEvent({ type: "approval", payload: { approved: true } });
 * yield* instance.restart({ from: { name: "approval", type: "waitForEvent" } });
 * ```
 *
 * @section Triggering from a Worker
 * Wire the workflow into HTTP routes so callers can fire instances
 * and poll for completion.
 *
 * @example Workflow start + status routes
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
 * @section Binding in an Async Worker
 * When using an Async Worker (plain `async fetch` handler, no Effect
 * runtime), declare Workflows in the `env` prop of the Worker resource.
 * Pass a `Workflow` reference with a `className` matching the exported
 * `WorkflowEntrypoint` subclass in your worker source file. If `className`
 * is omitted, it defaults to the binding name. Use `Cloudflare.InferEnv`
 * to get a fully typed `env` object that includes the workflow binding.
 *
 * @example Declaring a Workflow binding in the stack
 * ```typescript
 * // alchemy.run.ts
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>("MyWorkflow", {
 *       className: "MyWorkflow",
 *     }),
 *   },
 * });
 * ```
 *
 * @example Using the Workflow from a plain async handler
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
 * @section Cross-Script Binding in an Async Worker
 * Async Workers can also bind to a Workflow hosted by another Worker
 * script. The host Worker declares and exports the `WorkflowEntrypoint`
 * class. The consumer Worker declares a `Workflow` with `scriptName` set
 * to the host Worker's script name. Cross-script references are bindings
 * only — Alchemy does not drive `putWorkflow` for the foreign class, so
 * deploy the host first.
 *
 * @example Consumer Worker binds to the host script
 * ```typescript
 * const consumer = yield* Cloudflare.Worker("Consumer", {
 *   main: "./src/consumer.ts",
 *   env: {
 *     MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
 *       className: "MyWorkflow",
 *       scriptName: host.workerName,
 *     }),
 *   },
 * });
 * ```
 *
 * @section Testing Workflows
 * Workflows run asynchronously, so tests start an instance and poll until it
 * reaches a terminal status. Keep polling bounded with `Effect.repeat`.
 *
 * @example Polling for workflow completion
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
 */
export const Workflow: WorkflowClass = taggedFunction(WorkflowScope, ((
  ...args:
    | []
    | [name: string, impl: Effect.Effect<WorkflowImpl<any, any>>]
    | [name: string, props?: WorkflowRefProps]
) => {
  if (args.length === 0) {
    return Workflow;
  }
  const [name, second] = args;
  if (!Effect.isEffect(second)) {
    // Props-only (async) reference form: returns a plain `WorkflowLike` that an
    // async Worker binds via `env`. `WorkerAsyncBindings` emits the `workflow`
    // binding and drives `putWorkflow` for locally-hosted workflows.
    const props = second as WorkflowRefProps | undefined;
    return {
      kind: TypeId,
      name,
      className: props?.className ?? name,
      scriptName: props?.scriptName,
    } satisfies WorkflowLike;
  }
  const impl = second;
  return effectClass(
    Effect.gen(function* () {
      const worker = yield* Worker;

      // Workflow names are account-global, so derive the physical name from
      // the already-unique host Worker name and exported class name.
      const workflowName = makeWorkflowName(worker.workerName, name);
      const workflow = yield* WorkflowResource(name, {
        workflowName,
        className: name,
        scriptName: worker.workerName,
      });

      // Add the workflow binding to the Worker metadata
      yield* worker.bind`${name}`({
        bindings: [
          {
            type: "workflow",
            name,
            workflowName: workflow.workflowName,
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
            )) as WorkflowImpl<any, any>).pipe(Effect.provideContext(services)),
      } satisfies WorkflowExport);

      return self;
    }),
  );
}) as any);

// ---------------------------------------------------------------------------
// WorkflowResource -- manages the Cloudflare Workflows API lifecycle
// ---------------------------------------------------------------------------

export interface WorkflowResourceProps {
  /**
   * Account-global Workflow name.
   */
  workflowName: string;
  className: string;
  scriptName: string;
}

export interface WorkflowResourceAttrs {
  workflowId: string;
  workflowName: string;
  className: string;
  scriptName: string;
  accountId: string;
}

const WorkflowResourceTypeId = "Cloudflare.Workflow";

export interface WorkflowResource extends Resource<
  typeof WorkflowResourceTypeId,
  WorkflowResourceProps,
  WorkflowResourceAttrs
> {}

export const WorkflowResource = Resource<WorkflowResource>(
  WorkflowResourceTypeId,
);

export const WorkflowProvider = () =>
  Provider.effect(
    WorkflowResource,
    Effect.gen(function* () {
      const ctx = yield* AlchemyContext;

      return WorkflowResource.Provider.of({
        // The `workflowId` is no longer marked as stable because if you start in dev mode, the ID will change on first deploy.
        stables: ["accountId", "workflowName"],
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
                  })),
                ),
              ),
            );
          }),
        diff: Effect.fn(function* ({ output }) {
          // If the workflowId starts with "dev:", and we're not in dev mode, trigger an update so the workflow is created.
          if (output?.workflowId.startsWith("dev:") && !ctx.dev) {
            return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ output, olds }) {
          // Dev workflows only exist in local state; there is no account-level
          // Workflow API resource to observe until the first real deploy.
          if (ctx.dev) return output;

          const { accountId } = yield* yield* CloudflareEnvironment;
          const workflowName = output?.workflowName ?? olds?.workflowName;
          if (workflowName === undefined) return undefined;

          const acct = output?.accountId ?? accountId;
          return yield* workflows
            .getWorkflow({
              accountId: acct,
              workflowName,
            })
            .pipe(
              Effect.map((workflow) => ({
                workflowId: workflow.id,
                workflowName: workflow.name,
                className: workflow.className,
                scriptName: workflow.scriptName,
                accountId: acct,
              })),
              Effect.catchTag("WorkflowNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const acct = output?.accountId ?? accountId;
          const workflowName = news.workflowName;
          yield* Effect.logInfo(
            `Cloudflare Workflow reconcile: ${workflowName}`,
          );
          if (ctx.dev) {
            return {
              workflowId: output?.workflowId ?? `dev:${crypto.randomUUID()}`,
              accountId,
              workflowName,
              className: news.className,
              scriptName: news.scriptName,
            };
          }
          // Cloudflare's `putWorkflow` is a true PUT-as-upsert: identical
          // payloads converge to the same state and a missing workflow is
          // created on the spot. There is no separate observe step needed
          // — the API is naturally reconciler-shaped.
          const result = yield* workflows.putWorkflow({
            accountId: acct,
            workflowName,
            className: news.className,
            scriptName: news.scriptName,
          });
          return {
            workflowId: result.id,
            workflowName: result.name,
            className: result.className,
            scriptName: result.scriptName,
            accountId: acct,
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
    }),
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  sendEvent: <Event = unknown>(event: WorkflowInstanceEvent<Event>) =>
    Effect.tryPromise(() => raw.sendEvent(event)).pipe(Effect.orDie),
});

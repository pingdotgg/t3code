import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { buildEventTelemetry } from "../../Telemetry.ts";
import { isScopeEjected } from "../Workers/HttpServer.ts";
import { getWorkerExport } from "../Workers/WorkerBridge.ts";
import {
  WorkflowEvent as WorkflowEventService,
  type WorkflowExport,
  type WorkflowImpl,
  WorkflowStep,
  WorkflowStepContext,
  type WorkflowStepConfig,
  type WorkflowStepEvent,
  type WorkflowTaskOptions,
} from "./Workflow.ts";

/**
 * Create a WorkflowBridge class that extends `WorkflowEntrypoint` and
 * delegates the `run(event, step)` call to the Effect-native workflow body
 * registered via `worker.export(...)`.
 *
 * The bridge provides `WorkflowEvent` and `WorkflowStep` as Effect
 * services so the user writes `yield* WorkflowEvent` and `yield* task(...)`
 * instead of receiving callback parameters.
 */
export const makeWorkflowBridge =
  (
    WorkflowEntrypoint: abstract new (
      ctx: unknown,
      env: unknown,
    ) => { run(event: any, step: any): Promise<unknown> },
    {
      entrypoint,
      stack,
    }: {
      entrypoint: Effect.Effect<Record<string, any>>;
      stack: { name: string; stage: string };
    },
  ) =>
  (className: string) => {
    // One isolate-lifetime layer build shared by every instantiation of this
    // workflow class — `build` memoizes the built context.
    const { build } = getWorkerExport<WorkflowExport>({
      entrypoint,
      stack,
      exportName: className,
    });

    return class WorkflowBridge extends WorkflowEntrypoint {
      readonly build: Promise<{
        readonly context: Context.Context<never>;
        readonly fn: WorkflowImpl<unknown, unknown>;
        readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
      }>;

      constructor(ctx: unknown, env: unknown) {
        super(ctx, env);

        this.build = build(() => {}).then(
          ({ context, export: wf, telemetry }) =>
            wf.make(env).pipe(
              Effect.provideContext(context),
              Effect.map((fn) => ({
                context,
                fn: fn as WorkflowImpl<unknown, unknown>,
                telemetry,
              })),
              Effect.runPromise,
            ),
        );
      }

      async run(event: any, step: any): Promise<unknown> {
        const { context, fn, telemetry } = await this.build;
        // Each run-invocation gets a fresh `Scope`, following the same
        // per-invocation-scope pattern as `WorkerBridge.processEvent`. `task`
        // threads it into every step via the surrounding body context, so
        // `@binding` helpers that acquire per-run resources against the
        // ambient scope (e.g. `Drizzle.Postgres`) resolve them inside
        // workflow steps, matching the Worker and Durable Object bridges.
        const scope = Scope.makeUnsafe();
        const exit = await Effect.runPromiseExit(
          fn(event.payload).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(WorkflowEventService, wrapWorkflowEvent(event)),
                Layer.succeed(WorkflowStep, wrapWorkflowStep(step)),
                Layer.succeed(Scope.Scope, scope),
                // The configured telemetry exporters, attached to the run's
                // scope by `buildEventTelemetry` so buffered telemetry
                // flushes when the scope closes at the end of the
                // run-invocation.
                Layer.effectContext(
                  buildEventTelemetry(context, scope, telemetry()),
                ),
              ).pipe(Layer.provideMerge(Layer.succeedContext(context))),
            ),
          ) as Effect.Effect<unknown>,
        );
        // Settle the run's resources with its real exit, unless a binding
        // ejected the scope to outlive the invocation. The workflow runtime has
        // no `waitUntil` to detach cleanup to, so close inline — a failing
        // finalizer (e.g. a pg pool `end()` on a dropped connection) is logged
        // and ignored so it can't mask the run's outcome.
        if (!isScopeEjected(scope)) {
          await Scope.close(scope, exit).pipe(
            Effect.ignoreCause({
              log: "Warn",
              message: "Workflow run scope close failed",
            }),
            Effect.runPromise,
          );
        }
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        throw Cause.squash(exit.cause);
      }
    };
  };

const wrapWorkflowEvent = (event: any): WorkflowEventService["Service"] => ({
  payload: event.payload,
  timestamp:
    event.timestamp instanceof Date
      ? event.timestamp
      : new Date(event.timestamp),
  instanceId: event.instanceId ?? "",
  workflowName: event.workflowName ?? "",
  schedule: event.schedule,
});

export const wrapWorkflowStep = (step: any): WorkflowStep["Service"] => ({
  do: <T>(options: WorkflowTaskOptions<T, any, any>): Effect.Effect<T> => {
    const { name } = options;
    // The surrounding body context is already provided in `task`; the bridge
    // supplies `WorkflowStepContext` and runs the step to completion, so the
    // effect is fully satisfied (R = never) at this boundary.
    const effect = options.effect as Effect.Effect<
      T,
      never,
      WorkflowStepContext
    >;
    const config = toWorkflowStepConfig(options);
    const rollbackEffect = options.rollback;
    const callback = (context: any) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(WorkflowStepContext, {
            step: context.step,
            attempt: context.attempt,
            config: context.config,
          }),
        ),
      );
    const rollback = rollbackEffect
      ? {
          rollback: (context: any) =>
            Effect.runPromise(
              rollbackEffect({
                error: context.error,
                output: context.output,
              }) as Effect.Effect<void>,
            ),
          rollbackConfig: options.rollbackConfig,
        }
      : undefined;
    return Effect.promise(() => {
      if (config && rollback) return step.do(name, config, callback, rollback);
      if (config) return step.do(name, config, callback);
      if (rollback) return step.do(name, callback, rollback);
      return step.do(name, callback);
    });
  },
  sleep: (name: string, duration: string | number): Effect.Effect<void> =>
    Effect.promise(() => step.sleep(name, duration)),
  sleepUntil: (name: string, timestamp: Date | number): Effect.Effect<void> =>
    Effect.promise(() => step.sleepUntil(name, timestamp)),
  waitForEvent: <T>(
    name: string,
    options: any,
  ): Effect.Effect<WorkflowStepEvent<T>> =>
    Effect.promise(
      () => step.waitForEvent(name, options) as Promise<WorkflowStepEvent<T>>,
    ),
});

const toWorkflowStepConfig = (
  options: WorkflowTaskOptions<any, any, any>,
): WorkflowStepConfig | undefined => {
  if (!options.retries && !options.timeout) return undefined;
  return { retries: options.retries, timeout: options.timeout };
};

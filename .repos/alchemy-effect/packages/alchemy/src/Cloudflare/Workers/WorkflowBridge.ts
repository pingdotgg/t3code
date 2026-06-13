import * as Effect from "effect/Effect";
import {
  WorkflowEvent as WorkflowEventService,
  type WorkflowExport,
  type WorkflowImpl,
  WorkflowStep,
} from "./Workflow.ts";
import { getWorkerExport } from "./WorkerBridge.ts";

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
  (className: string) =>
    class WorkflowBridge extends WorkflowEntrypoint {
      readonly fn: Promise<WorkflowImpl<unknown, unknown>>;

      constructor(ctx: unknown, env: unknown) {
        super(ctx, env);

        const { globalContext, exported } = getWorkerExport<WorkflowExport>({
          entrypoint,
          stack,
          exportName: className,
        });

        this.fn = exported.pipe(
          Effect.flatMap((wf) => wf.make(env)),
          Effect.provide(globalContext),
          Effect.runPromise,
        ) as Promise<WorkflowImpl<unknown, unknown>>;
      }

      async run(event: any, step: any): Promise<unknown> {
        const fn = await this.fn;
        return Effect.runPromise(
          fn(event.payload).pipe(
            Effect.provideService(
              WorkflowEventService,
              wrapWorkflowEvent(event),
            ),
            Effect.provideService(WorkflowStep, wrapWorkflowStep(step)),
          ) as Effect.Effect<unknown>,
        );
      }
    };

const wrapWorkflowEvent = (
  event: any,
): { payload: unknown; timestamp: Date; instanceId: string } => ({
  payload: event.payload,
  timestamp:
    event.timestamp instanceof Date
      ? event.timestamp
      : new Date(event.timestamp),
  instanceId: event.instanceId ?? "",
});

const wrapWorkflowStep = (step: any): WorkflowStep["Service"] => ({
  do: <T>(name: string, effect: Effect.Effect<T>): Effect.Effect<T> =>
    Effect.tryPromise(
      () => step.do(name, () => Effect.runPromise(effect)) as Promise<T>,
    ),
  sleep: (name: string, duration: string | number): Effect.Effect<void> =>
    Effect.tryPromise(() => step.sleep(name, duration)),
  sleepUntil: (name: string, timestamp: Date | number): Effect.Effect<void> =>
    Effect.tryPromise(() =>
      step.sleepUntil(
        name,
        timestamp instanceof Date ? timestamp.toISOString() : timestamp,
      ),
    ),
});

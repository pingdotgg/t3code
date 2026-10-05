import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  WorkflowCronSchedule,
  WorkflowProps,
  WorkflowStepContextData,
  WorkflowStepEvent,
  WorkflowTaskOptions,
  WorkflowWaitForEventOptions,
} from "./Workflow.ts";

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
    /**
     * Present when Cloudflare created this instance from a native
     * {@link WorkflowProps.schedules} cron expression. Absent for
     * instances started with `create` / `createBatch`.
     */
    schedule?: WorkflowCronSchedule;
  }
>()("Cloudflare.Workflows.WorkflowEvent") {}

/**
 * Runtime information for the current `task` attempt.
 */
export class WorkflowStepContext extends Context.Service<
  WorkflowStepContext,
  WorkflowStepContextData
>()("Cloudflare.WorkflowStepContext") {}

/**
 * Internal service that wraps the Cloudflare `WorkflowStep` object.
 * Not accessed directly by users -- use `task`, `sleep`, `sleepUntil`, and
 * `waitForEvent` instead.
 */
export class WorkflowStep extends Context.Service<
  WorkflowStep,
  {
    do<T, E>(options: WorkflowTaskOptions<T, any, any, E>): Effect.Effect<T, E>;
    sleep(name: string, duration: string | number): Effect.Effect<void>;
    sleepUntil(name: string, timestamp: Date | number): Effect.Effect<void>;
    waitForEvent<T>(
      name: string,
      options: WorkflowWaitForEventOptions,
    ): Effect.Effect<WorkflowStepEvent<T>>;
  }
>()("Cloudflare.Workflows.WorkflowStep") {}

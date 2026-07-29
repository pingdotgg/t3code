import type * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import * as Binding from "../../Binding.ts";
import * as IAM from "../IAM/index.ts";
import type { Function as LambdaFunction } from "../Lambda/Function.ts";
import type { ScheduleBuilder, ScheduleBuilderState } from "./builders.ts";
import { Schedule } from "./Schedule.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

/**
 * The typed event a consumed schedule delivers to its handler. EventBridge
 * Scheduler substitutes the `<aws.scheduler.*>` context attributes into the
 * schedule's `Input` template at invocation time; `scheduleId` is the stable
 * route id used to match the invocation to the registered handler.
 */
export interface ScheduleEvent {
  source: "alchemy.scheduler";
  /**
   * Stable route id of the `consumeSchedule` registration that created the
   * schedule.
   */
  scheduleId: string;
  /**
   * ARN of the schedule (`<aws.scheduler.schedule-arn>`).
   */
  scheduleArn: string;
  /**
   * The time the invocation was scheduled for, ISO 8601
   * (`<aws.scheduler.scheduled-time>`).
   */
  scheduledTime: string;
  /**
   * Unique id of this delivery attempt (`<aws.scheduler.execution-id>`).
   */
  executionId: string;
  /**
   * Delivery attempt counter, 1-based (`<aws.scheduler.attempt-number>`).
   */
  attemptNumber: string;
}

/**
 * Narrow an arbitrary Lambda invocation payload to a schedule event produced
 * by `consumeSchedule`.
 */
export const isScheduleEvent = (event: any): event is ScheduleEvent =>
  event?.source === "alchemy.scheduler" &&
  typeof event?.scheduleId === "string";

export interface ScheduleRouteProps {
  /**
   * Optional schedule group the backing schedule is created in.
   * @default the AWS default group
   */
  group?: ScheduleGroup;
  /**
   * Optional description on the backing schedule.
   */
  description?: string;
  /**
   * Desired schedule state (`ENABLED` / `DISABLED`).
   */
  state?: string;
  /**
   * Timezone for cron or at expressions.
   */
  timezone?: string;
  /**
   * Optional start date.
   */
  startDate?: Date;
  /**
   * Optional end date.
   */
  endDate?: Date;
  /**
   * Optional KMS key ARN.
   */
  kmsKeyArn?: string;
  /**
   * Flexible time window configuration.
   * @default { Mode: "OFF" }
   */
  flexibleTimeWindow?: scheduler.FlexibleTimeWindow;
  /**
   * Action after a one-time schedule completes.
   */
  actionAfterCompletion?: string;
  /**
   * Retry policy for failed invocations.
   */
  retryPolicy?: scheduler.RetryPolicy;
  /**
   * Dead-letter queue for undeliverable invocations.
   */
  deadLetterConfig?: scheduler.DeadLetterConfig;
}

export interface ScheduleDescriptor {
  /**
   * Stable route id. Defaults to a hash of the schedule expression and the
   * host Function's logical id.
   */
  id?: string;
  /**
   * Schedule expression: `rate(...)`, `cron(...)`, or `at(...)`.
   */
  expression: string;
  props?: ScheduleRouteProps;
}

/**
 * The cron-handler DX for EventBridge Scheduler: a Lambda consumes its own
 * scheduled invocations. `consumeSchedule(every("5 minutes"), handler)`
 * provisions the backing `Schedule` (plus the synthesized execution role that
 * lets Scheduler invoke the host) and registers the runtime handler with a
 * typed event guard.
 * @binding
 */
export interface ScheduleEventSource extends Binding.Service<
  ScheduleEventSource,
  "AWS.Scheduler.ScheduleEventSource",
  ScheduleEventSourceService
> {}
export const ScheduleEventSource = Binding.Service<ScheduleEventSource>(
  "AWS.Scheduler.ScheduleEventSource",
);

export type ScheduleEventSourceService = <Req = never>(
  descriptor: ScheduleDescriptor,
  process: (event: ScheduleEvent) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Consume a schedule's invocations on the host Lambda Function — the "cron
 * handler" DX. Build the cadence with `every`/`cron`/`at` and pass the handler
 * as the last argument; the runtime layer provisions the backing schedule,
 * the execution role, and the typed event dispatch.
 *
 * @example Run a handler every 5 minutes
 * ```typescript
 * yield* AWS.Scheduler.consumeSchedule(
 *   AWS.Scheduler.every("5 minutes"),
 *   (event) => Effect.log(`fired at ${event.scheduledTime}`),
 * );
 * ```
 *
 * @example Name the backing schedule route deterministically
 * ```typescript
 * yield* AWS.Scheduler.consumeSchedule(
 *   "NightlyCleanup",
 *   AWS.Scheduler.cron("cron(0 3 * * ? *)"),
 *   (event) => Effect.log(`cleanup ${event.executionId}`),
 * );
 * ```
 */
export function consumeSchedule<Req = never>(
  builder: ScheduleBuilder,
  process: (event: ScheduleEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, ScheduleEventSource | Req>;
export function consumeSchedule<Req = never>(
  id: string,
  builder: ScheduleBuilder,
  process: (event: ScheduleEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, ScheduleEventSource | Req>;
export function consumeSchedule(...args: any[]) {
  const process = args[args.length - 1] as (
    event: ScheduleEvent,
  ) => Effect.Effect<void, never, never>;
  const head = args.slice(0, -1);
  const id = typeof head[0] === "string" ? (head[0] as string) : undefined;
  const builder = (id === undefined ? head[0] : head[1]) as ScheduleBuilder;
  return ScheduleEventSource.use((source) =>
    source(toScheduleDescriptor(id, builder.state), process),
  );
}

const toScheduleDescriptor = (
  id: string | undefined,
  state: ScheduleBuilderState,
): ScheduleDescriptor => ({
  id: id ?? state.name,
  expression: state.expression,
  props: {
    group: state.group,
    description: state.description,
    state: state.state,
    timezone: state.timezone,
    startDate: state.startDate,
    endDate: state.endDate,
    kmsKeyArn: state.kmsKeyArn,
    flexibleTimeWindow: state.flexibleTimeWindow,
    actionAfterCompletion: state.actionAfterCompletion,
  },
});

/**
 * Derive the stable route id for a schedule descriptor: the explicit id when
 * given, otherwise a hash of the expression and the host Function's logical
 * id. Computed identically at deploy time (to name the backing resources) and
 * at runtime (to match incoming events to the handler).
 */
export const createScheduleRouteId = (
  descriptor: ScheduleDescriptor,
  fn: LambdaFunction,
): string =>
  descriptor.id ??
  `Scheduler${createHash("sha1")
    .update(
      JSON.stringify({
        expression: descriptor.expression,
        host: fn.LogicalId,
      }),
    )
    .digest("hex")
    .slice(0, 10)}`;

/**
 * Deploy-time half of `consumeSchedule`: synthesize the execution role that
 * lets EventBridge Scheduler invoke the host Function and create the backing
 * `Schedule` whose `Input` template carries the typed event envelope.
 * @binding
 */
export const createScheduleRoute = (
  routeId: string,
  descriptor: ScheduleDescriptor,
  fn: LambdaFunction,
) =>
  Effect.gen(function* () {
    const props = descriptor.props ?? {};

    const role = yield* IAM.Role(`${routeId}Role`, {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        InvokeHost: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["lambda:InvokeFunction"],
              Resource: [fn.functionArn],
            },
          ],
        },
      },
    });

    return yield* Schedule(routeId, {
      groupName: props.group?.scheduleGroupName,
      scheduleExpression: descriptor.expression,
      description: props.description,
      scheduleExpressionTimezone: props.timezone,
      startDate: props.startDate,
      endDate: props.endDate,
      state: props.state,
      kmsKeyArn: props.kmsKeyArn,
      flexibleTimeWindow: props.flexibleTimeWindow ?? { Mode: "OFF" },
      actionAfterCompletion: props.actionAfterCompletion,
      target: {
        Arn: fn.functionArn as any,
        RoleArn: role.roleArn as any,
        // EventBridge Scheduler substitutes the <aws.scheduler.*> context
        // attributes into this template at invocation time; the resulting
        // JSON is the Lambda event payload matched by `isScheduleEvent`.
        Input: JSON.stringify({
          source: "alchemy.scheduler",
          scheduleId: routeId,
          scheduleArn: "<aws.scheduler.schedule-arn>",
          scheduledTime: "<aws.scheduler.scheduled-time>",
          executionId: "<aws.scheduler.execution-id>",
          attemptNumber: "<aws.scheduler.attempt-number>",
        }),
        RetryPolicy: props.retryPolicy,
        DeadLetterConfig: props.deadLetterConfig,
      },
    });
  });

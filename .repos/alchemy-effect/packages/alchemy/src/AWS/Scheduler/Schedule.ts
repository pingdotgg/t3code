import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import * as Schedule_ from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * EventBridge Scheduler validates that the target's execution role is
 * assumable by `scheduler.amazonaws.com`. A freshly-created IAM role can take
 * well over a minute to propagate, surfacing as a `ValidationException` with
 * the message "The execution role you provide must allow AWS EventBridge
 * Scheduler to assume the role." Retry (bounded) until propagation completes.
 */
const retryUntilRoleAssumable = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    while: (e) => {
      if (e._tag !== "ValidationException") return false;
      const message = (e as { Message?: unknown }).Message;
      return typeof message === "string" && message.includes("assume the role");
    },
    schedule: Schedule_.spaced("5 seconds"),
    times: 24,
  });

export interface ScheduleProps {
  /**
   * Schedule name. If omitted, Alchemy generates a deterministic name.
   */
  name?: string;
  /**
   * Optional schedule group. Defaults to the AWS default group.
   */
  groupName?: Input<string>;
  /**
   * Required schedule expression, such as `rate(5 minutes)` or `cron(...)`.
   */
  scheduleExpression: string;
  /**
   * Optional start date.
   */
  startDate?: Date;
  /**
   * Optional end date.
   */
  endDate?: Date;
  /**
   * Optional description.
   */
  description?: string;
  /**
   * Optional timezone for cron or at expressions.
   */
  scheduleExpressionTimezone?: string;
  /**
   * Desired schedule state.
   */
  state?: string;
  /**
   * Optional KMS key ARN.
   */
  kmsKeyArn?: Input<string>;
  /**
   * Scheduler target configuration.
   */
  target: Input<scheduler.Target>;
  /**
   * Flexible time window configuration.
   */
  flexibleTimeWindow?: Input<scheduler.FlexibleTimeWindow>;
  /**
   * Action after a one-time schedule completes.
   */
  actionAfterCompletion?: string;
}

/**
 * An EventBridge Scheduler schedule.
 *
 * `Schedule` is the canonical time-based delivery primitive. High-level helpers
 * like `every`, `cron`, and `at` can synthesize the target role and scheduler
 * target configuration on top of this resource.
 * @resource
 * @section Creating Schedules
 * @example Hourly Schedule
 * ```typescript
 * const schedule = yield* Schedule("HourlyJob", {
 *   scheduleExpression: "rate(1 hour)",
 *   target: {
 *     Arn: fn.functionArn,
 *     RoleArn: role.roleArn,
 *   },
 *   flexibleTimeWindow: {
 *     Mode: "OFF",
 *   },
 * });
 * ```
 */
export interface Schedule extends Resource<
  "AWS.Scheduler.Schedule",
  ScheduleProps,
  {
    /**
     * ARN of the schedule.
     */
    scheduleArn: string;
    /**
     * Name of the schedule.
     */
    scheduleName: string;
    /**
     * Name of the schedule group containing the schedule.
     */
    groupName: string;
    /**
     * Current state of the schedule (`ENABLED` or `DISABLED`).
     */
    state: string | undefined;
  },
  never,
  Providers
> {}

export const Schedule = Resource<Schedule>("AWS.Scheduler.Schedule");

export const ScheduleProvider = () =>
  Provider.effect(
    Schedule,
    Effect.gen(function* () {
      const toName = (id: string, props: ScheduleProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      return {
        stables: ["scheduleArn", "scheduleName", "groupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }

          if ((olds.groupName ?? "default") !== (news.groupName ?? "default")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const scheduleName =
            output?.scheduleName ?? (yield* toName(id, olds));
          const groupName =
            output?.groupName ??
            (olds.groupName as string | undefined) ??
            "default";
          const described = yield* scheduler
            .getSchedule({
              Name: scheduleName,
              GroupName: groupName !== "default" ? groupName : undefined,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Arn || !described.Name) {
            return undefined;
          }

          return {
            scheduleArn: described.Arn,
            scheduleName: described.Name,
            groupName: described.GroupName ?? groupName,
            state: described.State,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const scheduleName =
            output?.scheduleName ?? (yield* toName(id, news));
          const groupName =
            output?.groupName ??
            (news.groupName as string | undefined) ??
            "default";
          const groupNameParam =
            groupName !== "default" ? groupName : undefined;

          const desiredConfig = {
            ScheduleExpression: news.scheduleExpression,
            StartDate: news.startDate,
            EndDate: news.endDate,
            Description: news.description,
            ScheduleExpressionTimezone: news.scheduleExpressionTimezone,
            State: news.state,
            KmsKeyArn: news.kmsKeyArn as string | undefined,
            Target: news.target as scheduler.Target,
            FlexibleTimeWindow: (news.flexibleTimeWindow as
              | scheduler.FlexibleTimeWindow
              | undefined) ?? {
              Mode: "OFF" as const,
            },
            ActionAfterCompletion: news.actionAfterCompletion,
          };

          // Observe — fetch live schedule.
          let observed = yield* scheduler
            .getSchedule({ Name: scheduleName, GroupName: groupNameParam })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create if missing. EventBridge Scheduler does not support
          // tagging individual schedules (only schedule groups), so ownership
          // can't be branded/verified via tags. A `ConflictException` means a
          // schedule with this deterministic name already exists; fall through
          // to the sync (`updateSchedule`) path to converge it.
          if (!observed?.Arn) {
            yield* scheduler
              .createSchedule({
                Name: scheduleName,
                GroupName: groupNameParam,
                ...desiredConfig,
              })
              .pipe(
                retryUntilRoleAssumable,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            observed = yield* scheduler
              .getSchedule({ Name: scheduleName, GroupName: groupNameParam })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
          }

          if (!observed?.Arn) {
            return yield* Effect.fail(
              new Error(`Failed to read created Schedule '${scheduleName}'`),
            );
          }

          const scheduleArn = observed.Arn;

          // Sync schedule configuration. Scheduler doesn't support a partial
          // update — `updateSchedule` is a full PUT — so we always send the
          // full desired config. Fields like `state` are reflected in
          // `observed.State`; sending a no-op update is cheap.
          yield* scheduler
            .updateSchedule({
              Name: scheduleName,
              GroupName: groupNameParam,
              ...desiredConfig,
            })
            .pipe(retryUntilRoleAssumable);

          yield* session.note(scheduleArn);

          return {
            scheduleArn,
            scheduleName,
            groupName,
            state: news.state ?? observed.State,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            // Enumerate every schedule in the account/region. Omitting
            // GroupName makes ListSchedules return summaries across all
            // schedule groups, paginated.
            const summaries = yield* scheduler.listSchedules.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Schedules ?? []).filter(
                    (s): s is scheduler.ScheduleSummary & { Name: string } =>
                      s.Name != null,
                  ),
                ),
              ),
            );

            // Hydrate each summary via GetSchedule into the exact `read`
            // shape. Skip schedules deleted between list and get.
            const rows = yield* Effect.forEach(
              summaries,
              (summary) => {
                const groupName = summary.GroupName ?? "default";
                return scheduler
                  .getSchedule({
                    Name: summary.Name,
                    GroupName: groupName !== "default" ? groupName : undefined,
                  })
                  .pipe(
                    Effect.map((described) =>
                      described.Arn && described.Name
                        ? {
                            scheduleArn: described.Arn,
                            scheduleName: described.Name,
                            groupName: described.GroupName ?? groupName,
                            state: described.State,
                          }
                        : undefined,
                    ),
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  );
              },
              { concurrency: 10 },
            );

            return rows.filter(
              (row): row is Schedule["Attributes"] => row !== undefined,
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* scheduler
            .deleteSchedule({
              Name: output.scheduleName,
              GroupName:
                output.groupName !== "default" ? output.groupName : undefined,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";

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
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

/**
 * An EventBridge Scheduler schedule.
 *
 * `Schedule` is the canonical time-based delivery primitive. High-level helpers
 * like `every`, `cron`, and `at` can synthesize the target role and scheduler
 * target configuration on top of this resource.
 *
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
    scheduleArn: string;
    scheduleName: string;
    groupName: string;
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
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

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

          // Ensure — create if missing. On `ConflictException` (race or
          // adoption), verify ownership via internal tags then fall through
          // to the sync path.
          if (!observed?.Arn) {
            yield* scheduler
              .createSchedule({
                Name: scheduleName,
                GroupName: groupNameParam,
                ...desiredConfig,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  scheduler
                    .getSchedule({
                      Name: scheduleName,
                      GroupName: groupNameParam,
                    })
                    .pipe(
                      Effect.flatMap((existing) =>
                        existing.Arn
                          ? scheduler
                              .listTagsForResource({
                                ResourceArn: existing.Arn,
                              })
                              .pipe(
                                Effect.filterOrFail(
                                  ({ Tags }) => hasTags(internalTags, Tags),
                                  () =>
                                    new Error(
                                      `Schedule '${scheduleName}' already exists and is not managed by alchemy`,
                                    ),
                                ),
                                Effect.asVoid,
                              )
                          : Effect.fail(
                              new Error(
                                `Schedule '${scheduleName}' already exists but could not be described`,
                              ),
                            ),
                      ),
                    ),
                ),
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
          yield* scheduler.updateSchedule({
            Name: scheduleName,
            GroupName: groupNameParam,
            ...desiredConfig,
          });

          // Sync tags — diff observed cloud tags against desired so that
          // adoption rewrites ownership tags correctly.
          const observedTagsResp = yield* scheduler
            .listTagsForResource({ ResourceArn: scheduleArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({ Tags: [] as scheduler.Tag[] }),
              ),
            );
          const observedTags = Object.fromEntries(
            (observedTagsResp.Tags ?? []).map((t) => [t.Key, t.Value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (removed.length > 0) {
            yield* scheduler.untagResource({
              ResourceArn: scheduleArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* scheduler.tagResource({
              ResourceArn: scheduleArn,
              Tags: upsert,
            });
          }

          yield* session.note(scheduleArn);

          return {
            scheduleArn,
            scheduleName,
            groupName,
            state: news.state ?? observed.State,
          };
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

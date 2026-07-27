import * as databrew from "@distilled.cloud/aws/databrew";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  cleanMap,
  databrewArn,
  fetchObservedTags,
  retryWhileConflict,
  syncTags,
} from "./internal.ts";

export interface ScheduleProps {
  /**
   * Name of the schedule. If omitted, a unique name is generated. Changing
   * the name replaces the schedule.
   * @default a generated physical name
   */
  scheduleName?: string;
  /**
   * The cron expression (in AWS cron format, evaluated in UTC) that
   * determines when the associated jobs run, e.g.
   * `cron(0 12 * * ? *)` for every day at noon UTC.
   */
  cronExpression: string;
  /**
   * Names of the DataBrew jobs the schedule starts.
   */
  jobNames?: string[];
  /**
   * Tags to apply to the schedule. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Schedule extends Resource<
  "AWS.DataBrew.Schedule",
  ScheduleProps,
  {
    /** Name of the schedule. */
    scheduleName: string;
    /** ARN of the schedule. */
    scheduleArn: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Glue DataBrew schedule — a cron expression that starts one or more
 * DataBrew jobs at recurring times. The schedule definition is free; only
 * the job runs it triggers are billed.
 * @resource
 * @section Creating Schedules
 * @example Nightly Job Schedule
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const schedule = yield* AWS.DataBrew.Schedule("Nightly", {
 *   cronExpression: "cron(0 3 * * ? *)",
 *   jobNames: [job.jobName],
 * });
 * ```
 *
 * @example Schedule Without Jobs (attach later)
 * ```typescript
 * const schedule = yield* AWS.DataBrew.Schedule("Standing", {
 *   cronExpression: "cron(0 12 ? * MON-FRI *)",
 * });
 * ```
 */
export const Schedule = Resource<Schedule>("AWS.DataBrew.Schedule");

export const ScheduleProvider = () =>
  Provider.effect(
    Schedule,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { scheduleName?: string | undefined },
      ) {
        return (
          props.scheduleName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      const observe = Effect.fn(function* (name: string) {
        return yield* databrew
          .describeSchedule({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Schedule.Provider.of({
        stables: ["scheduleName", "scheduleArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* databrew.listSchedules
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.Schedules ?? [])
              .map((s) => ({
                scheduleName: s.Name,
                scheduleArn:
                  s.ResourceArn ??
                  databrewArn(region, accountId, "schedule", s.Name),
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.scheduleName ?? (yield* createName(id, olds ?? {}));
          const schedule = yield* observe(name);
          if (schedule === undefined) return undefined;
          const arn =
            schedule.ResourceArn ??
            databrewArn(region, accountId, "schedule", name);
          const attrs = { scheduleName: name, scheduleArn: arn };
          const tags = cleanMap(schedule.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          // cronExpression and jobNames are UpdateSchedule-able
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.scheduleName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          const schedule = yield* observe(name);

          // 2. ENSURE / 3. SYNC — UpdateSchedule is a full PUT
          if (schedule === undefined) {
            yield* databrew
              .createSchedule({
                Name: name,
                CronExpression: news.cronExpression,
                JobNames: news.jobNames,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
          } else if (
            schedule.CronExpression !== news.cronExpression ||
            JSON.stringify(schedule.JobNames ?? []) !==
              JSON.stringify(news.jobNames ?? [])
          ) {
            yield* databrew.updateSchedule({
              Name: name,
              CronExpression: news.cronExpression,
              JobNames: news.jobNames,
            });
          }

          const arn =
            schedule?.ResourceArn ??
            databrewArn(region, accountId, "schedule", name);

          // 3b. SYNC TAGS against observed cloud tags
          const observedTags = yield* fetchObservedTags(arn);
          yield* syncTags(arn, observedTags, desiredTags);

          yield* session.note(name);
          return { scheduleName: name, scheduleArn: arn };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            databrew.deleteSchedule({ Name: output.scheduleName }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        }),
      });
    }),
  );

import * as datasync from "@distilled.cloud/aws/datasync";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readObservedTags, syncTags } from "./internal.ts";

export interface TaskProps {
  /**
   * ARN of the source location data is transferred from. Cannot be changed
   * after creation (replacement).
   */
  sourceLocationArn: string;
  /**
   * ARN of the destination location data is transferred to. Cannot be
   * changed after creation (replacement).
   */
  destinationLocationArn: string;
  /**
   * Name of the task. If omitted, a unique name is generated from the app,
   * stage, and logical id.
   */
  name?: string;
  /**
   * Transfer options — verification mode, overwrite behaviour, metadata
   * preservation, bandwidth throttle, logging, etc. Updatable in place.
   */
  options?: datasync.Options;
  /**
   * Filter rules excluding files/folders from the transfer. Updatable in
   * place.
   */
  excludes?: datasync.FilterRule[];
  /**
   * Filter rules including only matching files/folders. Updatable in place.
   */
  includes?: datasync.FilterRule[];
  /**
   * Schedule on which the task runs automatically (cron expression).
   * Updatable in place.
   */
  schedule?: datasync.TaskSchedule;
  /**
   * ARN of the CloudWatch log group DataSync publishes task logs to.
   * Updatable in place.
   */
  cloudWatchLogGroupArn?: string;
  /**
   * Task execution mode. `BASIC` (default) or `ENHANCED` (higher scale,
   * S3-only). Cannot be changed after creation (replacement).
   */
  taskMode?: datasync.TaskMode;
  /**
   * Tags to apply to the task. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Task extends Resource<
  "AWS.DataSync.Task",
  TaskProps,
  {
    /** ARN of the DataSync task. */
    taskArn: string;
    /** Current task status (e.g. `AVAILABLE`, `RUNNING`). */
    taskStatus: datasync.TaskStatus;
    /** ARN of the source location. */
    sourceLocationArn: string;
    /** ARN of the destination location. */
    destinationLocationArn: string;
  },
  {},
  Providers
> {}

/**
 * A DataSync task — the transfer definition binding a source location to a
 * destination location, together with the filters, schedule, and transfer
 * options that govern each run.
 *
 * Creating the task does not move any data; it defines the transfer.
 * Start a run with `StartTaskExecution` (or attach a `schedule`). Source and
 * destination locations and the task mode are immutable; everything else
 * (name, options, filters, schedule, log group, tags) is updated in place.
 *
 * @resource
 * @section Creating Tasks
 * @example S3 → S3 transfer
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const task = yield* AWS.DataSync.Task("Backup", {
 *   sourceLocationArn: source.locationArn,
 *   destinationLocationArn: dest.locationArn,
 * });
 * ```
 *
 * @example With verification and a schedule
 * ```typescript
 * const task = yield* AWS.DataSync.Task("Nightly", {
 *   sourceLocationArn: source.locationArn,
 *   destinationLocationArn: dest.locationArn,
 *   options: { VerifyMode: "ONLY_FILES_TRANSFERRED" },
 *   schedule: { ScheduleExpression: "cron(0 2 * * ? *)" },
 * });
 * ```
 */
export const Task = Resource<Task>("AWS.DataSync.Task");

const canonical = (value: unknown): string => JSON.stringify(value ?? null);

export const TaskProvider = () =>
  Provider.effect(
    Task,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: TaskProps) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const describe = Effect.fn(function* (taskArn: string) {
        return yield* datasync
          .describeTask({ TaskArn: taskArn })
          .pipe(
            Effect.catchTag("TaskNotFound", () => Effect.succeed(undefined)),
          );
      });

      const findByName = Effect.fn(function* (name: string) {
        const tasks = yield* datasync.listTasks.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((p) => p.Tasks ?? []),
          ),
        );
        return tasks.find((t) => t.Name === name)?.TaskArn;
      });

      const attrsOf = (t: datasync.DescribeTaskResponse) => ({
        taskArn: t.TaskArn!,
        taskStatus: t.Status ?? "AVAILABLE",
        sourceLocationArn: t.SourceLocationArn!,
        destinationLocationArn: t.DestinationLocationArn!,
      });

      return Task.Provider.of({
        stables: ["taskArn", "sourceLocationArn", "destinationLocationArn"],

        list: () =>
          Effect.gen(function* () {
            const tasks = yield* datasync.listTasks.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((p) => p.Tasks ?? []),
              ),
            );
            return yield* Effect.forEach(tasks, (t) =>
              Effect.gen(function* () {
                const full = yield* describe(t.TaskArn!);
                return full ? attrsOf(full) : undefined;
              }),
            ).pipe(
              Effect.map((items) =>
                items.filter(
                  (i): i is ReturnType<typeof attrsOf> => i !== undefined,
                ),
              ),
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const arn =
            output?.taskArn ?? (yield* findByName(yield* createName(id, olds)));
          if (arn === undefined) return undefined;
          const t = yield* describe(arn);
          return t === undefined ? undefined : attrsOf(t);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const replaced =
            news.sourceLocationArn !== olds.sourceLocationArn ||
            news.destinationLocationArn !== olds.destinationLocationArn ||
            (news.taskMode ?? "BASIC") !== (olds.taskMode ?? "BASIC");
          if (replaced) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const name = yield* createName(id, news);

          // 1. OBSERVE — output cache, else re-discover by deterministic name.
          let arn = output?.taskArn ?? (yield* findByName(name));
          let t = arn ? yield* describe(arn) : undefined;

          // 2. ENSURE — create if missing.
          if (t === undefined) {
            const created = yield* datasync.createTask({
              SourceLocationArn: news.sourceLocationArn,
              DestinationLocationArn: news.destinationLocationArn,
              Name: name,
              Options: news.options,
              Excludes: news.excludes,
              Includes: news.includes,
              Schedule: news.schedule,
              CloudWatchLogGroupArn: news.cloudWatchLogGroupArn,
              TaskMode: news.taskMode,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            arn = created.TaskArn!;
            t = yield* describe(arn);
          } else {
            // 3a. SYNC updatable fields — only on a real delta.
            const changed =
              t.Name !== name ||
              (t.CloudWatchLogGroupArn ?? "") !==
                (news.cloudWatchLogGroupArn ?? "") ||
              canonical(t.Options) !== canonical(news.options) ||
              canonical(t.Excludes) !== canonical(news.excludes) ||
              canonical(t.Includes) !== canonical(news.includes) ||
              canonical(t.Schedule) !== canonical(news.schedule);
            if (changed) {
              yield* datasync.updateTask({
                TaskArn: arn!,
                Name: name,
                Options: news.options,
                Excludes: news.excludes,
                Includes: news.includes,
                Schedule: news.schedule,
                CloudWatchLogGroupArn: news.cloudWatchLogGroupArn,
              });
              t = yield* describe(arn!);
            }
          }

          // 3b. SYNC tags against observed cloud state.
          const observed = yield* readObservedTags(arn!);
          yield* syncTags(arn!, observed, desiredTags);

          yield* session.note(arn!);
          return attrsOf(t!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* datasync
            .deleteTask({ TaskArn: output.taskArn })
            .pipe(Effect.catchTag("TaskNotFound", () => Effect.void));
        }),
      });
    }),
  );

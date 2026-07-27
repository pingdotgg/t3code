import * as glue from "@distilled.cloud/aws/glue";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireMinutes } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fetchObservedTags,
  jobArn,
  retryWhileRoleNotAssumable,
  syncTags,
} from "./internal.ts";

export interface JobCommand {
  /**
   * The command name: `glueetl` (Spark), `pythonshell` (Python shell), or
   * `gluestreaming` (Spark streaming).
   */
  name: "glueetl" | "pythonshell" | "gluestreaming" | (string & {});
  /** The S3 path to the job script, e.g. `s3://my-bucket/scripts/job.py`. */
  scriptLocation?: string;
  /** For `pythonshell`, the Python version (`3` or `3.9`). */
  pythonVersion?: string;
  /** The Ray runtime version (for Ray jobs). */
  runtime?: string;
}

export interface JobProps {
  /**
   * Name of the job. If omitted, a unique name is generated. Changing the
   * name replaces the job.
   * @default a generated physical name
   */
  jobName?: string;
  /**
   * The IAM role (ARN or name) the job assumes to run.
   */
  role: string;
  /**
   * The job's execution command (script location + runtime).
   */
  command: JobCommand;
  /**
   * A description of the job.
   */
  description?: string;
  /**
   * Default arguments passed to the script (keys are `--`-prefixed), e.g.
   * `{ "--TempDir": "s3://.../tmp/", "--job-language": "python" }`.
   */
  defaultArguments?: Record<string, string>;
  /**
   * Arguments that cannot be overridden at run time.
   */
  nonOverridableArguments?: Record<string, string>;
  /**
   * Glue connection names the job uses.
   */
  connections?: string[];
  /**
   * Max retries before the job run is considered failed.
   */
  maxRetries?: number;
  /**
   * Job timeout, e.g. `"1 hour"` or `Duration.minutes(60)`. Rounded to
   * whole minutes on the wire (the Glue API unit).
   */
  timeout?: Duration.Input;
  /**
   * Max Glue data processing units (DPUs) for `pythonshell` (0.0625 or 1).
   * Mutually exclusive with `numberOfWorkers`/`workerType`.
   */
  maxCapacity?: number;
  /**
   * The Glue version (e.g. `4.0`, `3.0`).
   */
  glueVersion?: string;
  /**
   * The number of workers of `workerType` allocated (Spark jobs).
   */
  numberOfWorkers?: number;
  /**
   * The worker type for Spark jobs: `Standard`, `G.1X`, `G.2X`, `G.025X`,
   * `G.4X`, `G.8X`, `Z.2X`.
   */
  workerType?: string;
  /**
   * Execution class: `STANDARD` or `FLEX`.
   */
  executionClass?: "STANDARD" | "FLEX";
  /**
   * Concurrency configuration.
   */
  executionProperty?: {
    /** Maximum number of concurrent runs allowed. */
    maxConcurrentRuns?: number;
  };
  /**
   * Tags to apply to the job. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Job extends Resource<
  "AWS.Glue.Job",
  JobProps,
  {
    /** The name of the job. */
    jobName: string;
    /** The ARN of the job. */
    jobArn: string;
    /** The IAM role the job assumes to run. */
    role: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Glue job — a Spark (`glueetl`), Python shell (`pythonshell`), or
 * streaming ETL job definition (script in S3 + IAM role + arguments). The
 * definition lifecycle is instant and free; job *runs* are billed and are
 * started via `startJobRun`.
 * @resource
 * @section Creating Jobs
 * @example Python Shell Job
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const job = yield* AWS.Glue.Job("Etl", {
 *   role: jobRole.roleArn,
 *   command: {
 *     name: "pythonshell",
 *     pythonVersion: "3.9",
 *     scriptLocation: "s3://my-bucket/scripts/etl.py",
 *   },
 *   maxCapacity: 0.0625,
 *   glueVersion: "3.0",
 *   defaultArguments: { "--job-language": "python" },
 * });
 * ```
 *
 * @example Spark ETL Job
 * ```typescript
 * const job = yield* AWS.Glue.Job("SparkEtl", {
 *   role: jobRole.roleArn,
 *   command: {
 *     name: "glueetl",
 *     scriptLocation: "s3://my-bucket/scripts/spark.py",
 *   },
 *   glueVersion: "4.0",
 *   workerType: "G.1X",
 *   numberOfWorkers: 2,
 *   timeout: "1 hour",
 * });
 * ```
 *
 * @section Running Jobs
 * @example Start a Job Run from a Lambda
 * ```typescript
 * // init
 * const startJobRun = yield* AWS.Glue.StartJobRun(job);
 *
 * // runtime
 * const { JobRunId } = yield* startJobRun({});
 * ```
 */
export const Job = Resource<Job>("AWS.Glue.Job");

export const JobProvider = () =>
  Provider.effect(
    Job,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { jobName?: string | undefined },
      ) {
        return (
          props.jobName ?? (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      const observe = Effect.fn(function* (name: string) {
        return yield* glue.getJob({ JobName: name }).pipe(
          Effect.map((r) => r.Job),
          Effect.catchTag("EntityNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const buildCommand = (command: JobCommand) => ({
        Name: command.name,
        ScriptLocation: command.scriptLocation,
        PythonVersion: command.pythonVersion,
        Runtime: command.runtime,
      });

      const buildDefinition = (props: JobProps) => ({
        Role: props.role,
        Command: buildCommand(props.command),
        Description: props.description,
        DefaultArguments: props.defaultArguments,
        NonOverridableArguments: props.nonOverridableArguments,
        Connections:
          props.connections !== undefined
            ? { Connections: props.connections }
            : undefined,
        MaxRetries: props.maxRetries,
        Timeout: toWireMinutes(props.timeout),
        MaxCapacity: props.maxCapacity,
        GlueVersion: props.glueVersion,
        NumberOfWorkers: props.numberOfWorkers,
        WorkerType: props.workerType,
        ExecutionClass: props.executionClass,
        ExecutionProperty: props.executionProperty
          ? { MaxConcurrentRuns: props.executionProperty.maxConcurrentRuns }
          : undefined,
      });

      return Job.Provider.of({
        stables: ["jobName", "jobArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* glue.getJobs.pages({}).pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.Jobs ?? [])
              .filter((j) => j.Name !== undefined)
              .map((j) => ({
                jobName: j.Name!,
                jobArn: jobArn(region, accountId, j.Name!),
                role: j.Role ?? "",
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.jobName ?? (yield* createName(id, olds ?? {}));
          const job = yield* observe(name);
          if (job?.Name === undefined) return undefined;
          const arn = jobArn(region, accountId, job.Name);
          const attrs = {
            jobName: job.Name,
            jobArn: arn,
            role: job.Role ?? "",
          };
          const tags = yield* fetchObservedTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          // everything else is UpdateJob-able
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.jobName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const arn = jobArn(region, accountId, name);

          // 1. OBSERVE
          let job = yield* observe(name);

          // 2. ENSURE / 3. SYNC
          if (job === undefined) {
            yield* retryWhileRoleNotAssumable(
              glue.createJob({
                Name: name,
                ...buildDefinition(news),
                Tags: desiredTags,
              }),
            ).pipe(
              Effect.catchTag("AlreadyExistsException", () => Effect.void),
            );
          } else {
            // UpdateJob replaces the full JobUpdate (Name is not part of it).
            yield* retryWhileRoleNotAssumable(
              glue.updateJob({
                JobName: name,
                JobUpdate: buildDefinition(news),
              }),
            );
          }

          // 3b. SYNC TAGS
          const observedTags = yield* fetchObservedTags(arn);
          yield* syncTags(arn, observedTags, desiredTags);

          job = yield* observe(name);

          yield* session.note(name);
          return {
            jobName: name,
            jobArn: arn,
            role: job?.Role ?? news.role,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteJob is idempotent — the API returns success (not an error)
          // when the job definition is already gone.
          yield* glue.deleteJob({ JobName: output.jobName });
        }),
      });
    }),
  );

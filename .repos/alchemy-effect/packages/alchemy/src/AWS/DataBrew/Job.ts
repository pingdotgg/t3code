import * as databrew from "@distilled.cloud/aws/databrew";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
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
import { buildS3Location, type S3Location } from "./Dataset.ts";
import {
  cleanMap,
  databrewArn,
  fetchObservedTags,
  retryWhileConflict,
  retryWhileRoleNotAssumable,
  syncTags,
} from "./internal.ts";

/** An S3 output target for a recipe job. */
export interface JobOutput {
  /** The S3 location the transformed data is written to. */
  location: S3Location;
  /** The output file format. @default "CSV" */
  format?:
    | "CSV"
    | "JSON"
    | "PARQUET"
    | "GLUEPARQUET"
    | "AVRO"
    | "ORC"
    | "XML"
    | "TABLEAUHYPER"
    | (string & {});
  /** Compression applied to the output files. */
  compressionFormat?:
    | "GZIP"
    | "LZ4"
    | "SNAPPY"
    | "BZIP2"
    | "DEFLATE"
    | "LZO"
    | "BROTLI"
    | "ZSTD"
    | "ZLIB"
    | (string & {});
  /** Columns to partition the output by. */
  partitionColumns?: string[];
  /** Overwrite previous output files on each run. @default false */
  overwrite?: boolean;
  /** Format-specific output options. */
  formatOptions?: {
    /** CSV output options. */
    csv?: {
      /** The single-character field delimiter. @default "," */
      delimiter?: string;
    };
  };
  /** Maximum number of output files. */
  maxOutputFiles?: number;
}

/** A pointer to the recipe (and version) a recipe job applies. */
export interface JobRecipeReference {
  /** The recipe name. */
  name: string;
  /**
   * The recipe version to run.
   * @default "LATEST_PUBLISHED"
   */
  recipeVersion?: string;
}

/** How much of the dataset a profile job analyzes. */
export interface JobSample {
  /** `FULL_DATASET` or `CUSTOM_ROWS`. @default "CUSTOM_ROWS" */
  mode?: "FULL_DATASET" | "CUSTOM_ROWS" | (string & {});
  /** Row count when mode is `CUSTOM_ROWS`. @default 20000 */
  size?: number;
}

/** Selects columns by exact name or regex. */
export interface ColumnSelector {
  /** A regular expression matching column names. */
  regex?: string;
  /** An exact column name. */
  name?: string;
}

/** Which statistics a profile job computes. */
export interface StatisticsConfiguration {
  /** Statistics to include (default: all supported). */
  includedStatistics?: string[];
  /** Per-statistic parameter overrides. */
  overrides?: {
    /** The statistic name. */
    statistic: string;
    /** Statistic parameters. */
    parameters: Record<string, string>;
  }[];
}

/** Fine-grained configuration for a profile job. */
export interface ProfileJobConfiguration {
  /** Dataset-level statistics configuration. */
  datasetStatisticsConfiguration?: StatisticsConfiguration;
  /** Restrict profiling to these columns. */
  profileColumns?: ColumnSelector[];
  /** Column-level statistics configurations. */
  columnStatisticsConfigurations?: {
    /** The columns the configuration applies to (default: all). */
    selectors?: ColumnSelector[];
    /** The statistics to compute for those columns. */
    statistics: StatisticsConfiguration;
  }[];
  /** PII entity detection configuration. */
  entityDetectorConfiguration?: {
    /** Entity types to detect, e.g. `["USA_SSN", "EMAIL"]`. */
    entityTypes: string[];
    /** Statistics allowed on detected-entity columns. */
    allowedStatistics?: {
      /** The allowed statistic names. */
      statistics: string[];
    }[];
  };
}

/** Attaches a ruleset to a profile job for data-quality validation. */
export interface ValidationConfiguration {
  /** The ARN of the ruleset to validate against. */
  rulesetArn: string;
  /** The validation mode. @default "CHECK_ALL" */
  validationMode?: "CHECK_ALL" | (string & {});
}

export interface JobProps {
  /**
   * Name of the job. If omitted, a unique name is generated. Changing the
   * name replaces the job.
   * @default a generated physical name
   */
  jobName?: string;
  /**
   * The job type: `PROFILE` analyzes a dataset and writes a data profile;
   * `RECIPE` applies a recipe's transformations and writes the output.
   * Changing the type replaces the job.
   */
  type: "PROFILE" | "RECIPE";
  /**
   * The dataset the job reads. Required for `PROFILE` jobs; for `RECIPE`
   * jobs provide either `datasetName` + `recipeReference` or `projectName`.
   * Changing it replaces the job.
   */
  datasetName?: string;
  /**
   * The IAM role ARN DataBrew assumes to run the job (read the input,
   * write the output).
   */
  role: string;
  /**
   * S3 location the profile results are written to (PROFILE jobs only).
   */
  outputLocation?: S3Location;
  /**
   * Fine-grained profiling configuration (PROFILE jobs only).
   */
  configuration?: ProfileJobConfiguration;
  /**
   * Rulesets to validate the data against (PROFILE jobs only).
   */
  validationConfigurations?: ValidationConfiguration[];
  /**
   * How much of the dataset to profile (PROFILE jobs only).
   * @default 20,000 rows
   */
  jobSample?: JobSample;
  /**
   * S3 outputs the transformed data is written to (RECIPE jobs only).
   */
  outputs?: JobOutput[];
  /**
   * The recipe to apply (RECIPE jobs only). Defaults to the recipe's latest
   * *published* version. Changing it replaces the job.
   */
  recipeReference?: JobRecipeReference;
  /**
   * Derive dataset + recipe from an existing DataBrew project instead of
   * `datasetName`/`recipeReference` (RECIPE jobs only). Changing it
   * replaces the job.
   */
  projectName?: string;
  /**
   * The encryption mode for job output: `SSE-KMS` or `SSE-S3`.
   */
  encryptionMode?: "SSE-KMS" | "SSE-S3";
  /**
   * The KMS key ARN when `encryptionMode` is `SSE-KMS`.
   */
  encryptionKeyArn?: string;
  /**
   * Enable CloudWatch logging for the job.
   * @default "ENABLE"
   */
  logSubscription?: "ENABLE" | "DISABLE";
  /**
   * Maximum number of compute nodes the job can consume.
   * @default 5
   */
  maxCapacity?: number;
  /**
   * Maximum retries after a job run fails.
   * @default 0
   */
  maxRetries?: number;
  /**
   * Job timeout, e.g. `"90 minutes"` or `Duration.hours(2)`. DataBrew
   * measures the timeout in whole minutes.
   * @default "48 hours"
   */
  timeout?: Duration.Input;
  /**
   * Tags to apply to the job. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Job extends Resource<
  "AWS.DataBrew.Job",
  JobProps,
  {
    /** Name of the job. */
    jobName: string;
    /** ARN of the job. */
    jobArn: string;
    /** Type of the job (`PROFILE` or `RECIPE`). */
    type: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Glue DataBrew job definition — either a `PROFILE` job that analyzes
 * a dataset and writes a data-quality profile to S3, or a `RECIPE` job that
 * applies a published recipe's transformations and writes the result to S3.
 * The definition is free and instant; job *runs* are billed per node-hour
 * and are started with `StartJobRun`.
 * @resource
 * @section Profile Jobs
 * @example Profile a Dataset
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const profile = yield* AWS.DataBrew.Job("Profile", {
 *   type: "PROFILE",
 *   datasetName: dataset.datasetName,
 *   role: role.roleArn,
 *   outputLocation: { bucket: bucket.bucketName, key: "profiles/" },
 *   jobSample: { mode: "CUSTOM_ROWS", size: 1000 },
 * });
 * ```
 *
 * @section Recipe Jobs
 * @example Transform with a Published Recipe
 * ```typescript
 * const transform = yield* AWS.DataBrew.Job("Transform", {
 *   type: "RECIPE",
 *   datasetName: dataset.datasetName,
 *   recipeReference: { name: recipe.recipeName },
 *   role: role.roleArn,
 *   outputs: [
 *     {
 *       location: { bucket: bucket.bucketName, key: "curated/" },
 *       format: "CSV",
 *       overwrite: true,
 *     },
 *   ],
 * });
 * ```
 */
export const Job = Resource<Job>("AWS.DataBrew.Job");

/** The job's props don't satisfy the requirements of its `type`. */
export class DataBrewJobConfigError extends Data.TaggedError(
  "DataBrewJobConfigError",
)<{ message: string }> {}

const validate = (props: JobProps) => {
  if (props.type === "PROFILE") {
    if (props.datasetName === undefined || props.outputLocation === undefined) {
      return Effect.fail(
        new DataBrewJobConfigError({
          message: "PROFILE jobs require `datasetName` and `outputLocation`.",
        }),
      );
    }
    if (props.outputs !== undefined || props.recipeReference !== undefined) {
      return Effect.fail(
        new DataBrewJobConfigError({
          message: "`outputs`/`recipeReference` only apply to RECIPE jobs.",
        }),
      );
    }
  } else {
    const viaProject = props.projectName !== undefined;
    const viaRecipe =
      props.datasetName !== undefined && props.recipeReference !== undefined;
    if (!viaProject && !viaRecipe) {
      return Effect.fail(
        new DataBrewJobConfigError({
          message:
            "RECIPE jobs require either `projectName` or `datasetName` + `recipeReference`.",
        }),
      );
    }
    if (props.outputs === undefined || props.outputs.length === 0) {
      return Effect.fail(
        new DataBrewJobConfigError({
          message: "RECIPE jobs require at least one entry in `outputs`.",
        }),
      );
    }
    if (
      props.outputLocation !== undefined ||
      props.configuration !== undefined ||
      props.jobSample !== undefined ||
      props.validationConfigurations !== undefined
    ) {
      return Effect.fail(
        new DataBrewJobConfigError({
          message:
            "`outputLocation`/`configuration`/`jobSample`/`validationConfigurations` only apply to PROFILE jobs.",
        }),
      );
    }
  }
  return Effect.void;
};

const buildOutputs = (outputs: JobOutput[] | undefined) =>
  outputs?.map((output) => ({
    Location: buildS3Location(output.location),
    Format: output.format,
    CompressionFormat: output.compressionFormat,
    PartitionColumns: output.partitionColumns,
    Overwrite: output.overwrite,
    FormatOptions: output.formatOptions
      ? {
          Csv: output.formatOptions.csv
            ? { Delimiter: output.formatOptions.csv.delimiter }
            : undefined,
        }
      : undefined,
    MaxOutputFiles: output.maxOutputFiles,
  }));

const buildStatisticsConfiguration = (config: StatisticsConfiguration) => ({
  IncludedStatistics: config.includedStatistics,
  Overrides: config.overrides?.map((o) => ({
    Statistic: o.statistic,
    Parameters: o.parameters,
  })),
});

const buildColumnSelectors = (selectors: ColumnSelector[] | undefined) =>
  selectors?.map((s) => ({ Regex: s.regex, Name: s.name }));

const buildConfiguration = (config: ProfileJobConfiguration | undefined) =>
  config
    ? {
        DatasetStatisticsConfiguration: config.datasetStatisticsConfiguration
          ? buildStatisticsConfiguration(config.datasetStatisticsConfiguration)
          : undefined,
        ProfileColumns: buildColumnSelectors(config.profileColumns),
        ColumnStatisticsConfigurations:
          config.columnStatisticsConfigurations?.map((c) => ({
            Selectors: buildColumnSelectors(c.selectors),
            Statistics: buildStatisticsConfiguration(c.statistics),
          })),
        EntityDetectorConfiguration: config.entityDetectorConfiguration
          ? {
              EntityTypes: config.entityDetectorConfiguration.entityTypes,
              AllowedStatistics:
                config.entityDetectorConfiguration.allowedStatistics?.map(
                  (a) => ({ Statistics: a.statistics }),
                ),
            }
          : undefined,
      }
    : undefined;

const buildValidationConfigurations = (
  configs: ValidationConfiguration[] | undefined,
) =>
  configs?.map((c) => ({
    RulesetArn: c.rulesetArn,
    ValidationMode: c.validationMode,
  }));

const buildJobSample = (sample: JobSample | undefined) =>
  sample ? { Mode: sample.mode, Size: sample.size } : undefined;

const buildCommon = (props: JobProps) => ({
  EncryptionKeyArn: props.encryptionKeyArn,
  EncryptionMode: props.encryptionMode,
  LogSubscription: props.logSubscription,
  MaxCapacity: props.maxCapacity,
  MaxRetries: props.maxRetries,
  RoleArn: props.role,
  Timeout: toWireMinutes(props.timeout),
});

export const JobProvider = () =>
  Provider.effect(
    Job,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { jobName?: string | undefined },
      ) {
        return (
          props.jobName ?? (yield* createPhysicalName({ id, maxLength: 240 }))
        );
      });

      const observe = Effect.fn(function* (name: string) {
        return yield* databrew
          .describeJob({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Job.Provider.of({
        stables: ["jobName", "jobArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* databrew.listJobs
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.Jobs ?? [])
              .map((j) => ({
                jobName: j.Name,
                jobArn:
                  j.ResourceArn ??
                  databrewArn(region, accountId, "job", j.Name),
                type: j.Type ?? "RECIPE",
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.jobName ?? (yield* createName(id, olds ?? {}));
          const job = yield* observe(name);
          if (job === undefined) return undefined;
          const arn =
            job.ResourceArn ?? databrewArn(region, accountId, "job", name);
          const attrs = {
            jobName: name,
            jobArn: arn,
            type: job.Type ?? "RECIPE",
          };
          const tags = cleanMap(job.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          // The Update APIs accept neither the job type nor the input
          // associations — those are create-only.
          if (olds.type !== news.type) return { action: "replace" } as const;
          if (olds.datasetName !== news.datasetName) {
            return { action: "replace" } as const;
          }
          if (olds.projectName !== news.projectName) {
            return { action: "replace" } as const;
          }
          if (
            olds.recipeReference?.name !== news.recipeReference?.name ||
            (olds.recipeReference?.recipeVersion ?? "LATEST_PUBLISHED") !==
              (news.recipeReference?.recipeVersion ?? "LATEST_PUBLISHED")
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          yield* validate(news);
          const name = output?.jobName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          const job = yield* observe(name);

          // 2. ENSURE / 3. SYNC — Update{Profile,Recipe}Job is a full PUT
          if (job === undefined) {
            if (news.type === "PROFILE") {
              yield* retryWhileRoleNotAssumable(
                databrew.createProfileJob({
                  Name: name,
                  DatasetName: news.datasetName!,
                  OutputLocation: buildS3Location(news.outputLocation!),
                  Configuration: buildConfiguration(news.configuration),
                  ValidationConfigurations: buildValidationConfigurations(
                    news.validationConfigurations,
                  ),
                  JobSample: buildJobSample(news.jobSample),
                  Tags: desiredTags,
                  ...buildCommon(news),
                }),
              ).pipe(Effect.catchTag("ConflictException", () => Effect.void));
            } else {
              yield* retryWhileRoleNotAssumable(
                databrew.createRecipeJob({
                  Name: name,
                  DatasetName: news.datasetName,
                  ProjectName: news.projectName,
                  RecipeReference: news.recipeReference
                    ? {
                        Name: news.recipeReference.name,
                        // the API rejects a null version ("version null is
                        // invalid") — apply the documented default explicitly
                        RecipeVersion:
                          news.recipeReference.recipeVersion ??
                          "LATEST_PUBLISHED",
                      }
                    : undefined,
                  Outputs: buildOutputs(news.outputs),
                  Tags: desiredTags,
                  ...buildCommon(news),
                }),
              ).pipe(Effect.catchTag("ConflictException", () => Effect.void));
            }
          } else if (news.type === "PROFILE") {
            yield* retryWhileRoleNotAssumable(
              databrew.updateProfileJob({
                Name: name,
                OutputLocation: buildS3Location(news.outputLocation!),
                Configuration: buildConfiguration(news.configuration),
                ValidationConfigurations: buildValidationConfigurations(
                  news.validationConfigurations,
                ),
                JobSample: buildJobSample(news.jobSample),
                ...buildCommon(news),
              }),
            );
          } else {
            yield* retryWhileRoleNotAssumable(
              databrew.updateRecipeJob({
                Name: name,
                Outputs: buildOutputs(news.outputs),
                ...buildCommon(news),
              }),
            );
          }

          const arn =
            job?.ResourceArn ?? databrewArn(region, accountId, "job", name);

          // 3b. SYNC TAGS against observed cloud tags
          const observedTags = yield* fetchObservedTags(arn);
          yield* syncTags(arn, observedTags, desiredTags);

          yield* session.note(name);
          return { jobName: name, jobArn: arn, type: news.type };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A run in STARTING/RUNNING/STOPPING keeps the job's dataset and
          // recipe associated — downstream Dataset/Recipe deletes then fail
          // with ConflictException ("is used in job …") long after DeleteJob
          // itself succeeds. Stop in-flight runs and wait (bounded) for every
          // run to reach a terminal state before deleting the job.
          const runs = yield* databrew.listJobRuns
            .items({ Name: output.jobName })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([]),
              ),
            );
          const isActive = (state: string | undefined): boolean =>
            state === "STARTING" || state === "RUNNING" || state === "STOPPING";
          yield* Effect.forEach(
            runs.filter(
              (run) =>
                run.RunId !== undefined &&
                (run.State === "STARTING" || run.State === "RUNNING"),
            ),
            (run) =>
              databrew
                .stopJobRun({ Name: output.jobName, RunId: run.RunId! })
                .pipe(
                  // Already stopping/stopped (ValidationException) or gone.
                  Effect.catchTag(
                    ["ResourceNotFoundException", "ValidationException"],
                    () => Effect.succeed(undefined),
                  ),
                ),
          );
          if (runs.some((run) => isActive(run.State))) {
            yield* databrew.listJobRuns.items({ Name: output.jobName }).pipe(
              // Settled = no active run observed; stop paginating at the
              // first active run instead of draining every page.
              Stream.filter((run) => isActive(run.State)),
              Stream.runHead,
              Effect.map(Option.isNone),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (settled): boolean => settled,
                times: 18,
              }),
            );
          }
          // ConflictException while a job run is still in flight.
          yield* retryWhileConflict(
            databrew.deleteJob({ Name: output.jobName }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        }),
      });
    }),
  );

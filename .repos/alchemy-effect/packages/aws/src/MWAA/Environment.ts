import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as mwaa from "@distilled.cloud/aws/mwaa";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, diffTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export class MWAAEnvironmentNotReady extends Data.TaggedError("MWAAEnvironmentNotReady")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class MWAAEnvironmentOperationFailed extends Data.TaggedError(
  "MWAAEnvironmentOperationFailed",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class MWAAEnvironmentUnexpectedResponse extends Data.TaggedError(
  "MWAAEnvironmentUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Per-module CloudWatch logging configuration for an MWAA {@link Environment}.
 */
export interface ModuleLoggingConfig {
  /**
   * Whether this Airflow log group is published to CloudWatch Logs.
   */
  enabled: boolean;
  /**
   * Airflow log level — one of `CRITICAL`, `ERROR`, `WARNING`, `INFO`, `DEBUG`.
   */
  logLevel: string;
}

/**
 * CloudWatch logging configuration for the five Airflow log groups of an MWAA
 * {@link Environment}. Any group left unset is disabled.
 */
export interface EnvironmentLoggingConfig {
  /** DAG processing logs. */
  dagProcessingLogs?: ModuleLoggingConfig;
  /** Scheduler logs. */
  schedulerLogs?: ModuleLoggingConfig;
  /** Webserver logs. */
  webserverLogs?: ModuleLoggingConfig;
  /** Worker logs. */
  workerLogs?: ModuleLoggingConfig;
  /** Task logs. */
  taskLogs?: ModuleLoggingConfig;
}

export interface EnvironmentProps {
  /**
   * Name of the environment (1-80 chars, must start with a letter). If omitted,
   * a deterministic physical name is generated. Changing the name replaces the
   * environment.
   */
  environmentName?: string;
  /**
   * ARN of the IAM execution role Amazon MWAA and Apache Airflow assume to
   * access AWS resources (the DAGs bucket, CloudWatch, SQS, KMS). Updateable
   * in place.
   */
  executionRoleArn: string;
  /**
   * ARN of the S3 bucket that holds your DAG code, `requirements.txt`, plugins,
   * and startup script. The bucket must block public access and have
   * versioning enabled. Updateable in place.
   */
  sourceBucketArn: string;
  /**
   * Relative path (within the source bucket) to the folder containing your DAG
   * files, e.g. `"dags"`. Updateable in place.
   */
  dagS3Path: string;
  /**
   * The private subnet IDs (exactly two, in distinct Availability Zones) the
   * environment's webserver, scheduler, and workers run in. Changing the
   * subnets replaces the environment.
   */
  subnetIds: string[];
  /**
   * VPC security group IDs applied to the environment's network interfaces.
   * Updateable in place.
   * @default a security group created for the environment
   */
  securityGroupIds?: string[];
  /**
   * Apache Airflow version, e.g. `"2.10.3"`. Downgrades are not permitted.
   * @default the latest version supported by MWAA
   */
  airflowVersion?: string;
  /**
   * Environment class (sizing), e.g. `"mw1.small"`, `"mw1.medium"`,
   * `"mw1.large"`. Updateable in place.
   * @default "mw1.small"
   */
  environmentClass?: string;
  /**
   * Maximum number of Airflow workers to scale up to. Updateable in place.
   * @default 10
   */
  maxWorkers?: number;
  /**
   * Minimum number of Airflow workers. Updateable in place.
   * @default 1
   */
  minWorkers?: number;
  /**
   * Maximum number of Airflow web servers (Airflow 2.2.2+). Updateable in
   * place.
   */
  maxWebservers?: number;
  /**
   * Minimum number of Airflow web servers (Airflow 2.2.2+). Updateable in
   * place.
   */
  minWebservers?: number;
  /**
   * Number of Airflow schedulers. Updateable in place.
   */
  schedulers?: number;
  /**
   * Apache Airflow web server access mode — `PRIVATE_ONLY` (VPC-only endpoint)
   * or `PUBLIC_ONLY` (internet-accessible). Updateable in place.
   * @default "PRIVATE_ONLY"
   */
  webserverAccessMode?: string;
  /**
   * Day and time of the weekly 30-minute maintenance window in
   * `DAY:HH:MM` (UTC), e.g. `"MON:03:30"`. Updateable in place.
   */
  weeklyMaintenanceWindowStart?: string;
  /**
   * ARN or key ID of the customer-managed KMS key used to encrypt data.
   * Changing the key replaces the environment.
   * @default an AWS-owned key
   */
  kmsKey?: string;
  /**
   * Whether the VPC endpoints for the environment are managed by MWAA
   * (`SERVICE`) or by you (`CUSTOMER`). Changing this replaces the environment.
   * @default "SERVICE"
   */
  endpointManagement?: string;
  /**
   * Apache Airflow configuration overrides, keyed by
   * `section.option`, e.g. `{ "core.default_task_retries": "3" }`. Values
   * carrying secrets (SMTP passwords, connection URIs, …) may be passed as
   * `Redacted.Redacted<string>` so they never appear in logs. Updateable in
   * place.
   */
  airflowConfigurationOptions?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Relative path to the plugins `.zip` in the source bucket. Updateable in
   * place.
   */
  pluginsS3Path?: string;
  /**
   * S3 object version of the plugins `.zip`. Updateable in place.
   */
  pluginsS3ObjectVersion?: string;
  /**
   * Relative path to `requirements.txt` in the source bucket. Updateable in
   * place.
   */
  requirementsS3Path?: string;
  /**
   * S3 object version of `requirements.txt`. Updateable in place.
   */
  requirementsS3ObjectVersion?: string;
  /**
   * Relative path to the startup shell script in the source bucket. Updateable
   * in place.
   */
  startupScriptS3Path?: string;
  /**
   * S3 object version of the startup script. Updateable in place.
   */
  startupScriptS3ObjectVersion?: string;
  /**
   * CloudWatch logging configuration for the five Airflow log groups.
   * Updateable in place.
   */
  loggingConfiguration?: EnvironmentLoggingConfig;
  /**
   * User-defined tags for the environment.
   */
  tags?: Record<string, string>;
}

export interface Environment extends Resource<
  "AWS.MWAA.Environment",
  EnvironmentProps,
  {
    /** Name of the environment. */
    environmentName: string;
    /** ARN of the environment. */
    arn: string;
    /** Current lifecycle status (e.g. `CREATING`, `AVAILABLE`). */
    status: string;
    /** Host name of the Airflow web server UI. */
    webserverUrl: string | undefined;
    /** ARN of the execution role Airflow tasks run as. */
    executionRoleArn: string | undefined;
    /** ARN of the service-linked role MWAA uses to manage the environment. */
    serviceRoleArn: string | undefined;
    /** Running Apache Airflow version. */
    airflowVersion: string | undefined;
    /** Environment size class (e.g. `mw1.small`). */
    environmentClass: string | undefined;
    /** ARN of the S3 bucket holding DAG code. */
    sourceBucketArn: string | undefined;
    /** Relative S3 path to the DAGs folder. */
    dagS3Path: string | undefined;
    /** Celery executor queue used by the environment's workers. */
    celeryExecutorQueue: string | undefined;
    /** VPC endpoint service name for the Airflow metadata database. */
    databaseVpcEndpointService: string | undefined;
    /** VPC endpoint service name for the Airflow web server. */
    webserverVpcEndpointService: string | undefined;
    /** Tags on the environment (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Managed Workflows for Apache Airflow (MWAA) environment — a fully
 * managed Apache Airflow deployment that runs your DAGs.
 *
 * Environments take roughly 20-30 minutes to create and are billed hourly for
 * the environment, workers, and schedulers while they exist. Each environment
 * needs an S3 bucket for DAG code (versioned, public access blocked), an IAM
 * execution role, and two private subnets in distinct Availability Zones with
 * outbound internet access (via NAT gateway or VPC endpoints). Destroy
 * environments you are not using.
 * ### Creating an Environment
 * **Example:** Basic Environment
 * ```typescript
 * const environment = yield* Environment("Airflow", {
 *   executionRoleArn: role.roleArn,
 *   sourceBucketArn: bucket.bucketArn,
 *   dagS3Path: "dags",
 *   subnetIds: [privateSubnetA.subnetId, privateSubnetB.subnetId],
 *   airflowVersion: "2.10.3",
 *   environmentClass: "mw1.small",
 *   maxWorkers: 5,
 * });
 * ```
 *
 * **Example:** Public Webserver with Logging
 * ```typescript
 * const environment = yield* Environment("Airflow", {
 *   executionRoleArn: role.roleArn,
 *   sourceBucketArn: bucket.bucketArn,
 *   dagS3Path: "dags",
 *   subnetIds: [privateSubnetA.subnetId, privateSubnetB.subnetId],
 *   webserverAccessMode: "PUBLIC_ONLY",
 *   loggingConfiguration: {
 *     schedulerLogs: { enabled: true, logLevel: "INFO" },
 *     workerLogs: { enabled: true, logLevel: "INFO" },
 *     taskLogs: { enabled: true, logLevel: "INFO" },
 *   },
 *   airflowConfigurationOptions: {
 *     "core.default_task_retries": "3",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Environment = Resource<Environment>("AWS.MWAA.Environment");

// Terminal states: environment stopped converging.
const FAILED_STATES = new Set(["CREATE_FAILED", "UPDATE_FAILED", "UNAVAILABLE", "ROLLBACK_FAILED"]);

const toModuleInput = (
  config: ModuleLoggingConfig | undefined,
): mwaa.ModuleLoggingConfigurationInput | undefined =>
  config === undefined ? undefined : { Enabled: config.enabled, LogLevel: config.logLevel };

const toLoggingInput = (
  config: EnvironmentLoggingConfig | undefined,
): mwaa.LoggingConfigurationInput | undefined => {
  if (config === undefined) return undefined;
  return {
    DagProcessingLogs: toModuleInput(config.dagProcessingLogs),
    SchedulerLogs: toModuleInput(config.schedulerLogs),
    WebserverLogs: toModuleInput(config.webserverLogs),
    WorkerLogs: toModuleInput(config.workerLogs),
    TaskLogs: toModuleInput(config.taskLogs),
  };
};

// Compare desired logging against the OBSERVED configuration. A module left
// unset is disabled; a disabled module's log level is irrelevant.
const LOG_MODULES = [
  ["dagProcessingLogs", "DagProcessingLogs"],
  ["schedulerLogs", "SchedulerLogs"],
  ["webserverLogs", "WebserverLogs"],
  ["workerLogs", "WorkerLogs"],
  ["taskLogs", "TaskLogs"],
] as const;

const sameLogging = (
  desired: EnvironmentLoggingConfig,
  observed: mwaa.LoggingConfiguration | undefined,
): boolean =>
  LOG_MODULES.every(([prop, wire]) => {
    const want = desired[prop];
    const have = observed?.[wire];
    const wantEnabled = want?.enabled ?? false;
    if (wantEnabled !== (have?.Enabled ?? false)) return false;
    return !wantEnabled || want?.logLevel === have?.LogLevel;
  });

const sameStringSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((v) => setB.has(v));
};

const configValue = (v: string | Redacted.Redacted<string> | undefined): string | undefined =>
  Redacted.isRedacted(v) ? Redacted.value(v) : v;

// Compare desired Airflow configuration options against the observed ones.
// Both sides may carry Redacted values (the props by choice, the observed
// options because distilled decodes them as SensitiveString) — unwrap for the
// comparison only.
const sameConfigOptions = (
  a: Record<string, string | Redacted.Redacted<string>> | undefined,
  b: { [key: string]: string | Redacted.Redacted<string> | undefined } | undefined,
): boolean => {
  const ea = Object.entries(a ?? {});
  const eb = Object.entries(b ?? {}).filter(([, v]) => v !== undefined);
  if (ea.length !== eb.length) return false;
  const bMap = b ?? {};
  return ea.every(([k, v]) => configValue(bMap[k]) === configValue(v));
};

/** The modules MWAA creates `airflow-{environment}-{module}` log groups for. */
const MWAA_LOG_MODULES = ["DAGProcessing", "Scheduler", "Task", "WebServer", "Worker"] as const;

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<EnvironmentProps>) =>
        props.environmentName
          ? Effect.succeed(props.environmentName)
          : createPhysicalName({ id, maxLength: 80 });

      const readEnvironment = Effect.fn(function* (name: string) {
        const response = yield* mwaa
          .getEnvironment({ Name: name })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
        return response?.Environment;
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* mwaa
          .listTagsForResource({ ResourceArn: arn })
          .pipe(Effect.orElseSucceed(() => undefined));
        const tags: Record<string, string> = {};
        for (const [key, value] of Object.entries(response?.Tags ?? {})) {
          if (value !== undefined) tags[key] = value;
        }
        return tags;
      });

      // Bounded readiness wait. MWAA environment provisioning/modification
      // typically completes in 20-30 minutes; budget ~45 min (90 * 30s). A
      // FAILED terminal state stops the wait immediately (non-retryable).
      const waitForAvailable = Effect.fn(function* (name: string) {
        const policy = Schedule.max([Schedule.fixed("30 seconds"), Schedule.recurs(90)]);
        return yield* readEnvironment(name).pipe(
          Effect.flatMap(
            Effect.fnUntraced(function* (env) {
              if (!env?.Arn) {
                return yield* new MWAAEnvironmentNotReady({
                  message: `Environment '${name}' not found`,
                });
              }
              const status = env.Status ?? "CREATING";
              if (FAILED_STATES.has(status)) {
                return yield* new MWAAEnvironmentOperationFailed({
                  message: `Environment '${name}' reached terminal state '${status}'`,
                });
              }
              if (status !== "AVAILABLE") {
                return yield* new MWAAEnvironmentNotReady({
                  message: `Environment '${name}' not available (status: ${status})`,
                });
              }
              return env;
            }),
          ),
          Effect.retry({
            while: (e) => e instanceof Error && !e.message.includes("terminal state"),
            schedule: policy,
          }),
        );
      });

      const toAttrs = Effect.fn(function* (env: mwaa.Environment) {
        if (!env.Name || !env.Arn) {
          return yield* new MWAAEnvironmentUnexpectedResponse({
            message: `Environment '${env.Name}' is missing its ARN`,
          });
        }
        return {
          environmentName: env.Name,
          arn: env.Arn,
          status: env.Status ?? "CREATING",
          webserverUrl: env.WebserverUrl,
          executionRoleArn: env.ExecutionRoleArn,
          serviceRoleArn: env.ServiceRoleArn,
          airflowVersion: env.AirflowVersion,
          environmentClass: env.EnvironmentClass,
          sourceBucketArn: env.SourceBucketArn,
          dagS3Path: env.DagS3Path,
          celeryExecutorQueue: env.CeleryExecutorQueue,
          databaseVpcEndpointService: env.DatabaseVpcEndpointService,
          webserverVpcEndpointService: env.WebserverVpcEndpointService,
          tags: yield* readTags(env.Arn),
        };
      });

      return {
        stables: ["environmentName", "arn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news;
          const o = olds;
          if (n === undefined || o === undefined) return undefined;
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          // Create-only properties force a replacement.
          if (!sameStringSet(n.subnetIds ?? [], o.subnetIds ?? [])) {
            return { action: "replace" } as const;
          }
          if ((n.kmsKey ?? undefined) !== (o.kmsKey ?? undefined)) {
            return { action: "replace" } as const;
          }
          if ((n.endpointManagement ?? undefined) !== (o.endpointManagement ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.environmentName ?? (yield* toName(id, olds ?? {}));
          const env = yield* readEnvironment(name);
          if (!env?.Arn) return undefined;
          const attrs = yield* toAttrs(env);
          return (yield* hasAlchemyTags(id, attrs.tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.environmentName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readEnvironment(name);

          // 2. Ensure — create if missing. Create errors (invalid subnets,
          //    role, etc.) propagate so misconfiguration surfaces directly
          //    rather than as a confusing "not found" after the wait below.
          if (observed === undefined) {
            yield* mwaa
              .createEnvironment({
                Name: name,
                ExecutionRoleArn: props.executionRoleArn,
                SourceBucketArn: props.sourceBucketArn,
                DagS3Path: props.dagS3Path,
                NetworkConfiguration: {
                  SubnetIds: props.subnetIds,
                  SecurityGroupIds: props.securityGroupIds,
                },
                AirflowVersion: props.airflowVersion,
                EnvironmentClass: props.environmentClass,
                MaxWorkers: props.maxWorkers,
                MinWorkers: props.minWorkers,
                MaxWebservers: props.maxWebservers,
                MinWebservers: props.minWebservers,
                Schedulers: props.schedulers,
                WebserverAccessMode: props.webserverAccessMode,
                WeeklyMaintenanceWindowStart: props.weeklyMaintenanceWindowStart,
                KmsKey: props.kmsKey,
                EndpointManagement: props.endpointManagement,
                AirflowConfigurationOptions: props.airflowConfigurationOptions,
                PluginsS3Path: props.pluginsS3Path,
                PluginsS3ObjectVersion: props.pluginsS3ObjectVersion,
                RequirementsS3Path: props.requirementsS3Path,
                RequirementsS3ObjectVersion: props.requirementsS3ObjectVersion,
                StartupScriptS3Path: props.startupScriptS3Path,
                StartupScriptS3ObjectVersion: props.startupScriptS3ObjectVersion,
                LoggingConfiguration: toLoggingInput(props.loggingConfiguration),
                Tags: desiredTags,
              })
              .pipe(
                // A freshly created execution role is not yet assumable by
                // airflow-env.amazonaws.com (IAM eventual consistency) —
                // CreateEnvironment rejects it with "Failed to assume role" for
                // several seconds. Retry bounded.
                Effect.retry({
                  while: (e) => e._tag === "MwaaExecutionRoleNotAssumable",
                  schedule: Schedule.spaced("5 seconds"),
                  times: 10,
                }),
              );
          }

          // Provisioning and in-flight modifications both surface as a
          // non-AVAILABLE status; wait for availability (bounded) so update
          // calls do not hit a conflict.
          observed = yield* waitForAvailable(name);

          // 3. Sync — compute an update delta from OBSERVED state.
          const update: mwaa.UpdateEnvironmentInput = { Name: name };
          let mutated = false;
          if (
            props.executionRoleArn !== undefined &&
            props.executionRoleArn !== observed.ExecutionRoleArn
          ) {
            update.ExecutionRoleArn = props.executionRoleArn;
            mutated = true;
          }
          if (
            props.sourceBucketArn !== undefined &&
            props.sourceBucketArn !== observed.SourceBucketArn
          ) {
            update.SourceBucketArn = props.sourceBucketArn;
            mutated = true;
          }
          if (props.dagS3Path !== undefined && props.dagS3Path !== observed.DagS3Path) {
            update.DagS3Path = props.dagS3Path;
            mutated = true;
          }
          if (
            props.airflowVersion !== undefined &&
            props.airflowVersion !== observed.AirflowVersion
          ) {
            update.AirflowVersion = props.airflowVersion;
            mutated = true;
          }
          if (
            props.environmentClass !== undefined &&
            props.environmentClass !== observed.EnvironmentClass
          ) {
            update.EnvironmentClass = props.environmentClass;
            mutated = true;
          }
          if (props.maxWorkers !== undefined && props.maxWorkers !== observed.MaxWorkers) {
            update.MaxWorkers = props.maxWorkers;
            mutated = true;
          }
          if (props.minWorkers !== undefined && props.minWorkers !== observed.MinWorkers) {
            update.MinWorkers = props.minWorkers;
            mutated = true;
          }
          if (props.maxWebservers !== undefined && props.maxWebservers !== observed.MaxWebservers) {
            update.MaxWebservers = props.maxWebservers;
            mutated = true;
          }
          if (props.minWebservers !== undefined && props.minWebservers !== observed.MinWebservers) {
            update.MinWebservers = props.minWebservers;
            mutated = true;
          }
          if (props.schedulers !== undefined && props.schedulers !== observed.Schedulers) {
            update.Schedulers = props.schedulers;
            mutated = true;
          }
          if (
            props.webserverAccessMode !== undefined &&
            props.webserverAccessMode !== observed.WebserverAccessMode
          ) {
            update.WebserverAccessMode = props.webserverAccessMode;
            mutated = true;
          }
          if (
            props.weeklyMaintenanceWindowStart !== undefined &&
            props.weeklyMaintenanceWindowStart !== observed.WeeklyMaintenanceWindowStart
          ) {
            update.WeeklyMaintenanceWindowStart = props.weeklyMaintenanceWindowStart;
            mutated = true;
          }
          const observedSg = observed.NetworkConfiguration?.SecurityGroupIds;
          if (
            props.securityGroupIds !== undefined &&
            !sameStringSet(props.securityGroupIds, observedSg ?? [])
          ) {
            update.NetworkConfiguration = {
              SecurityGroupIds: props.securityGroupIds,
            };
            mutated = true;
          }
          if (props.pluginsS3Path !== undefined && props.pluginsS3Path !== observed.PluginsS3Path) {
            update.PluginsS3Path = props.pluginsS3Path;
            update.PluginsS3ObjectVersion = props.pluginsS3ObjectVersion;
            mutated = true;
          }
          if (
            props.requirementsS3Path !== undefined &&
            props.requirementsS3Path !== observed.RequirementsS3Path
          ) {
            update.RequirementsS3Path = props.requirementsS3Path;
            update.RequirementsS3ObjectVersion = props.requirementsS3ObjectVersion;
            mutated = true;
          }
          if (
            props.startupScriptS3Path !== undefined &&
            props.startupScriptS3Path !== observed.StartupScriptS3Path
          ) {
            update.StartupScriptS3Path = props.startupScriptS3Path;
            update.StartupScriptS3ObjectVersion = props.startupScriptS3ObjectVersion;
            mutated = true;
          }
          if (
            props.airflowConfigurationOptions !== undefined &&
            !sameConfigOptions(
              props.airflowConfigurationOptions,
              observed.AirflowConfigurationOptions,
            )
          ) {
            update.AirflowConfigurationOptions = props.airflowConfigurationOptions;
            mutated = true;
          }
          if (
            props.loggingConfiguration !== undefined &&
            !sameLogging(props.loggingConfiguration, observed.LoggingConfiguration)
          ) {
            update.LoggingConfiguration = toLoggingInput(props.loggingConfiguration);
            mutated = true;
          }

          if (mutated) {
            yield* mwaa.updateEnvironment(update);
            observed = yield* waitForAvailable(name);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.Arn;
          if (arn) {
            const observedTags = yield* readTags(arn);
            const { removed, upsert } = diffTags(observedTags, desiredTags);
            if (upsert.length > 0) {
              yield* mwaa.tagResource({
                ResourceArn: arn,
                Tags: Object.fromEntries(upsert.map(({ Key, Value }) => [Key, Value])),
              });
            }
            if (removed.length > 0) {
              yield* mwaa.untagResource({ ResourceArn: arn, tagKeys: removed });
            }
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.environmentName;
          const existing = yield* readEnvironment(name);
          if (existing === undefined) return;
          // A second DeleteEnvironment on an environment that is already
          // DELETING is rejected; only initiate when it is not in flight.
          if (existing.Status !== "DELETING") {
            yield* mwaa
              .deleteEnvironment({ Name: name })
              .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
          }
          // Wait until the environment is gone. MWAA keeps ENIs in the
          // customer's subnets (under the environment's security groups)
          // until deletion completes, so returning early makes every
          // downstream Subnet/SecurityGroup/VPC delete fail with
          // DependencyViolation. Deletion typically takes 20-30 minutes;
          // budget ~45 min (90 * 30s). DELETE_FAILED stops immediately.
          yield* readEnvironment(name).pipe(
            Effect.flatMap(
              Effect.fnUntraced(function* (env) {
                if (env === undefined || env.Status === "DELETED") return;
                if (env.Status === "DELETE_FAILED") {
                  return yield* new MWAAEnvironmentOperationFailed({
                    message: `Environment '${name}' reached terminal state 'DELETE_FAILED'`,
                  });
                }
                return yield* new MWAAEnvironmentNotReady({
                  message: `Environment '${name}' still deleting (status: ${env.Status})`,
                });
              }),
            ),
            Effect.retry({
              while: (e) => e instanceof Error && !e.message.includes("terminal state"),
              schedule: Schedule.max([Schedule.fixed("30 seconds"), Schedule.recurs(90)]),
            }),
          );
          // MWAA creates a log group per enabled module and leaves them when
          // the environment is deleted, so every environment would leak them.
          yield* Effect.forEach(
            MWAA_LOG_MODULES,
            (module) =>
              logs
                .deleteLogGroup({ logGroupName: `airflow-${name}-${module}` })
                .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
            { discard: true },
          );
        }),

        list: () =>
          mwaa.listEnvironments.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk).flatMap((page) => page.Environments ?? [])),
            Effect.flatMap(
              Effect.forEach((name) => readEnvironment(name), {
                concurrency: 4,
              }),
            ),
            Effect.map((envs) =>
              envs.filter(
                (env): env is mwaa.Environment =>
                  env !== undefined && env.Name !== undefined && !!env.Arn,
              ),
            ),
            Effect.flatMap(Effect.forEach((env) => toAttrs(env), { concurrency: 4 })),
          ),
      };
    }),
  );

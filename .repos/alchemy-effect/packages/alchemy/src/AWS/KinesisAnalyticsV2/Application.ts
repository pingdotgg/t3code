import * as iam from "@distilled.cloud/aws/iam";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import { toWireMillis } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

/**
 * Runtime environment of a Managed Service for Apache Flink application,
 * e.g. `"FLINK-1_20"`.
 */
export type RuntimeEnvironment = analytics.RuntimeEnvironment;

/**
 * Lifecycle status of the application.
 */
export type ApplicationStatus = analytics.ApplicationStatus;

/**
 * Mode of the application. `STREAMING` runs the packaged Flink job;
 * `INTERACTIVE` backs a Studio (Zeppelin) notebook.
 */
export type ApplicationMode = "STREAMING" | "INTERACTIVE";

export interface ApplicationCodeProps {
  /**
   * ARN of the S3 bucket that contains the application code package
   * (a zip/jar built for the configured Flink runtime).
   */
  bucketArn: string;
  /**
   * Object key of the application code package within the bucket.
   */
  fileKey: string;
  /**
   * Version of the S3 object containing the application code.
   * @default the latest object version
   */
  objectVersion?: string;
}

export interface CheckpointConfigurationProps {
  /**
   * Whether to use the `DEFAULT` Flink checkpointing behavior or the
   * `CUSTOM` values supplied in this configuration.
   */
  configurationType: "DEFAULT" | "CUSTOM";
  /**
   * Whether checkpointing is enabled. Only used with `CUSTOM`.
   */
  checkpointingEnabled?: boolean;
  /**
   * Interval between checkpoints, e.g. `"1 minute"` or
   * `Duration.seconds(30)`. The API stores whole milliseconds. Only used
   * with `CUSTOM`.
   */
  checkpointInterval?: Duration.Input;
  /**
   * Minimum pause between checkpoint operations, e.g. `"5 seconds"`. The
   * API stores whole milliseconds. Only used with `CUSTOM`.
   */
  minPauseBetweenCheckpoints?: Duration.Input;
}

export interface MonitoringConfigurationProps {
  /**
   * Whether to use the `DEFAULT` monitoring behavior or the `CUSTOM`
   * values supplied in this configuration.
   */
  configurationType: "DEFAULT" | "CUSTOM";
  /**
   * Granularity of the CloudWatch metrics emitted by the application.
   * Only used with `CUSTOM`.
   */
  metricsLevel?: "APPLICATION" | "TASK" | "OPERATOR" | "PARALLELISM";
  /**
   * Log verbosity of the application. Only used with `CUSTOM`.
   */
  logLevel?: "INFO" | "WARN" | "ERROR" | "DEBUG";
}

export interface ParallelismConfigurationProps {
  /**
   * Whether to use the `DEFAULT` parallelism behavior or the `CUSTOM`
   * values supplied in this configuration.
   */
  configurationType: "DEFAULT" | "CUSTOM";
  /**
   * Initial number of parallel tasks the application can perform.
   * Only used with `CUSTOM`.
   */
  parallelism?: number;
  /**
   * Number of parallel tasks per Kinesis Processing Unit.
   * Only used with `CUSTOM`.
   */
  parallelismPerKPU?: number;
  /**
   * Whether the service automatically scales the application's parallelism.
   * Only used with `CUSTOM`.
   */
  autoScalingEnabled?: boolean;
}

export interface FlinkConfigurationProps {
  /**
   * Checkpointing (fault tolerance) settings for the Flink job.
   */
  checkpointConfiguration?: CheckpointConfigurationProps;
  /**
   * CloudWatch metrics/logging verbosity settings for the Flink job.
   */
  monitoringConfiguration?: MonitoringConfigurationProps;
  /**
   * Parallelism (KPU scaling) settings for the Flink job.
   */
  parallelismConfiguration?: ParallelismConfigurationProps;
}

export interface PropertyGroupProps {
  /**
   * Identifier of the property group, e.g. `"kinesis.analytics.flink.run.options"`
   * or an application-defined group name.
   */
  propertyGroupId: string;
  /**
   * Key-value runtime properties exposed to the application through this group.
   */
  propertyMap: Record<string, string>;
}

export interface ApplicationVpcProps {
  /**
   * IDs of the subnets the application's ENIs are placed in.
   */
  subnetIds: string[];
  /**
   * IDs of the security groups attached to the application's ENIs.
   */
  securityGroupIds: string[];
}

export interface ApplicationProps {
  /**
   * Name of the application. Changing the name replaces the application.
   * @default ${app}-${id}-${stage}-${instanceId}
   */
  applicationName?: string;
  /**
   * Description of the application. The API offers no way to change the
   * description in place, so changing it replaces the application.
   */
  description?: string;
  /**
   * Runtime environment of the application, e.g. `"FLINK-1_20"`.
   * Updated in place (Flink version upgrade).
   */
  runtimeEnvironment: RuntimeEnvironment;
  /**
   * Mode of the application. Changing the mode replaces the application.
   * @default "STREAMING"
   */
  applicationMode?: ApplicationMode;
  /**
   * ARN of the IAM role the service assumes to read the code object and
   * access sources/sinks.
   * @default a role is auto-created granting read access to the code
   * bucket, CloudWatch Logs delivery, and (when `vpc` is set) the EC2
   * permissions required to manage the application's network interfaces.
   */
  serviceExecutionRole?: string;
  /**
   * Location of the application code package (zip/jar) in S3.
   */
  code: ApplicationCodeProps;
  /**
   * Runtime properties exposed to the application as property groups.
   */
  environmentProperties?: PropertyGroupProps[];
  /**
   * Flink-specific settings (checkpointing, monitoring, parallelism).
   */
  flinkConfiguration?: FlinkConfigurationProps;
  /**
   * Whether snapshots (savepoints) are enabled for the application.
   * @default false
   */
  snapshotsEnabled?: boolean;
  /**
   * VPC configuration. When set the application's ENIs are placed in the
   * given subnets so the Flink job can reach VPC-private resources.
   */
  vpc?: ApplicationVpcProps;
  /**
   * Whether the application should be running. When `true` the reconciler
   * starts the application and waits for `RUNNING`; when `false` (default)
   * a running application is force-stopped back to `READY`.
   *
   * Starting requires the code object to be a real Flink application jar —
   * a placeholder zip passes creation but fails to start.
   * @default false
   */
  start?: boolean;
  /**
   * Start of the 8-hour daily window in which the service may apply
   * maintenance (patching) to the application, as `"HH:mm"` UTC — e.g.
   * `"02:00"`. When omitted the service-assigned window is left unchanged.
   */
  maintenanceWindowStartTime?: string;
  /**
   * Tags to apply to the application.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "AWS.KinesisAnalyticsV2.Application",
  ApplicationProps,
  {
    /**
     * Physical name of the application.
     */
    applicationName: string;
    /**
     * ARN of the application.
     */
    applicationArn: string;
    /**
     * Current lifecycle status of the application.
     */
    applicationStatus: ApplicationStatus;
    /**
     * Current version of the application's configuration. Incremented by
     * every configuration update.
     */
    applicationVersionId: number;
    /**
     * Runtime environment of the application.
     */
    runtimeEnvironment: RuntimeEnvironment;
    /**
     * Mode of the application.
     */
    applicationMode: ApplicationMode | undefined;
    /**
     * ARN of the IAM role the service assumes.
     */
    serviceExecutionRole: string | undefined;
    /**
     * Name of the auto-created IAM role, when one was synthesized for this
     * application. `undefined` when the caller supplied `serviceExecutionRole`.
     */
    roleName: string | undefined;
    /**
     * ID of the application's VPC configuration, when one is attached.
     */
    vpcConfigurationId: string | undefined;
    /**
     * ARN of the S3 bucket currently holding the application code.
     */
    codeBucketArn: string | undefined;
    /**
     * Object key of the application code currently configured.
     */
    codeFileKey: string | undefined;
    /**
     * Object version of the application code currently configured.
     */
    codeObjectVersion: string | undefined;
    /**
     * Start of the daily maintenance window currently configured, as
     * `"HH:mm"` UTC.
     */
    maintenanceWindowStartTime: string | undefined;
    /**
     * End of the daily maintenance window currently configured, as
     * `"HH:mm"` UTC (always 8 hours after the start).
     */
    maintenanceWindowEndTime: string | undefined;
    /**
     * Current tags reported for the application.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Managed Service for Apache Flink (Kinesis Data Analytics v2)
 * application.
 *
 * `Application` owns the application definition — runtime environment, code
 * location in S3, runtime properties, Flink settings, optional VPC
 * connectivity and tags — and converges each aspect in place via
 * `UpdateApplication`. Unless you supply `serviceExecutionRole`, an IAM role
 * is auto-created granting the service read access to the code bucket and
 * CloudWatch Logs delivery.
 *
 * The application is created in `READY` and does not run (or bill KPUs)
 * until started. Set `start: true` to have the reconciler start the job and
 * wait for `RUNNING` — this requires the code object to be a real Flink
 * application jar.
 * @resource
 * @section Creating Applications
 * @example Flink application from S3 code
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const bucket = yield* AWS.S3.Bucket("FlinkCode");
 * const app = yield* AWS.KinesisAnalyticsV2.Application("Enrichment", {
 *   runtimeEnvironment: "FLINK-1_20",
 *   code: {
 *     bucketArn: bucket.bucketArn,
 *     fileKey: "jobs/enrichment-1.0.jar",
 *   },
 * });
 * ```
 *
 * @example Runtime properties and parallelism
 * ```typescript
 * const app = yield* AWS.KinesisAnalyticsV2.Application("Enrichment", {
 *   runtimeEnvironment: "FLINK-1_20",
 *   code: { bucketArn: bucket.bucketArn, fileKey: "jobs/enrichment-1.0.jar" },
 *   environmentProperties: [
 *     {
 *       propertyGroupId: "EnrichmentProperties",
 *       propertyMap: { "input.stream": "clickstream", "region": "us-west-2" },
 *     },
 *   ],
 *   flinkConfiguration: {
 *     parallelismConfiguration: {
 *       configurationType: "CUSTOM",
 *       parallelism: 2,
 *       parallelismPerKPU: 1,
 *       autoScalingEnabled: false,
 *     },
 *   },
 *   snapshotsEnabled: true,
 * });
 * ```
 *
 * @section VPC Connectivity
 * @example Place the application in a VPC
 * ```typescript
 * const app = yield* AWS.KinesisAnalyticsV2.Application("Enrichment", {
 *   runtimeEnvironment: "FLINK-1_20",
 *   code: { bucketArn: bucket.bucketArn, fileKey: "jobs/enrichment-1.0.jar" },
 *   vpc: {
 *     subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *     securityGroupIds: [sg.securityGroupId],
 *   },
 * });
 * ```
 *
 * @section Maintenance Window
 * @example Pin the daily maintenance window
 * ```typescript
 * const app = yield* AWS.KinesisAnalyticsV2.Application("Enrichment", {
 *   runtimeEnvironment: "FLINK-1_20",
 *   code: { bucketArn: bucket.bucketArn, fileKey: "jobs/enrichment-1.0.jar" },
 *   maintenanceWindowStartTime: "02:00",
 * });
 * ```
 *
 * @section Running the Application
 * @example Start the Flink job and keep it running
 * ```typescript
 * const app = yield* AWS.KinesisAnalyticsV2.Application("Enrichment", {
 *   runtimeEnvironment: "FLINK-1_20",
 *   code: { bucketArn: bucket.bucketArn, fileKey: "jobs/enrichment-1.0.jar" },
 *   start: true,
 * });
 * ```
 */
export const Application = Resource<Application>(
  "AWS.KinesisAnalyticsV2.Application",
);

/**
 * Validation error raised before any AWS call when the props are invalid.
 */
export class ApplicationValidationError extends Data.TaggedError(
  "ApplicationValidationError",
)<{
  readonly message: string;
}> {}

/**
 * The application did not settle into a stable status (READY / RUNNING /
 * ROLLED_BACK) within the bounded wait.
 */
export class ApplicationNotStable extends Data.TaggedError(
  "ApplicationNotStable",
)<{
  readonly applicationName: string;
  readonly status: string;
}> {}

/**
 * `start: true` was requested but the application failed to reach `RUNNING`
 * — either the start rolled back (bad jar, bad configuration) or the
 * bounded wait elapsed.
 */
export class ApplicationStartFailed extends Data.TaggedError(
  "ApplicationStartFailed",
)<{
  readonly applicationName: string;
  readonly status: string;
}> {}

class ApplicationStatusPending extends Data.TaggedError(
  "ApplicationStatusPending",
)<{
  readonly status: string;
}> {}

class ApplicationStillExists extends Data.TaggedError(
  "ApplicationStillExists",
) {}

const createApplicationName = (
  id: string,
  props: { applicationName?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.applicationName) {
      return props.applicationName;
    }
    return yield* createPhysicalName({ id, maxLength: 128 });
  });

/**
 * Data-FIRST `Effect.retry(self, options)` wrapped with an explicit return
 * annotation — inlining `Effect.retry` with an options object in provider
 * lifecycle code leaves `Retry.Return`'s conditional type unresolved in the
 * provider's inferred layer type, which TypeScript's declaration emit widens
 * to an `unknown` R — poisoning `AWS.providers()` for every downstream
 * consumer (see `retryThroughDeletionWindow` in SecretsManager/Secret.ts).
 *
 * Retries `InvalidArgumentException`s that mention the IAM role — a freshly
 * created role takes a few seconds to become assumable by the
 * kinesisanalytics service principal, and `CreateApplication` surfaces that
 * propagation window as a role-related `InvalidArgumentException`.
 */
const retryThroughRolePropagation = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidArgumentException" &&
      /role|assume|trust|principal/i.test(
        (e as { Message?: string }).Message ?? "",
      ),
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(15)]),
  });

/**
 * Retries `ResourceInUseException` / `ConcurrentModificationException`
 * (application transitioning between statuses, or a concurrent operation in
 * flight) on a bounded schedule. Explicitly annotated for the same
 * declaration-emit reason as {@link retryThroughRolePropagation}.
 */
const retryWhileInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ResourceInUseException" ||
      e._tag === "ConcurrentModificationException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  });

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value?: string }> | undefined,
) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = ({
  detail,
  tags,
  roleName,
}: {
  detail: analytics.ApplicationDetail;
  tags: Record<string, string>;
  roleName: string | undefined;
}): Application["Attributes"] => {
  const config = detail.ApplicationConfigurationDescription;
  const code =
    config?.ApplicationCodeConfigurationDescription?.CodeContentDescription
      ?.S3ApplicationCodeLocationDescription;
  return {
    applicationName: detail.ApplicationName,
    applicationArn: detail.ApplicationARN,
    applicationStatus: detail.ApplicationStatus,
    applicationVersionId: detail.ApplicationVersionId,
    runtimeEnvironment: detail.RuntimeEnvironment,
    applicationMode: detail.ApplicationMode as ApplicationMode | undefined,
    serviceExecutionRole: detail.ServiceExecutionRole,
    roleName,
    vpcConfigurationId:
      config?.VpcConfigurationDescriptions?.[0]?.VpcConfigurationId,
    codeBucketArn: code?.BucketARN,
    codeFileKey: code?.FileKey,
    codeObjectVersion: code?.ObjectVersion,
    maintenanceWindowStartTime:
      detail.ApplicationMaintenanceConfigurationDescription
        ?.ApplicationMaintenanceWindowStartTime,
    maintenanceWindowEndTime:
      detail.ApplicationMaintenanceConfigurationDescription
        ?.ApplicationMaintenanceWindowEndTime,
    tags,
  };
};

const describeApplicationDetail = Effect.fn(function* (
  applicationName: string,
) {
  const response = yield* analytics
    .describeApplication({ ApplicationName: applicationName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return response?.ApplicationDetail;
});

const readApplication = Effect.fn(function* ({
  applicationName,
  roleName,
}: {
  applicationName: string;
  roleName: string | undefined;
}) {
  const detail = yield* describeApplicationDetail(applicationName);
  if (!detail) {
    return undefined;
  }
  // The application can vanish between the describe above and the tag read
  // (e.g. a concurrent destroy) — a typed `ResourceNotFoundException` here
  // just means it's gone.
  const tagsResponse = yield* analytics
    .listTagsForResource({ ResourceARN: detail.ApplicationARN })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!tagsResponse) {
    return undefined;
  }
  return toAttrs({
    detail,
    tags: toTagRecord(tagsResponse.Tags),
    roleName,
  });
});

// Configuration updates settle fast (the app stays READY); 2s × 45 bounds
// the wait at 90s. RUNNING is also stable — a started app being updated
// passes through UPDATING and returns to RUNNING.
const waitForApplicationStable = (applicationName: string) =>
  Effect.gen(function* () {
    const detail = yield* describeApplicationDetail(applicationName);
    if (!detail) {
      return yield* Effect.fail(
        new ApplicationNotStable({ applicationName, status: "MISSING" }),
      );
    }
    if (
      detail.ApplicationStatus !== "READY" &&
      detail.ApplicationStatus !== "RUNNING" &&
      detail.ApplicationStatus !== "ROLLED_BACK"
    ) {
      return yield* Effect.fail(
        new ApplicationStatusPending({ status: detail.ApplicationStatus }),
      );
    }
    return detail;
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "ApplicationStatusPending",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(45),
      ]),
    }),
    Effect.catchTag("ApplicationStatusPending", (e) =>
      Effect.fail(
        new ApplicationNotStable({ applicationName, status: e.status }),
      ),
    ),
  );

// A Flink job start submits the jar to a fresh cluster — several minutes is
// normal. 10s × 57 bounds the wait at 570s. A start that rolls back
// (ROLLED_BACK / back to READY after STARTING) fails fast with a typed error.
const waitForApplicationRunning = (applicationName: string) =>
  Effect.gen(function* () {
    const detail = yield* describeApplicationDetail(applicationName);
    const status = detail?.ApplicationStatus ?? "MISSING";
    if (status === "RUNNING") {
      return detail!;
    }
    if (status === "STARTING" || status === "UPDATING") {
      return yield* Effect.fail(new ApplicationStatusPending({ status }));
    }
    return yield* Effect.fail(
      new ApplicationStartFailed({ applicationName, status }),
    );
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "ApplicationStatusPending",
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(57),
      ]),
    }),
    Effect.catchTag("ApplicationStatusPending", (e) =>
      Effect.fail(
        new ApplicationStartFailed({ applicationName, status: e.status }),
      ),
    ),
  );

// Force-stop transitions through FORCE_STOPPING/STOPPING back to READY;
// 10s × 30 bounds the wait at 300s.
const waitForApplicationStopped = (applicationName: string) =>
  Effect.gen(function* () {
    const detail = yield* describeApplicationDetail(applicationName);
    const status = detail?.ApplicationStatus ?? "MISSING";
    if (
      status === "READY" ||
      status === "ROLLED_BACK" ||
      status === "MISSING"
    ) {
      return;
    }
    return yield* Effect.fail(new ApplicationStatusPending({ status }));
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "ApplicationStatusPending",
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(30),
      ]),
    }),
    Effect.catchTag("ApplicationStatusPending", (e) =>
      Effect.fail(
        new ApplicationNotStable({ applicationName, status: e.status }),
      ),
    ),
  );

// Deletion is quick for READY apps but a previously-running app halts its
// job first; 3s × 50 bounds the wait at 150s.
const waitForApplicationDeleted = (applicationName: string) =>
  Effect.gen(function* () {
    const detail = yield* describeApplicationDetail(applicationName);
    if (detail !== undefined) {
      return yield* Effect.fail(new ApplicationStillExists());
    }
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "ApplicationStillExists",
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(50),
      ]),
    }),
  );

const deleteRoleIfExists = Effect.fn(function* (roleName: string) {
  yield* iam
    .deleteRolePolicy({ RoleName: roleName, PolicyName: roleName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
  yield* iam
    .deleteRole({ RoleName: roleName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
});

const toWirePropertyGroups = (
  groups: ReadonlyArray<PropertyGroupProps>,
): analytics.PropertyGroup[] =>
  groups.map((group) => ({
    PropertyGroupId: group.propertyGroupId,
    PropertyMap: group.propertyMap,
  }));

// Canonical string form for observed-vs-desired comparison — order of
// groups and of keys within a group is not significant.
const canonicalPropertyGroups = (
  groups: ReadonlyArray<analytics.PropertyGroup> | undefined,
) =>
  JSON.stringify(
    [...(groups ?? [])]
      .map((group) => ({
        id: group.PropertyGroupId,
        map: Object.fromEntries(
          Object.entries(group.PropertyMap ?? {})
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

const sameStringSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

const checkpointDiffers = (
  desired: CheckpointConfigurationProps,
  observed: analytics.CheckpointConfigurationDescription | undefined,
) =>
  desired.configurationType !== observed?.ConfigurationType ||
  (desired.checkpointingEnabled !== undefined &&
    desired.checkpointingEnabled !== observed?.CheckpointingEnabled) ||
  (desired.checkpointInterval !== undefined &&
    toWireMillis(desired.checkpointInterval) !==
      observed?.CheckpointInterval) ||
  (desired.minPauseBetweenCheckpoints !== undefined &&
    toWireMillis(desired.minPauseBetweenCheckpoints) !==
      observed?.MinPauseBetweenCheckpoints);

const monitoringDiffers = (
  desired: MonitoringConfigurationProps,
  observed: analytics.MonitoringConfigurationDescription | undefined,
) =>
  desired.configurationType !== observed?.ConfigurationType ||
  (desired.metricsLevel !== undefined &&
    desired.metricsLevel !== observed?.MetricsLevel) ||
  (desired.logLevel !== undefined && desired.logLevel !== observed?.LogLevel);

const parallelismDiffers = (
  desired: ParallelismConfigurationProps,
  observed: analytics.ParallelismConfigurationDescription | undefined,
) =>
  desired.configurationType !== observed?.ConfigurationType ||
  (desired.parallelism !== undefined &&
    desired.parallelism !== observed?.Parallelism) ||
  (desired.parallelismPerKPU !== undefined &&
    desired.parallelismPerKPU !== observed?.ParallelismPerKPU) ||
  (desired.autoScalingEnabled !== undefined &&
    desired.autoScalingEnabled !== observed?.AutoScalingEnabled);

const toFlinkConfiguration = (
  flink: FlinkConfigurationProps | undefined,
): analytics.FlinkApplicationConfiguration | undefined => {
  if (!flink) return undefined;
  const configuration: analytics.FlinkApplicationConfiguration = {};
  if (flink.checkpointConfiguration) {
    configuration.CheckpointConfiguration = {
      ConfigurationType: flink.checkpointConfiguration.configurationType,
      CheckpointingEnabled: flink.checkpointConfiguration.checkpointingEnabled,
      CheckpointInterval: toWireMillis(
        flink.checkpointConfiguration.checkpointInterval,
      ),
      MinPauseBetweenCheckpoints: toWireMillis(
        flink.checkpointConfiguration.minPauseBetweenCheckpoints,
      ),
    };
  }
  if (flink.monitoringConfiguration) {
    configuration.MonitoringConfiguration = {
      ConfigurationType: flink.monitoringConfiguration.configurationType,
      MetricsLevel: flink.monitoringConfiguration.metricsLevel,
      LogLevel: flink.monitoringConfiguration.logLevel,
    };
  }
  if (flink.parallelismConfiguration) {
    configuration.ParallelismConfiguration = {
      ConfigurationType: flink.parallelismConfiguration.configurationType,
      Parallelism: flink.parallelismConfiguration.parallelism,
      ParallelismPerKPU: flink.parallelismConfiguration.parallelismPerKPU,
      AutoScalingEnabled: flink.parallelismConfiguration.autoScalingEnabled,
    };
  }
  return Object.keys(configuration).length > 0 ? configuration : undefined;
};

const toFlinkConfigurationUpdate = (
  flink: FlinkConfigurationProps,
  observed: analytics.FlinkApplicationConfigurationDescription | undefined,
): analytics.FlinkApplicationConfigurationUpdate | undefined => {
  const update: analytics.FlinkApplicationConfigurationUpdate = {};
  if (
    flink.checkpointConfiguration &&
    checkpointDiffers(
      flink.checkpointConfiguration,
      observed?.CheckpointConfigurationDescription,
    )
  ) {
    update.CheckpointConfigurationUpdate = {
      ConfigurationTypeUpdate: flink.checkpointConfiguration.configurationType,
      CheckpointingEnabledUpdate:
        flink.checkpointConfiguration.checkpointingEnabled,
      CheckpointIntervalUpdate: toWireMillis(
        flink.checkpointConfiguration.checkpointInterval,
      ),
      MinPauseBetweenCheckpointsUpdate: toWireMillis(
        flink.checkpointConfiguration.minPauseBetweenCheckpoints,
      ),
    };
  }
  if (
    flink.monitoringConfiguration &&
    monitoringDiffers(
      flink.monitoringConfiguration,
      observed?.MonitoringConfigurationDescription,
    )
  ) {
    update.MonitoringConfigurationUpdate = {
      ConfigurationTypeUpdate: flink.monitoringConfiguration.configurationType,
      MetricsLevelUpdate: flink.monitoringConfiguration.metricsLevel,
      LogLevelUpdate: flink.monitoringConfiguration.logLevel,
    };
  }
  if (
    flink.parallelismConfiguration &&
    parallelismDiffers(
      flink.parallelismConfiguration,
      observed?.ParallelismConfigurationDescription,
    )
  ) {
    update.ParallelismConfigurationUpdate = {
      ConfigurationTypeUpdate: flink.parallelismConfiguration.configurationType,
      ParallelismUpdate: flink.parallelismConfiguration.parallelism,
      ParallelismPerKPUUpdate: flink.parallelismConfiguration.parallelismPerKPU,
      AutoScalingEnabledUpdate:
        flink.parallelismConfiguration.autoScalingEnabled,
    };
  }
  return Object.keys(update).length > 0 ? update : undefined;
};

export const ApplicationProvider = () =>
  Provider.effect(
    Application,
    Effect.gen(function* () {
      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      // Ensure the synthesized IAM role exists and its inline policy matches
      // the desired access. `createRole` tolerates the already-exists race;
      // `putRolePolicy` is an idempotent upsert, so the policy re-converges
      // on every reconcile (e.g. after the code bucket changes or a VPC
      // configuration is added).
      const ensureRole = Effect.fn(function* ({
        id,
        roleName,
        codeBucketArn,
        vpc,
      }: {
        id: string;
        roleName: string;
        codeBucketArn: string;
        vpc: ApplicationVpcProps | undefined;
      }) {
        const tags = yield* createInternalTags(id);
        yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "kinesisanalytics.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }),
            ),
          );

        const statements: PolicyStatement[] = [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:GetObjectVersion"],
            Resource: [`${codeBucketArn}/*`],
          },
          {
            Effect: "Allow",
            Action: ["s3:GetBucketLocation", "s3:ListBucket"],
            Resource: [codeBucketArn],
          },
          {
            // Log stream ARNs are attached after the application exists (via
            // ApplicationCloudWatchLoggingOption), so log delivery is granted
            // broadly rather than per-stream.
            Effect: "Allow",
            Action: [
              "logs:DescribeLogGroups",
              "logs:DescribeLogStreams",
              "logs:PutLogEvents",
            ],
            Resource: ["*"],
          },
        ];
        if (vpc) {
          statements.push({
            // ENI management for VPC-attached applications has no
            // resource-level IAM support.
            Effect: "Allow",
            Action: [
              "ec2:CreateNetworkInterface",
              "ec2:CreateNetworkInterfacePermission",
              "ec2:DeleteNetworkInterface",
              "ec2:DescribeNetworkInterfaces",
              "ec2:DescribeVpcs",
              "ec2:DescribeSubnets",
              "ec2:DescribeSecurityGroups",
              "ec2:DescribeDhcpOptions",
            ],
            Resource: ["*"],
          });
        }

        yield* iam.putRolePolicy({
          RoleName: roleName,
          PolicyName: roleName,
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: statements,
          }),
        });
      });

      return Application.Provider.of({
        stables: [
          "applicationName",
          "applicationArn",
          "applicationMode",
          "roleName",
        ],

        // Enumerate every application in the ambient account/region and
        // hydrate each summary into the `read` shape with bounded
        // concurrency, dropping applications that vanish mid-flight.
        list: () =>
          Effect.gen(function* () {
            const summaries = Array.from(
              yield* analytics.listApplications
                .items({})
                .pipe(Stream.runCollect),
            );
            const hydrated = yield* Effect.forEach(
              summaries,
              (summary) =>
                readApplication({
                  applicationName: summary.ApplicationName,
                  roleName: undefined,
                }),
              { concurrency: 10 },
            );
            return hydrated.filter(
              (attrs): attrs is Application["Attributes"] =>
                attrs !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const applicationName =
            output?.applicationName ??
            (yield* createApplicationName(id, olds ?? {}));
          const state = yield* readApplication({
            applicationName,
            roleName: output?.roleName,
          });
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createApplicationName(id, olds ?? {});
          const newName = yield* createApplicationName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // The mode is immutable.
          if (
            (olds?.applicationMode ?? "STREAMING") !==
            (news?.applicationMode ?? "STREAMING")
          ) {
            return { action: "replace" } as const;
          }
          // The API offers no UpdateApplication field for the description.
          if ((olds?.description ?? "") !== (news?.description ?? "")) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;

          if (!news?.code?.bucketArn || !news.code.fileKey) {
            return yield* Effect.fail(
              new ApplicationValidationError({
                message: `Application "${id}" requires code.bucketArn and code.fileKey`,
              }),
            );
          }

          const applicationName =
            output?.applicationName ?? (yield* createApplicationName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Synthesize the IAM role when the caller didn't supply one.
          const roleName = news.serviceExecutionRole
            ? undefined
            : (output?.roleName ?? (yield* createRoleName(id)));
          const serviceExecutionRole =
            news.serviceExecutionRole ??
            `arn:aws:iam::${accountId}:role/${roleName}`;
          if (roleName) {
            yield* ensureRole({
              id,
              roleName,
              codeBucketArn: news.code.bucketArn,
              vpc: news.vpc,
            });
          }

          // 1. OBSERVE — cloud state is authoritative; `output` is only a
          // cache for the physical name.
          const observed = yield* describeApplicationDetail(applicationName);

          // 2. ENSURE — create the application if it's missing. Tolerate the
          // already-exists race (`ResourceInUseException`), retry through the
          // fresh role's IAM propagation window, and retry
          // `ConcurrentModificationException` — recreating an application
          // under a recently-deleted name fails with "Tags are already
          // registered for this resource ARN ... please retry later".
          if (observed === undefined) {
            const createRequest: analytics.CreateApplicationRequest = {
              ApplicationName: applicationName,
              ApplicationDescription: news.description,
              RuntimeEnvironment: news.runtimeEnvironment,
              ApplicationMode: news.applicationMode,
              ServiceExecutionRole: serviceExecutionRole,
              ApplicationConfiguration: {
                ApplicationCodeConfiguration: {
                  CodeContentType: "ZIPFILE",
                  CodeContent: {
                    S3ContentLocation: {
                      BucketARN: news.code.bucketArn,
                      FileKey: news.code.fileKey,
                      ObjectVersion: news.code.objectVersion,
                    },
                  },
                },
                EnvironmentProperties: news.environmentProperties
                  ? {
                      PropertyGroups: toWirePropertyGroups(
                        news.environmentProperties,
                      ),
                    }
                  : undefined,
                FlinkApplicationConfiguration: toFlinkConfiguration(
                  news.flinkConfiguration,
                ),
                ApplicationSnapshotConfiguration:
                  news.snapshotsEnabled !== undefined
                    ? { SnapshotsEnabled: news.snapshotsEnabled }
                    : undefined,
                VpcConfigurations: news.vpc
                  ? [
                      {
                        SubnetIds: news.vpc.subnetIds,
                        SecurityGroupIds: news.vpc.securityGroupIds,
                      },
                    ]
                  : undefined,
              },
              Tags: createTagsList(desiredTags),
            };
            const create = (request: analytics.CreateApplicationRequest) =>
              retryWhileInUse(
                retryThroughRolePropagation(
                  analytics
                    .createApplication(request)
                    .pipe(
                      Effect.catchTag(
                        "ResourceInUseException",
                        () => Effect.void,
                      ),
                    ),
                ),
              );
            yield* create(createRequest).pipe(
              // The lingering tag registration on a recently-deleted name can
              // outlive the bounded retry window. AWS's own guidance in the
              // error text: create without tags, then TagResource — the tag
              // sync below applies the desired tags right after.
              Effect.catchTag("ConcurrentModificationException", () =>
                create({ ...createRequest, Tags: undefined }),
              ),
            );
            yield* session.note(`Creating application ${applicationName}...`);
          }

          // Both a fresh create and a crashed prior run land here — wait for
          // a stable status before syncing (bounded).
          yield* waitForApplicationStable(applicationName);

          // 3. SYNC — read OBSERVED state fresh on every attempt (the
          // version id is a compare-and-set token), compute the delta from
          // `news`, and apply a single UpdateApplication call. Retried
          // through ConcurrentModification/ResourceInUse with a re-read.
          const syncConfiguration = Effect.gen(function* () {
            const detail = yield* describeApplicationDetail(applicationName);
            if (!detail) return;
            const config = detail.ApplicationConfigurationDescription;

            const configurationUpdate: analytics.ApplicationConfigurationUpdate =
              {};

            const observedCode =
              config?.ApplicationCodeConfigurationDescription
                ?.CodeContentDescription?.S3ApplicationCodeLocationDescription;
            if (
              observedCode?.BucketARN !== news.code.bucketArn ||
              observedCode?.FileKey !== news.code.fileKey ||
              (news.code.objectVersion !== undefined &&
                observedCode?.ObjectVersion !== news.code.objectVersion)
            ) {
              configurationUpdate.ApplicationCodeConfigurationUpdate = {
                CodeContentTypeUpdate: "ZIPFILE",
                CodeContentUpdate: {
                  S3ContentLocationUpdate: {
                    BucketARNUpdate: news.code.bucketArn,
                    FileKeyUpdate: news.code.fileKey,
                    ObjectVersionUpdate: news.code.objectVersion,
                  },
                },
              };
            }

            if (
              news.environmentProperties !== undefined &&
              canonicalPropertyGroups(
                toWirePropertyGroups(news.environmentProperties),
              ) !==
                canonicalPropertyGroups(
                  config?.EnvironmentPropertyDescriptions
                    ?.PropertyGroupDescriptions,
                )
            ) {
              configurationUpdate.EnvironmentPropertyUpdates = {
                PropertyGroups: toWirePropertyGroups(
                  news.environmentProperties,
                ),
              };
            }

            if (news.flinkConfiguration) {
              const flinkUpdate = toFlinkConfigurationUpdate(
                news.flinkConfiguration,
                config?.FlinkApplicationConfigurationDescription,
              );
              if (flinkUpdate) {
                configurationUpdate.FlinkApplicationConfigurationUpdate =
                  flinkUpdate;
              }
            }

            if (
              news.snapshotsEnabled !== undefined &&
              news.snapshotsEnabled !==
                config?.ApplicationSnapshotConfigurationDescription
                  ?.SnapshotsEnabled
            ) {
              configurationUpdate.ApplicationSnapshotConfigurationUpdate = {
                SnapshotsEnabledUpdate: news.snapshotsEnabled,
              };
            }

            const observedVpc = config?.VpcConfigurationDescriptions?.[0];
            if (
              news.vpc &&
              observedVpc &&
              (!sameStringSet(news.vpc.subnetIds, observedVpc.SubnetIds) ||
                !sameStringSet(
                  news.vpc.securityGroupIds,
                  observedVpc.SecurityGroupIds,
                ))
            ) {
              configurationUpdate.VpcConfigurationUpdates = [
                {
                  VpcConfigurationId: observedVpc.VpcConfigurationId,
                  SubnetIdUpdates: news.vpc.subnetIds,
                  SecurityGroupIdUpdates: news.vpc.securityGroupIds,
                },
              ];
            }

            const update: analytics.UpdateApplicationRequest = {
              ApplicationName: applicationName,
              CurrentApplicationVersionId: detail.ApplicationVersionId,
            };
            let dirty = false;
            if (Object.keys(configurationUpdate).length > 0) {
              update.ApplicationConfigurationUpdate = configurationUpdate;
              dirty = true;
            }
            if (news.runtimeEnvironment !== detail.RuntimeEnvironment) {
              update.RuntimeEnvironmentUpdate = news.runtimeEnvironment;
              dirty = true;
            }
            if (serviceExecutionRole !== detail.ServiceExecutionRole) {
              update.ServiceExecutionRoleUpdate = serviceExecutionRole;
              dirty = true;
            }
            if (!dirty) return;

            yield* retryThroughRolePropagation(
              analytics.updateApplication(update),
            );
            yield* session.note(
              `Updated application configuration for ${applicationName}`,
            );
          });
          yield* retryWhileInUse(syncConfiguration);
          yield* waitForApplicationStable(applicationName);

          // 3b. SYNC maintenance window — separate API from
          // UpdateApplication; only applied when the caller pins a window
          // (otherwise the service-assigned window is left as-is).
          if (news.maintenanceWindowStartTime !== undefined) {
            const syncMaintenanceWindow = Effect.gen(function* () {
              const detail = yield* describeApplicationDetail(applicationName);
              if (!detail) return;
              const observedStart =
                detail.ApplicationMaintenanceConfigurationDescription
                  ?.ApplicationMaintenanceWindowStartTime;
              if (observedStart === news.maintenanceWindowStartTime) return;
              yield* analytics.updateApplicationMaintenanceConfiguration({
                ApplicationName: applicationName,
                ApplicationMaintenanceConfigurationUpdate: {
                  ApplicationMaintenanceWindowStartTimeUpdate:
                    news.maintenanceWindowStartTime!,
                },
              });
              yield* session.note(
                `Updated maintenance window for ${applicationName}`,
              );
            });
            yield* retryWhileInUse(syncMaintenanceWindow);
          }

          // 3c. SYNC VPC attach/detach — separate APIs from
          // UpdateApplication; each re-reads the fresh version id.
          const syncVpcAttachment = Effect.gen(function* () {
            const detail = yield* describeApplicationDetail(applicationName);
            if (!detail) return;
            const observedVpcs =
              detail.ApplicationConfigurationDescription
                ?.VpcConfigurationDescriptions ?? [];
            if (news.vpc && observedVpcs.length === 0) {
              yield* analytics.addApplicationVpcConfiguration({
                ApplicationName: applicationName,
                CurrentApplicationVersionId: detail.ApplicationVersionId,
                VpcConfiguration: {
                  SubnetIds: news.vpc.subnetIds,
                  SecurityGroupIds: news.vpc.securityGroupIds,
                },
              });
              yield* session.note(
                `Attached VPC configuration to ${applicationName}`,
              );
            } else if (!news.vpc && observedVpcs[0]?.VpcConfigurationId) {
              yield* analytics.deleteApplicationVpcConfiguration({
                ApplicationName: applicationName,
                CurrentApplicationVersionId: detail.ApplicationVersionId,
                VpcConfigurationId: observedVpcs[0].VpcConfigurationId,
              });
              yield* session.note(
                `Detached VPC configuration from ${applicationName}`,
              );
            }
          });
          yield* retryWhileInUse(syncVpcAttachment);
          const stable = yield* waitForApplicationStable(applicationName);

          // 3d. SYNC run state — start when `start: true`, force-stop a
          // running application when `start` is absent/false.
          if (news.start === true && stable.ApplicationStatus !== "RUNNING") {
            yield* retryWhileInUse(
              analytics.startApplication({
                ApplicationName: applicationName,
              }),
            );
            yield* session.note(`Starting application ${applicationName}...`);
            yield* waitForApplicationRunning(applicationName);
          } else if (
            news.start !== true &&
            (stable.ApplicationStatus === "RUNNING" ||
              stable.ApplicationStatus === "AUTOSCALING")
          ) {
            yield* retryWhileInUse(
              analytics.stopApplication({
                ApplicationName: applicationName,
                Force: true,
              }),
            );
            yield* session.note(`Stopping application ${applicationName}...`);
            yield* waitForApplicationStopped(applicationName);
          }

          // 3e. SYNC TAGS — diff against OBSERVED cloud tags (adoption may
          // bring an application with foreign tags), never olds/output.
          const applicationArn = stable.ApplicationARN;
          const observedTagsResponse = yield* analytics
            .listTagsForResource({ ResourceARN: applicationArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const observedTags = toTagRecord(observedTagsResponse?.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (removed.length > 0) {
            yield* retryWhileInUse(
              analytics.untagResource({
                ResourceARN: applicationArn,
                TagKeys: removed,
              }),
            );
          }
          if (upsert.length > 0) {
            yield* retryWhileInUse(
              analytics.tagResource({
                ResourceARN: applicationArn,
                Tags: upsert,
              }),
            );
          }

          yield* session.note(applicationArn);

          // Clean up a previously-synthesized role once the application has
          // been switched to a user-supplied `serviceExecutionRole` (the
          // sync above already re-pointed the app at the new role).
          if (!roleName && output?.roleName) {
            yield* deleteRoleIfExists(output.roleName);
          }

          // 4. RETURN fresh attributes reflecting post-sync cloud state.
          const final = yield* readApplication({ applicationName, roleName });
          if (!final) {
            return yield* Effect.fail(
              new ApplicationValidationError({
                message: `failed to read reconciled application ${applicationName}`,
              }),
            );
          }
          return final;
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteApplication requires the application's CreateTimestamp —
          // observe it fresh rather than trusting persisted state. Missing
          // application means the delete already happened.
          const detail = yield* describeApplicationDetail(
            output.applicationName,
          );
          if (detail?.CreateTimestamp) {
            yield* retryWhileInUse(
              analytics
                .deleteApplication({
                  ApplicationName: output.applicationName,
                  CreateTimestamp: detail.CreateTimestamp,
                })
                .pipe(
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                ),
            );
            yield* waitForApplicationDeleted(output.applicationName);
          }

          // Remove the synthesized IAM role (idempotent — it may already be
          // gone from a previous partial delete).
          if (output.roleName) {
            yield* deleteRoleIfExists(output.roleName);
          }
        }),
      });
    }),
  );

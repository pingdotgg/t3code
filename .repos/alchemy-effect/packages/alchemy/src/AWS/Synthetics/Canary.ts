import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as iam from "@distilled.cloud/aws/iam";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as synthetics from "@distilled.cloud/aws/synthetics";
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
} from "../../Tags.ts";
import { toWireDays, toWireSeconds } from "../../Util/Duration.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface CanaryProps {
  /**
   * Name of the canary. Must be lowercase, up to 255 characters, and match
   * `^[0-9a-z_-]+$`. Keep it to 21 characters or fewer so the derived Lambda
   * function name (`cwsyn-<name>-...`) stays within limits.
   * @default ${app}-${id}-${stage}-${suffix} (lowercased, truncated to 21 chars)
   */
  canaryName?: string;
  /**
   * Inline canary script source. For Node.js runtimes
   * (`syn-nodejs-puppeteer-*`, `syn-nodejs-playwright-*`) the script is
   * packaged as `nodejs/node_modules/<file>.js`; for Python runtimes
   * (`syn-python-selenium-*`) as `python/<file>.py`, where `<file>` is the
   * first segment of `handler`.
   */
  script: string;
  /**
   * The entry point of the canary script, `<fileName>.<functionName>`.
   * @default "index.handler"
   */
  handler?: string;
  /**
   * The Synthetics runtime version to use.
   * @default "syn-nodejs-puppeteer-16.1"
   */
  runtimeVersion?: string;
  /**
   * S3 location where the canary stores run artifacts (screenshots, HAR
   * files, logs), e.g. `s3://my-bucket/canary-artifacts`. The `s3://` prefix
   * is added automatically if missing.
   */
  artifactS3Location: string;
  /**
   * ARN of the IAM role the canary's Lambda assumes. When omitted, a role is
   * created automatically with write access to the artifact bucket,
   * CloudWatch Logs, and the `CloudWatchSynthetics` metric namespace.
   */
  executionRoleArn?: string;
  /**
   * How often the canary runs.
   */
  schedule?: {
    /**
     * A `rate(...)` expression (`rate(1 minute)` to `rate(1 hour)`), a
     * `cron(...)` expression, or `rate(0 minute)` to run only once when
     * started.
     * @default "rate(5 minutes)"
     */
    expression?: string;
    /**
     * How long the canary keeps running on this schedule after it starts
     * (up to 1 year), e.g. `"12 hours"` or `Duration.hours(12)` (a bare
     * number is milliseconds). Rounded to whole seconds on the wire.
     * `"0 seconds"` (or omitted) runs the canary continuously.
     */
    duration?: Duration.Input;
  };
  /**
   * Whether the canary is started (scheduled to run) after deployment.
   * When `false`, the canary is created in the `READY` state and never runs
   * until started.
   * @default false
   */
  start?: boolean;
  /**
   * Per-run configuration of the canary's Lambda.
   */
  runConfig?: {
    /**
     * Run timeout (max 840 seconds), e.g. `"60 seconds"` or
     * `Duration.minutes(1)` (a bare number is milliseconds). Rounded to
     * whole seconds on the wire. Defaults to the schedule frequency
     * capped at 14 minutes.
     */
    timeout?: Duration.Input;
    /**
     * Memory in MB (multiple of 64, between 960 and 3008).
     */
    memoryInMB?: number;
    /**
     * Enable X-Ray active tracing for canary runs.
     * @default false
     */
    activeTracing?: boolean;
    /**
     * Environment variables exposed to the canary script. Not observable
     * from the API after creation.
     */
    environmentVariables?: Record<string, string>;
  };
  /**
   * How long to retain data on successful runs (1 - 455 days), e.g.
   * `"7 days"` or `Duration.days(7)` (a bare number is milliseconds).
   * Rounded to whole days on the wire.
   * @default 31 days
   */
  successRetentionPeriod?: Duration.Input;
  /**
   * How long to retain data on failed runs (1 - 455 days), e.g.
   * `"31 days"` or `Duration.days(31)` (a bare number is milliseconds).
   * Rounded to whole days on the wire.
   * @default 31 days
   */
  failureRetentionPeriod?: Duration.Input;
  /**
   * Run the canary inside a VPC. Both fields are required together.
   */
  vpcConfig?: {
    /** Subnet IDs the canary's ENIs are placed in. */
    subnetIds: string[];
    /** Security group IDs applied to the canary's ENIs. */
    securityGroupIds: string[];
  };
  /**
   * Whether the Lambda function and layers backing the canary are deleted
   * automatically when the canary is deleted.
   * @default "AUTOMATIC"
   */
  provisionedResourceCleanup?: "AUTOMATIC" | "OFF";
  /**
   * Tags to apply to the canary. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Canary extends Resource<
  "AWS.Synthetics.Canary",
  CanaryProps,
  {
    /**
     * Physical name of the canary.
     */
    canaryName: string;
    /**
     * ARN of the canary.
     */
    canaryArn: string;
    /**
     * Service-assigned unique ID of the canary.
     */
    canaryId: string;
    /**
     * ARN of the IAM role the canary runs as.
     */
    executionRoleArn: string;
    /**
     * S3 location where run artifacts (screenshots, HAR files, logs) land.
     */
    artifactS3Location: string;
    /**
     * Synthetics runtime version the canary executes on.
     */
    runtimeVersion: string;
    /** Name of the auto-created execution role; `undefined` when the user supplied `executionRoleArn`. */
    roleName: string | undefined;
    /** Hash of the last-applied desired configuration; used to skip no-op updates. */
    configHash: string | undefined;
    /** Exact ARN of the service-created Lambda function backing the canary. */
    engineArn: string | undefined;
  },
  {},
  Providers
> {}

/**
 * A CloudWatch Synthetics canary — a scripted probe that monitors your
 * endpoints and APIs on a schedule from the outside in.
 *
 * The canary script is provided inline and packaged automatically for the
 * chosen runtime. Unless you pass `executionRoleArn`, an IAM execution role
 * is created with least-privilege access to the artifact bucket, CloudWatch
 * Logs, and Synthetics metrics.
 * @resource
 * @section Creating Canaries
 * @example Heartbeat Canary (created stopped)
 * ```typescript
 * import * as Synthetics from "alchemy/AWS/Synthetics";
 *
 * const canary = yield* Synthetics.Canary("Heartbeat", {
 *   script: `
 *     const synthetics = require("Synthetics");
 *     exports.handler = async () => {
 *       return await synthetics.executeStep("heartbeat", async () => {});
 *     };
 *   `,
 *   artifactS3Location: Output.interpolate`s3://${bucket.bucketName}/canary`,
 * });
 * ```
 *
 * @example Started Canary on a Schedule
 * ```typescript
 * const canary = yield* Synthetics.Canary("ApiMonitor", {
 *   script: myCanaryScript,
 *   artifactS3Location: "s3://my-artifacts/api-monitor",
 *   schedule: { expression: "rate(5 minutes)" },
 *   start: true,
 * });
 * ```
 *
 * @section Configuration
 * @example Custom Runtime, Timeout and Environment
 * ```typescript
 * const canary = yield* Synthetics.Canary("Checkout", {
 *   script: checkoutScript,
 *   runtimeVersion: "syn-nodejs-puppeteer-16.1",
 *   artifactS3Location: "s3://my-artifacts/checkout",
 *   runConfig: {
 *     timeout: "60 seconds",
 *     environmentVariables: { TARGET_URL: "https://example.com" },
 *   },
 *   successRetentionPeriod: "7 days",
 *   failureRetentionPeriod: "31 days",
 * });
 * ```
 *
 * @example Bring Your Own Execution Role
 * ```typescript
 * const canary = yield* Synthetics.Canary("Probe", {
 *   script: probeScript,
 *   artifactS3Location: "s3://my-artifacts/probe",
 *   executionRoleArn: role.roleArn,
 * });
 * ```
 */
export const Canary = Resource<Canary>("AWS.Synthetics.Canary");

const DEFAULT_RUNTIME_VERSION = "syn-nodejs-puppeteer-16.1";
const DEFAULT_SCHEDULE_EXPRESSION = "rate(5 minutes)";
const ROLE_POLICY_NAME = "AlchemyCanaryPolicy";
const VPC_ACCESS_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";

/**
 * Canary create/update/start/stop are asynchronous; the canary reports a
 * transitional state while converging. Raised internally to drive the
 * bounded settle-polling retry loop.
 */
export class CanaryNotSettled extends Data.TaggedError("CanaryNotSettled")<{
  canaryName: string;
  state: string | undefined;
}> {}

/**
 * Raised when a canary lands in the `ERROR` state after a create or update
 * instead of converging to `READY`/`STOPPED`.
 */
export class CanaryFailed extends Data.TaggedError("CanaryFailed")<{
  canaryName: string;
  stateReasonCode: string | undefined;
  message: string;
}> {}

class CanaryBackingResourceStillVisible extends Data.TaggedError(
  "CanaryBackingResourceStillVisible",
)<{
  readonly canaryName: string;
  readonly resource: "LambdaFunction" | "LogGroup";
  readonly identifier: string;
}> {}

class UnexpectedCanaryEngineArn extends Data.TaggedError(
  "UnexpectedCanaryEngineArn",
)<{
  readonly canaryName: string;
  readonly engineArn: string;
}> {}

const TRANSITIONAL_STATES = [
  "CREATING",
  "UPDATING",
  "STARTING",
  "STOPPING",
  "DELETING",
];

/**
 * Retry an operation while the canary is briefly locked by a concurrent
 * state transition (`ConflictException`), on a bounded schedule (~60s).
 * Module-scope with an explicit return type so the conditional `Retry.Return`
 * type never leaks into declaration emit (which would widen the provider
 * layer to `unknown`).
 */
const retryWhileConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

const parseArtifactLocation = (location: string) => {
  const stripped = location.startsWith("s3://") ? location.slice(5) : location;
  return {
    artifactS3Location: `s3://${stripped}`,
    artifactBucket: stripped.split("/")[0]!,
  };
};

const scriptFilePath = (runtimeVersion: string, handler: string) => {
  const fileName = handler.split(".")[0]!;
  return runtimeVersion.startsWith("syn-python")
    ? `python/${fileName}.py`
    : `nodejs/node_modules/${fileName}.js`;
};

/** Package the inline script as the zip layout the runtime expects. */
const buildCode = Effect.fn(function* (
  script: string,
  handler: string,
  runtimeVersion: string,
) {
  const zip = new (yield* Effect.promise(() => import("jszip"))).default();
  // constant date for a deterministic archive
  const date = new Date("1980-01-01T00:00:00.000Z");
  zip.file(scriptFilePath(runtimeVersion, handler), script, { date });
  const buffer = yield* Effect.promise(() =>
    zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      platform: "UNIX",
    }),
  );
  return {
    ZipFile: new Uint8Array(buffer),
    Handler: handler,
  } satisfies synthetics.CanaryCodeInput;
});

const filterTags = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const CanaryProvider = () =>
  Provider.effect(
    Canary,
    Effect.gen(function* () {
      const createCanaryName = Effect.fn(function* (
        id: string,
        props: { canaryName?: string | undefined },
      ) {
        if (props.canaryName) return props.canaryName;
        // Canary names must be lowercase [0-9a-z_-]; the console caps them at
        // 21 chars because the backing Lambda is named `cwsyn-<name>-<uuid>`.
        return yield* createPhysicalName({
          id,
          maxLength: 21,
          suffixLength: 8,
          lowercase: true,
        });
      });

      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      const canaryArnOf = Effect.fn(function* (canaryName: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return `arn:aws:synthetics:${region}:${accountId}:canary:${canaryName}`;
      });

      const getCanaryOrUndefined = Effect.fn(function* (canaryName: string) {
        return yield* synthetics.getCanary({ Name: canaryName }).pipe(
          Effect.map((r) => r.Canary),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      // Poll until the canary leaves its transitional state. Create typically
      // settles in 30-90s; budget 3 minutes (60 * 3s).
      const waitForSettled = Effect.fn(function* (canaryName: string) {
        return yield* getCanaryOrUndefined(canaryName).pipe(
          Effect.flatMap((canary) =>
            canary !== undefined &&
            TRANSITIONAL_STATES.includes(canary.Status?.State ?? "")
              ? Effect.fail(
                  new CanaryNotSettled({
                    canaryName,
                    state: canary.Status?.State,
                  }),
                )
              : Effect.succeed(canary),
          ),
          Effect.retry({
            while: (e) => e instanceof CanaryNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });

      const failIfErrored = (
        canaryName: string,
        canary: synthetics.Canary | undefined,
      ) =>
        canary?.Status?.State === "ERROR"
          ? Effect.fail(
              new CanaryFailed({
                canaryName,
                stateReasonCode: canary.Status?.StateReasonCode,
                message:
                  canary.Status?.StateReason ??
                  `canary ${canaryName} is in ERROR state`,
              }),
            )
          : Effect.void;

      // Deletion is asynchronous (DELETING); wait until gone so a
      // destroy-then-deploy of the same logical resource (same physical
      // name) does not race the pending delete.
      const waitUntilGone = Effect.fn(function* (canaryName: string) {
        yield* getCanaryOrUndefined(canaryName).pipe(
          Effect.flatMap((canary) =>
            canary === undefined
              ? Effect.void
              : Effect.fail(
                  new CanaryNotSettled({
                    canaryName,
                    state: canary.Status?.State,
                  }),
                ),
          ),
          Effect.retry({
            while: (e) => e instanceof CanaryNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(40),
            ]),
          }),
        );
      });

      // Stop (if running) + delete + wait-until-gone. Also used by reconcile
      // to self-heal a canary stuck in CREATE_FAILED.
      const deleteCanaryAndWait = Effect.fn(function* (canaryName: string) {
        const observed = yield* getCanaryOrUndefined(canaryName);
        if (observed === undefined) return;
        const state = observed.Status?.State;
        if (state === "RUNNING" || state === "STARTING") {
          yield* synthetics
            .stopCanary({ Name: canaryName })
            .pipe(
              Effect.catchTag(
                ["ResourceNotFoundException", "ConflictException"],
                () => Effect.void,
              ),
            );
        }
        // wait out any transitional state (STOPPING, UPDATING, ...) — a
        // canary can only be deleted from READY/STOPPED/ERROR.
        yield* waitForSettled(canaryName);
        yield* synthetics
          .deleteCanary({ Name: canaryName, DeleteLambda: true })
          .pipe(
            // e.g. a run is still finishing; bounded retry
            retryWhileConflict,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        yield* waitUntilGone(canaryName);
      });

      const backingFunctionName = (canaryName: string, engineArn: string) => {
        const marker = ":function:";
        const markerIndex = engineArn.indexOf(marker);
        const functionName =
          markerIndex === -1
            ? undefined
            : engineArn.slice(markerIndex + marker.length).split(":")[0];
        // EngineArn is observed directly from this owned canary. Retain an
        // explicit name check so a malformed or unexpectedly-shaped response
        // can never make deletion target another Lambda.
        return functionName?.startsWith(`cwsyn-${canaryName}-`)
          ? Effect.succeed(functionName)
          : Effect.fail(
              new UnexpectedCanaryEngineArn({ canaryName, engineArn }),
            );
      };

      const discoverBackingFunctionNames = Effect.fn(function* (
        canaryName: string,
        engineArn: string | undefined,
      ) {
        if (engineArn) {
          return [yield* backingFunctionName(canaryName, engineArn)];
        }

        // EngineArn is optional and is absent on some Synthetics runtimes.
        // The backing Lambda's only observable relationship is its service
        // name. Require the complete canonical UUID suffix so a canary named
        // `foo` can never capture another named `foo-bar`.
        const escapedCanaryName = canaryName.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const exactBackingName = new RegExp(
          `^cwsyn-${escapedCanaryName}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
          "i",
        );
        const pages = yield* lambda.listFunctions
          .pages({})
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.Functions ?? [])
          .flatMap((fn) =>
            fn.FunctionName && exactBackingName.test(fn.FunctionName)
              ? [fn.FunctionName]
              : [],
          );
      });

      const backingFunctionExists = (functionName: string) =>
        lambda.getFunction({ FunctionName: functionName }).pipe(
          Effect.as(true),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(false),
          ),
        );

      const exactLogGroupExists = (logGroupName: string) =>
        logs
          .describeLogGroups({
            logGroupNamePrefix: logGroupName,
            limit: 50,
          })
          .pipe(
            Effect.map((response) =>
              (response.logGroups ?? []).some(
                (group) => group.logGroupName === logGroupName,
              ),
            ),
          );

      const waitForBackingResourceGone = (
        canaryName: string,
        resource: "LambdaFunction" | "LogGroup",
        identifier: string,
        exists: Effect.Effect<boolean, any, any>,
      ) =>
        exists.pipe(
          Effect.flatMap((visible) =>
            visible
              ? Effect.fail(
                  new CanaryBackingResourceStillVisible({
                    canaryName,
                    resource,
                    identifier,
                  }),
                )
              : Effect.void,
          ),
          Effect.retry({
            while: (error) =>
              error._tag === "CanaryBackingResourceStillVisible",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(20),
            ]),
          }),
        );

      const deleteBackingResources = Effect.fn(function* (
        canaryName: string,
        functionName: string,
      ) {
        const logGroupName = `/aws/lambda/${functionName}`;

        yield* lambda.deleteFunction({ FunctionName: functionName }).pipe(
          Effect.retry({
            while: (error) => error._tag === "ResourceConflictException",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(20),
            ]),
          }),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        );
        yield* waitForBackingResourceGone(
          canaryName,
          "LambdaFunction",
          functionName,
          backingFunctionExists(functionName),
        );

        // Lambda never owns its log group lifecycle. A just-finished
        // invocation can flush its final stream after Lambda deletion starts,
        // so reap this exact group across a short quiescence window.
        for (let attempt = 0; attempt < 5; attempt++) {
          if (yield* exactLogGroupExists(logGroupName)) {
            yield* logs.deleteLogGroup({ logGroupName }).pipe(
              Effect.retry({
                while: (error) => error._tag === "OperationAbortedException",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(15),
                ]),
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          }
          yield* Effect.sleep("2 seconds");
        }
        yield* waitForBackingResourceGone(
          canaryName,
          "LogGroup",
          logGroupName,
          exactLogGroupExists(logGroupName),
        );
      });

      /**
       * Ensure the auto-created execution role exists and its inline policy
       * matches the artifact bucket. Every step is idempotent: create
       * tolerates AlreadyExists, putRolePolicy is an upsert.
       */
      const ensureExecutionRole = Effect.fn(function* ({
        id,
        roleName,
        artifactBucket,
        vpc,
      }: {
        id: string;
        roleName: string;
        artifactBucket: string;
        vpc: boolean;
      }) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const internalTags = yield* createInternalTags(id);
        // Track whether we actually created the role on this pass — a fresh
        // role needs a propagation grace period before Synthetics can build
        // the backing Lambda with it.
        let created = true;
        yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "lambda.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(internalTags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              Effect.sync(() => {
                created = false;
              }),
            ),
          );
        yield* iam.putRolePolicy({
          RoleName: roleName,
          PolicyName: ROLE_POLICY_NAME,
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:PutObject", "s3:GetObject"],
                Resource: [`arn:aws:s3:::${artifactBucket}/*`],
              },
              {
                Effect: "Allow",
                Action: ["s3:GetBucketLocation"],
                Resource: [`arn:aws:s3:::${artifactBucket}`],
              },
              {
                Effect: "Allow",
                Action: ["s3:ListAllMyBuckets"],
                Resource: ["*"],
              },
              {
                Effect: "Allow",
                Action: ["cloudwatch:PutMetricData"],
                Resource: ["*"],
                Condition: {
                  StringEquals: {
                    "cloudwatch:namespace": "CloudWatchSynthetics",
                  },
                },
              },
              {
                Effect: "Allow",
                Action: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                ],
                Resource: [
                  `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/cwsyn-*`,
                ],
              },
              {
                Effect: "Allow",
                Action: ["xray:PutTraceSegments"],
                Resource: ["*"],
              },
            ],
          }),
        });
        if (vpc) {
          yield* iam.attachRolePolicy({
            RoleName: roleName,
            PolicyArn: VPC_ACCESS_POLICY_ARN,
          });
        }
        if (created) {
          // IAM is eventually consistent — a canary created immediately after
          // the role lands in CREATE_FAILED with "The role defined for the
          // function cannot be assumed by Lambda". Give the role time to
          // propagate; the CREATE_FAILED recreate loop below covers stragglers.
          yield* Effect.sleep("10 seconds");
        }
        return `arn:aws:iam::${accountId}:role/${roleName}`;
      });

      // Tear down the auto-created execution role. Idempotent: every step
      // tolerates the entity being gone.
      const deleteExecutionRole = Effect.fn(function* (roleName: string) {
        yield* iam
          .deleteRolePolicy({
            RoleName: roleName,
            PolicyName: ROLE_POLICY_NAME,
          })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        yield* iam
          .detachRolePolicy({
            RoleName: roleName,
            PolicyArn: VPC_ACCESS_POLICY_ARN,
          })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        yield* iam.deleteRole({ RoleName: roleName }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "ConcurrentModificationException" ||
              error._tag === "DeleteConflictException" ||
              error._tag === "LimitExceededException" ||
              error._tag === "ServiceFailureException",
            schedule: Schedule.max([
              Schedule.fixed("1 second"),
              Schedule.recurs(20),
            ]),
          }),
          Effect.catchTag("NoSuchEntityException", () => Effect.void),
        );

        // IAM deletion is eventually consistent. Keep the canary's state
        // until its owned execution role is observably absent so a following
        // nuke cannot race the successful DeleteRole request.
        for (let attempt = 0; attempt < 30; attempt++) {
          const remaining = yield* iam
            .getRole({ RoleName: roleName })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (remaining === undefined) return;
          yield* Effect.sleep("1 second");
        }
        return yield* Effect.die(
          new Error(
            `Synthetics execution role ${roleName} remained observable 30 seconds after delete`,
          ),
        );
      });

      const desiredConfigHash = (
        props: CanaryProps,
        executionRoleArn: string,
        artifactS3Location: string,
        runtimeVersion: string,
      ) =>
        sha256Object({
          script: props.script,
          handler: props.handler ?? "index.handler",
          runtimeVersion,
          artifactS3Location,
          executionRoleArn,
          schedule: {
            expression:
              props.schedule?.expression ?? DEFAULT_SCHEDULE_EXPRESSION,
            durationInSeconds: toWireSeconds(props.schedule?.duration) ?? 0,
          },
          runConfig:
            props.runConfig === undefined
              ? {}
              : {
                  ...props.runConfig,
                  timeout: undefined,
                  timeoutInSeconds: toWireSeconds(props.runConfig.timeout),
                },
          successRetentionPeriodInDays: toWireDays(
            props.successRetentionPeriod,
          ),
          failureRetentionPeriodInDays: toWireDays(
            props.failureRetentionPeriod,
          ),
          vpcConfig: props.vpcConfig,
          provisionedResourceCleanup:
            props.provisionedResourceCleanup ?? "AUTOMATIC",
        });

      const toRunConfigInput = (
        props: CanaryProps,
      ): synthetics.CanaryRunConfigInput | undefined =>
        props.runConfig === undefined
          ? undefined
          : {
              TimeoutInSeconds: toWireSeconds(props.runConfig.timeout),
              MemoryInMB: props.runConfig.memoryInMB,
              ActiveTracing: props.runConfig.activeTracing,
              EnvironmentVariables: props.runConfig.environmentVariables,
            };

      const toScheduleInput = (
        props: CanaryProps,
      ): synthetics.CanaryScheduleInput => ({
        Expression: props.schedule?.expression ?? DEFAULT_SCHEDULE_EXPRESSION,
        DurationInSeconds: toWireSeconds(props.schedule?.duration),
      });

      const toVpcConfigInput = (
        props: CanaryProps,
      ): synthetics.VpcConfigInput | undefined =>
        props.vpcConfig === undefined
          ? undefined
          : {
              SubnetIds: props.vpcConfig.subnetIds,
              SecurityGroupIds: props.vpcConfig.securityGroupIds,
            };

      return Canary.Provider.of({
        stables: [
          "canaryName",
          "canaryArn",
          "canaryId",
          "roleName",
          "engineArn",
        ],

        // Enumerate every canary in the ambient account/region.
        list: () =>
          Effect.gen(function* () {
            const pages = yield* synthetics.describeCanaries
              .pages({})
              .pipe(Stream.runCollect);
            const canaries = Array.from(pages).flatMap(
              (page) => page.Canaries ?? [],
            );
            const items: Canary["Attributes"][] = [];
            for (const canary of canaries) {
              if (!canary.Name) continue;
              items.push({
                canaryName: canary.Name,
                canaryArn: yield* canaryArnOf(canary.Name),
                canaryId: canary.Id ?? "",
                executionRoleArn: canary.ExecutionRoleArn ?? "",
                artifactS3Location: canary.ArtifactS3Location
                  ? parseArtifactLocation(canary.ArtifactS3Location)
                      .artifactS3Location
                  : "",
                runtimeVersion: canary.RuntimeVersion ?? "",
                roleName: undefined,
                configHash: undefined,
                engineArn: canary.EngineArn,
              });
            }
            return items;
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const canaryName =
            output?.canaryName ?? (yield* createCanaryName(id, olds ?? {}));
          const canary = yield* getCanaryOrUndefined(canaryName);
          if (canary === undefined) return undefined;
          const attrs: Canary["Attributes"] = {
            canaryName,
            canaryArn: yield* canaryArnOf(canaryName),
            canaryId: canary.Id ?? "",
            executionRoleArn: canary.ExecutionRoleArn ?? "",
            artifactS3Location: canary.ArtifactS3Location
              ? parseArtifactLocation(canary.ArtifactS3Location)
                  .artifactS3Location
              : "",
            runtimeVersion: canary.RuntimeVersion ?? "",
            roleName: output?.roleName,
            configHash: output?.configHash,
            engineArn: canary.EngineArn ?? output?.engineArn,
          };
          const tags = filterTags(canary.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createCanaryName(id, olds);
          const newName = yield* createCanaryName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // everything else converges through updateCanary
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const canaryName =
            output?.canaryName ?? (yield* createCanaryName(id, news));
          const canaryArn = yield* canaryArnOf(canaryName);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const { artifactS3Location, artifactBucket } = parseArtifactLocation(
            news.artifactS3Location,
          );
          const runtimeVersion = news.runtimeVersion ?? DEFAULT_RUNTIME_VERSION;
          const handler = news.handler ?? "index.handler";

          // Ensure the execution role (user-supplied or auto-created, with
          // its inline policy converged to the current artifact bucket).
          let roleName: string | undefined;
          let executionRoleArn: string;
          if (news.executionRoleArn) {
            executionRoleArn = news.executionRoleArn;
          } else {
            roleName = output?.roleName ?? (yield* createRoleName(id));
            executionRoleArn = yield* ensureExecutionRole({
              id,
              roleName,
              artifactBucket,
              vpc: news.vpcConfig !== undefined,
            });
          }

          const configHash = yield* desiredConfigHash(
            news,
            executionRoleArn,
            artifactS3Location,
            runtimeVersion,
          );

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getCanaryOrUndefined(canaryName);

          // Self-heal a canary stuck in CREATE_FAILED (e.g. a crashed prior
          // deploy): it cannot be updated, only deleted and recreated.
          if (
            observed?.Status?.State === "ERROR" &&
            observed.Status?.StateReasonCode === "CREATE_FAILED"
          ) {
            yield* session.note(
              `canary ${canaryName} is in CREATE_FAILED (${observed.Status?.StateReason}); recreating`,
            );
            yield* deleteCanaryAndWait(canaryName);
            observed = undefined;
          }

          // 2. ENSURE — create if missing; wait for the async create to
          // settle (CREATING → READY, typically 30-90s).
          if (observed === undefined) {
            const code = yield* buildCode(news.script, handler, runtimeVersion);
            // Canary creation is asynchronous and validated in the backend:
            // an execution role that hasn't finished propagating surfaces as
            // CREATE_FAILED ("role ... cannot be assumed by Lambda") only
            // AFTER the create settles. A CREATE_FAILED canary can't be
            // updated — delete it and recreate, bounded to 3 attempts.
            for (let attempt = 0; ; attempt++) {
              yield* synthetics.createCanary({
                Name: canaryName,
                Code: code,
                ArtifactS3Location: artifactS3Location,
                ExecutionRoleArn: executionRoleArn,
                Schedule: toScheduleInput(news),
                RunConfig: toRunConfigInput(news),
                RuntimeVersion: runtimeVersion,
                SuccessRetentionPeriodInDays: toWireDays(
                  news.successRetentionPeriod,
                ),
                FailureRetentionPeriodInDays: toWireDays(
                  news.failureRetentionPeriod,
                ),
                VpcConfig: toVpcConfigInput(news),
                ProvisionedResourceCleanup:
                  news.provisionedResourceCleanup ?? "AUTOMATIC",
                Tags: desiredTags,
              });
              yield* session.note(
                `created canary ${canaryName}, waiting for it to become ready`,
              );
              observed = yield* waitForSettled(canaryName);
              if (
                observed?.Status?.State === "ERROR" &&
                observed.Status?.StateReasonCode === "CREATE_FAILED"
              ) {
                // A failed create is not persisted by the engine, so leaving
                // the CREATE_FAILED canary behind would leak it — delete it
                // whether we retry or give up.
                yield* session.note(
                  `canary create failed (${observed.Status?.StateReason}); deleting`,
                );
                yield* deleteCanaryAndWait(canaryName);
                if (attempt < 2) {
                  yield* Effect.sleep("10 seconds");
                  continue;
                }
                // Giving up — the engine does not persist a failed create, so
                // also remove the execution role we auto-created this pass.
                if (roleName !== undefined) {
                  yield* deleteExecutionRole(roleName);
                }
              }
              yield* failIfErrored(canaryName, observed);
              break;
            }
          } else {
            // 3. SYNC config — the script content is not observable from the
            // API (only a source-location ARN), so we use the persisted
            // configHash as a skip-hint; on adoption (no hash) or any prop
            // change we push the full desired configuration, which is
            // idempotent.
            observed = yield* waitForSettled(canaryName);
            yield* failIfErrored(canaryName, observed);
            if (output?.configHash !== configHash) {
              const code = yield* buildCode(
                news.script,
                handler,
                runtimeVersion,
              );
              yield* synthetics
                .updateCanary({
                  Name: canaryName,
                  Code: code,
                  ExecutionRoleArn: executionRoleArn,
                  RuntimeVersion: runtimeVersion,
                  Schedule: toScheduleInput(news),
                  RunConfig: toRunConfigInput(news),
                  SuccessRetentionPeriodInDays: toWireDays(
                    news.successRetentionPeriod,
                  ),
                  FailureRetentionPeriodInDays: toWireDays(
                    news.failureRetentionPeriod,
                  ),
                  VpcConfig: toVpcConfigInput(news),
                  ArtifactS3Location: artifactS3Location,
                  ProvisionedResourceCleanup:
                    news.provisionedResourceCleanup ?? "AUTOMATIC",
                })
                .pipe(retryWhileConflict);
              yield* session.note(`updated canary ${canaryName}`);
              observed = yield* waitForSettled(canaryName);
              yield* failIfErrored(canaryName, observed);
            }
          }

          // 4. SYNC run state — start/stop to match the `start` prop.
          const desiredRunning = news.start ?? false;
          const state = observed?.Status?.State;
          if (desiredRunning && state !== "RUNNING") {
            yield* synthetics
              .startCanary({ Name: canaryName })
              .pipe(retryWhileConflict);
            yield* session.note(`started canary ${canaryName}`);
            observed = yield* waitForSettled(canaryName);
          } else if (!desiredRunning && state === "RUNNING") {
            yield* synthetics
              .stopCanary({ Name: canaryName })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            yield* session.note(`stopped canary ${canaryName}`);
            observed = yield* waitForSettled(canaryName);
          }

          // 5. SYNC tags — diff against OBSERVED cloud tags so adoption
          // converges (create already applied them; update cannot).
          const currentTags = filterTags(observed?.Tags);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* synthetics.tagResource({
              ResourceArn: canaryArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* synthetics.untagResource({
              ResourceArn: canaryArn,
              TagKeys: removed,
            });
          }

          yield* session.note(canaryName);
          return {
            canaryName,
            canaryArn,
            canaryId: observed?.Id ?? "",
            executionRoleArn,
            artifactS3Location,
            runtimeVersion,
            roleName,
            configHash,
            engineArn: observed?.EngineArn,
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const observed = yield* getCanaryOrUndefined(output.canaryName);
          const engineArn = observed?.EngineArn ?? output.engineArn;
          const backingFunctions = yield* discoverBackingFunctionNames(
            output.canaryName,
            engineArn,
          );
          yield* deleteCanaryAndWait(output.canaryName);
          for (const functionName of backingFunctions) {
            yield* session.note(
              `deleting exact backing Lambda ${functionName} and log group /aws/lambda/${functionName}`,
            );
            yield* deleteBackingResources(output.canaryName, functionName);
          }
          // Clean up the auto-created execution role (never a user-supplied
          // one).
          if (output.roleName) {
            yield* deleteExecutionRole(output.roleName);
          }
        }),
      });
    }),
  );

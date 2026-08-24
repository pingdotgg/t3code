import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface WorkflowDefinitionS3Location {
  /**
   * Name of the S3 bucket that holds the workflow definition YAML file.
   */
  bucket: string;
  /**
   * Key of the workflow definition YAML object within the bucket.
   */
  objectKey: string;
  /**
   * Specific S3 object version of the definition to use. Omit to use the
   * latest version.
   */
  versionId?: string;
}

export interface WorkflowEncryptionConfiguration {
  /**
   * How workflow data is encrypted — `"AWS_MANAGED_KEY"` (the default) or
   * `"CUSTOMER_MANAGED_KEY"`.
   *
   * Encryption cannot be changed in place — changing it replaces the
   * workflow.
   * @default "AWS_MANAGED_KEY"
   */
  type: mwaa.EncryptionType;
  /**
   * ID or ARN of the customer managed KMS key to encrypt workflow data
   * with. Required when `type` is `"CUSTOMER_MANAGED_KEY"`.
   */
  kmsKeyId?: string;
}

export interface WorkflowLoggingConfiguration {
  /**
   * Name of the CloudWatch log group that receives task logs for the
   * workflow's runs.
   */
  logGroupName: string;
}

export interface WorkflowNetworkConfiguration {
  /**
   * Security group IDs applied to tasks that access resources inside your
   * VPC.
   */
  securityGroupIds?: string[];
  /**
   * Subnet IDs the workflow's tasks run in when accessing resources inside
   * your VPC.
   */
  subnetIds?: string[];
}

export interface WorkflowProps {
  /**
   * Name of the workflow. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID.
   *
   * Changing the name replaces the workflow.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * S3 location of the workflow definition — a YAML file that defines the
   * DAG structure using supported AWS operators.
   *
   * Updating the definition creates a new workflow version and disables
   * scheduling on all previous versions.
   */
  definitionS3Location: WorkflowDefinitionS3Location;
  /**
   * ARN of the IAM execution role that Amazon MWAA Serverless assumes to
   * run the workflow's tasks. The role's trust policy must allow the
   * `airflow-serverless.amazonaws.com` service principal to assume it.
   */
  roleArn: string;
  /**
   * Human-readable description of the workflow.
   */
  description?: string;
  /**
   * Encryption configuration for workflow data. Omit to use an AWS managed
   * key. Changing encryption replaces the workflow (it cannot be updated
   * in place).
   * @default AWS managed key
   */
  encryptionConfiguration?: WorkflowEncryptionConfiguration;
  /**
   * CloudWatch logging configuration for the workflow's task logs.
   */
  loggingConfiguration?: WorkflowLoggingConfiguration;
  /**
   * Version of the workflow definition engine.
   * @default 1
   */
  engineVersion?: mwaa.EngineVersion;
  /**
   * Network configuration for tasks that access resources inside your VPC.
   */
  networkConfiguration?: WorkflowNetworkConfiguration;
  /**
   * How workflow runs are triggered (for example on a schedule defined in
   * the workflow definition, or only on demand).
   */
  triggerMode?: string;
  /**
   * Tags to apply to the workflow. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Workflow extends Resource<
  "AWS.MWAAServerless.Workflow",
  WorkflowProps,
  {
    /** Name of the workflow. */
    name: string;
    /** ARN of the workflow. */
    workflowArn: string;
    /** Latest workflow version (a new version is published on each update). */
    workflowVersion: string | undefined;
    /** Current lifecycle status of the workflow. */
    workflowStatus: mwaa.WorkflowStatus | undefined;
    /** ARN of the IAM role the workflow's tasks assume. */
    roleArn: string | undefined;
    /** How runs are triggered (e.g. scheduled or on-demand). */
    triggerMode: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Managed Workflows for Apache Airflow **Serverless** workflow —
 * a serverless Airflow DAG defined by a YAML file in S3 and executed by
 * AWS-managed, multi-tenant Airflow infrastructure without provisioning an
 * environment.
 *
 * Each update to the definition or configuration creates a new workflow
 * version; MWAA Serverless keeps only the latest version actively
 * scheduled.
 * @resource
 * @section Creating a Workflow
 * @example Basic Workflow
 * ```typescript
 * import * as MWAAServerless from "alchemy/AWS/MWAAServerless";
 * import * as IAM from "alchemy/AWS/IAM";
 *
 * const role = yield* IAM.Role("WorkflowRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "airflow-serverless.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 * });
 *
 * const workflow = yield* MWAAServerless.Workflow("Etl", {
 *   definitionS3Location: {
 *     bucket: "my-dag-bucket",
 *     objectKey: "workflows/etl.yaml",
 *   },
 *   roleArn: role.roleArn,
 * });
 * ```
 *
 * @example Workflow with Logging and Tags
 * ```typescript
 * const workflow = yield* MWAAServerless.Workflow("Etl", {
 *   definitionS3Location: {
 *     bucket: "my-dag-bucket",
 *     objectKey: "workflows/etl.yaml",
 *   },
 *   roleArn: role.roleArn,
 *   description: "nightly ETL",
 *   loggingConfiguration: { logGroupName: "/mwaa-serverless/etl" },
 *   tags: { team: "data" },
 * });
 * ```
 */
export const Workflow = Resource<Workflow>("AWS.MWAAServerless.Workflow");

/**
 * Bounded retry for `createWorkflow` while a freshly created IAM execution
 * role propagates — the service validates that it can assume the role at
 * create time, which surfaces as a ValidationException/AccessDeniedException
 * mentioning the role for the first seconds of the role's life.
 *
 * Explicitly annotated so the conditional `Retry.Return` type never leaks
 * into declaration emit (it would widen `AWS.providers()` for consumers).
 */
const retryWhileRolePropagates = <A, R>(
  self: Effect.Effect<A, mwaa.CreateWorkflowError, R>,
): Effect.Effect<A, mwaa.CreateWorkflowError, R> =>
  Effect.retry(self, {
    while: (e) =>
      (e._tag === "ValidationException" ||
        e._tag === "AccessDeniedException") &&
      /role/i.test(e.message ?? ""),
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
  });

export const WorkflowProvider = () =>
  Provider.effect(
    Workflow,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<WorkflowProps, "name">,
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      const observeByArn = (arn: string) =>
        mwaa
          .getWorkflow({ WorkflowArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findArnByName = (name: string) =>
        mwaa.listWorkflows.items({}).pipe(
          Stream.runCollect,
          Effect.map(
            (items) =>
              Array.from(items).find((w) => w.Name === name)?.WorkflowArn,
          ),
        );

      const observe = Effect.fn(function* (
        name: string,
        arnHint: string | undefined,
      ) {
        if (arnHint !== undefined) {
          const found = yield* observeByArn(arnHint);
          if (found !== undefined) return found;
        }
        const arn = yield* findArnByName(name);
        return arn === undefined ? undefined : yield* observeByArn(arn);
      });

      const observedTags = (arn: string) =>
        mwaa.listTagsForResource({ ResourceArn: arn }).pipe(
          Effect.map((r) => {
            const tags: Record<string, string> = {};
            for (const [key, value] of Object.entries(r.Tags ?? {})) {
              if (value !== undefined) tags[key] = value;
            }
            return tags;
          }),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const toDefinitionS3Location = (
        location: WorkflowDefinitionS3Location,
      ): mwaa.DefinitionS3Location => ({
        Bucket: location.bucket,
        ObjectKey: location.objectKey,
        VersionId: location.versionId,
      });

      const sameDefinition = (
        live: mwaa.DefinitionS3Location | undefined,
        desired: WorkflowDefinitionS3Location,
      ) =>
        live !== undefined &&
        live.Bucket === desired.bucket &&
        live.ObjectKey === desired.objectKey &&
        (desired.versionId === undefined ||
          live.VersionId === desired.versionId);

      const sameNetwork = (
        live: mwaa.NetworkConfiguration | undefined,
        desired: WorkflowNetworkConfiguration,
      ) =>
        JSON.stringify({
          securityGroupIds: live?.SecurityGroupIds ?? [],
          subnetIds: live?.SubnetIds ?? [],
        }) ===
        JSON.stringify({
          securityGroupIds: desired.securityGroupIds ?? [],
          subnetIds: desired.subnetIds ?? [],
        });

      const toAttributes = (live: mwaa.GetWorkflowResponse, name: string) => ({
        name: live.Name ?? name,
        workflowArn: live.WorkflowArn,
        workflowVersion: live.WorkflowVersion,
        workflowStatus: live.WorkflowStatus,
        roleArn: live.RoleArn,
        triggerMode: live.TriggerMode,
      });

      return Workflow.Provider.of({
        stables: ["name", "workflowArn"],
        list: () =>
          Effect.gen(function* () {
            const items = yield* mwaa.listWorkflows
              .items({})
              .pipe(Stream.runCollect);
            const workflows: {
              name: string;
              workflowArn: string;
              workflowVersion: string | undefined;
              workflowStatus: mwaa.WorkflowStatus | undefined;
              roleArn: string | undefined;
              triggerMode: string | undefined;
            }[] = [];
            for (const item of Array.from(items)) {
              if (item.WorkflowArn === undefined || item.Name === undefined) {
                continue;
              }
              // tolerate delete races between list and get
              const live = yield* observeByArn(item.WorkflowArn);
              if (live !== undefined && live.Name !== undefined) {
                workflows.push(toAttributes(live, live.Name));
              }
            }
            return workflows;
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const live = yield* observe(name, output?.workflowArn);
          if (live === undefined || live.Name === undefined) {
            return undefined;
          }
          const attrs = toAttributes(live, name);
          const tags = yield* observedTags(live.WorkflowArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // Encryption cannot be updated in place — UpdateWorkflow does not
          // accept EncryptionConfiguration.
          const oldEncryption = olds?.encryptionConfiguration;
          const newEncryption = news.encryptionConfiguration;
          if (
            (oldEncryption?.type ?? "AWS_MANAGED_KEY") !==
              (newEncryption?.type ?? "AWS_MANAGED_KEY") ||
            oldEncryption?.kmsKeyId !== newEncryption?.kmsKeyId
          ) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output.workflowArn is
          //    only a cache of the identifier.
          let live = yield* observe(name, output?.workflowArn);

          // 2. ENSURE — create when missing. A ConflictException means a
          //    concurrent create (or a previous run's create whose state
          //    persistence failed) raced us: converge on the workflow with
          //    OUR name if one now exists, otherwise propagate.
          if (live === undefined) {
            live = yield* mwaa
              .createWorkflow({
                Name: name,
                DefinitionS3Location: toDefinitionS3Location(
                  news.definitionS3Location,
                ),
                RoleArn: news.roleArn,
                Description: news.description,
                EncryptionConfiguration:
                  news.encryptionConfiguration === undefined
                    ? undefined
                    : {
                        Type: news.encryptionConfiguration.type,
                        KmsKeyId: news.encryptionConfiguration.kmsKeyId,
                      },
                LoggingConfiguration:
                  news.loggingConfiguration === undefined
                    ? undefined
                    : {
                        LogGroupName: news.loggingConfiguration.logGroupName,
                      },
                EngineVersion: news.engineVersion,
                NetworkConfiguration:
                  news.networkConfiguration === undefined
                    ? undefined
                    : {
                        SecurityGroupIds:
                          news.networkConfiguration.securityGroupIds,
                        SubnetIds: news.networkConfiguration.subnetIds,
                      },
                TriggerMode: news.triggerMode,
                Tags: desiredTags,
              })
              .pipe(
                retryWhileRolePropagates,
                Effect.flatMap((created) => observeByArn(created.WorkflowArn)),
                Effect.catchTag("ConflictException", (error) =>
                  observe(name, undefined).pipe(
                    Effect.flatMap((existing) =>
                      existing === undefined
                        ? Effect.fail(error)
                        : Effect.succeed(existing),
                    ),
                  ),
                ),
              );
          }

          const arn = live?.WorkflowArn ?? output?.workflowArn;

          // 3. SYNC — diff each OBSERVED mutable aspect against the desired
          //    state; UpdateWorkflow requires the definition and role, so
          //    issue one full update when any managed aspect drifted (each
          //    update creates a new workflow version — skip on no-op).
          if (live !== undefined && arn !== undefined) {
            const drifted =
              !sameDefinition(
                live.DefinitionS3Location,
                news.definitionS3Location,
              ) ||
              live.RoleArn !== news.roleArn ||
              (news.description !== undefined &&
                live.Description !== news.description) ||
              (news.loggingConfiguration !== undefined &&
                live.LoggingConfiguration?.LogGroupName !==
                  news.loggingConfiguration.logGroupName) ||
              (news.engineVersion !== undefined &&
                live.EngineVersion !== news.engineVersion) ||
              (news.networkConfiguration !== undefined &&
                !sameNetwork(
                  live.NetworkConfiguration,
                  news.networkConfiguration,
                )) ||
              (news.triggerMode !== undefined &&
                live.TriggerMode !== news.triggerMode);
            if (drifted) {
              yield* mwaa.updateWorkflow({
                WorkflowArn: arn,
                DefinitionS3Location: toDefinitionS3Location(
                  news.definitionS3Location,
                ),
                RoleArn: news.roleArn,
                Description: news.description,
                LoggingConfiguration:
                  news.loggingConfiguration === undefined
                    ? undefined
                    : {
                        LogGroupName: news.loggingConfiguration.logGroupName,
                      },
                EngineVersion: news.engineVersion,
                NetworkConfiguration:
                  news.networkConfiguration === undefined
                    ? undefined
                    : {
                        SecurityGroupIds:
                          news.networkConfiguration.securityGroupIds,
                        SubnetIds: news.networkConfiguration.subnetIds,
                      },
                TriggerMode: news.triggerMode,
              });
              live = (yield* observeByArn(arn)) ?? live;
            }
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (create-time tags only apply on first create).
          if (arn !== undefined) {
            const currentTags = yield* observedTags(arn);
            const { upsert, removed } = diffTags(currentTags, desiredTags);
            if (upsert.length > 0) {
              yield* mwaa.tagResource({
                ResourceArn: arn,
                Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              });
            }
            if (removed.length > 0) {
              yield* mwaa.untagResource({
                ResourceArn: arn,
                TagKeys: removed,
              });
            }
          }

          yield* session.note(name);
          return {
            name: live?.Name ?? name,
            workflowArn: arn!,
            workflowVersion: live?.WorkflowVersion,
            workflowStatus: live?.WorkflowStatus,
            roleArn: live?.RoleArn ?? news.roleArn,
            triggerMode: live?.TriggerMode ?? news.triggerMode,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Omitting WorkflowVersion deletes the workflow and all versions.
          yield* mwaa
            .deleteWorkflow({ WorkflowArn: output.workflowArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          // MWAA Serverless auto-creates a per-workflow log group named
          // `/aws/mwaa-serverless/{name}-{id}/` (the ARN's resource id,
          // which includes the service-assigned 10-char suffix, plus a
          // trailing slash) at CREATE time, and deleteWorkflow does NOT
          // remove it — without this reap every deleted workflow (including
          // the old workflow of a replacement) leaks an orphaned log group.
          // A group with no streams or provably-quiescent ingestion (last
          // ingestion > 2 minutes ago) has no pending flush and deletes in
          // a single call, so routine deletes of never-run workflows stay
          // fast. A group with recent ingestion — or one that does not
          // exist yet — is re-reaped on a short bounded schedule
          // (t=0s / 20s / 40s) to catch a late log flush from the
          // workflow's final runs; each attempt is idempotent.
          const workflowId = output.workflowArn.split(":workflow/")[1];
          if (workflowId !== undefined) {
            const logGroupName = `/aws/mwaa-serverless/${workflowId}/`;
            const reapLogGroup = logs
              .deleteLogGroup({ logGroupName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
            const observed = yield* logs
              .describeLogStreams({
                logGroupName,
                orderBy: "LastEventTime",
                descending: true,
                limit: 1,
              })
              .pipe(
                Effect.map((r) => ({
                  exists: true,
                  lastIngestion: r.logStreams?.[0]?.lastIngestionTime,
                })),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed({
                    exists: false,
                    lastIngestion: undefined as number | undefined,
                  }),
                ),
              );
            const now = yield* Effect.sync(() => Date.now());
            const quiescent =
              observed.exists &&
              (observed.lastIngestion === undefined ||
                now - observed.lastIngestion > 120_000);
            if (quiescent) {
              yield* reapLogGroup;
            } else {
              yield* reapLogGroup.pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("20 seconds"),
                  times: 2,
                }),
              );
            }
          }
        }),
      });
    }),
  );

import * as osis from "@distilled.cloud/aws/osis";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  jsonEquals,
  readPipelineTags,
  retryWhilePipelineConflict,
  waitForPipelineSettled,
} from "./internal.ts";

export interface PipelineLogPublishingOptions {
  /**
   * Whether pipeline logs are published to CloudWatch Logs.
   */
  isLoggingEnabled?: boolean;
  /**
   * CloudWatch Logs destination. The log group name must start with
   * `/aws/vendedlogs/`.
   */
  cloudWatchLogDestination?: {
    /** Name of the CloudWatch Logs log group, e.g. `/aws/vendedlogs/OpenSearchIngestion/my-pipeline`. */
    logGroup: string;
  };
}

export interface PipelineBufferOptions {
  /**
   * Whether persistent buffering is enabled for the pipeline.
   */
  persistentBufferEnabled: boolean;
}

export interface PipelineEncryptionAtRestOptions {
  /**
   * ARN of the customer-managed KMS key used to encrypt buffer data.
   */
  kmsKeyArn: string;
}

export interface PipelineVpcOptions {
  /**
   * Subnet IDs the pipeline's VPC endpoint is placed into. Changing VPC
   * options replaces the pipeline.
   */
  subnetIds: string[];
  /**
   * Security group IDs applied to the pipeline's VPC endpoint.
   */
  securityGroupIds?: string[];
}

export interface PipelineProps {
  /**
   * Name of the pipeline. 3-28 characters; lowercase letters, numbers, and
   * hyphens. If omitted, a deterministic physical name is generated.
   * Changing the name replaces the pipeline.
   */
  pipelineName?: string;
  /**
   * Minimum number of Ingestion OpenSearch Compute Units (OCUs) the pipeline
   * scales down to. Minimum 1.
   */
  minUnits: number;
  /**
   * Maximum number of Ingestion OpenSearch Compute Units (OCUs) the pipeline
   * scales up to.
   */
  maxUnits: number;
  /**
   * Data Prepper pipeline configuration in YAML (must start with
   * `version: "2"`). Blueprints for common source/sink topologies are
   * available via the `listPipelineBlueprints`/`getPipelineBlueprint` APIs.
   */
  pipelineConfigurationBody: string;
  /**
   * CloudWatch Logs publishing configuration for pipeline logs.
   */
  logPublishingOptions?: PipelineLogPublishingOptions;
  /**
   * Persistent buffering for the pipeline's ingest data.
   */
  bufferOptions?: PipelineBufferOptions;
  /**
   * Customer-managed KMS encryption for buffer data.
   * @default an AWS-owned key
   */
  encryptionAtRestOptions?: PipelineEncryptionAtRestOptions;
  /**
   * VPC placement for the pipeline's ingest endpoint. Omit for a public
   * endpoint. Changing VPC options replaces the pipeline.
   */
  vpcOptions?: PipelineVpcOptions;
  /**
   * IAM role the pipeline assumes to write to its sinks (overrides the
   * `sts_role_arn` inside the configuration body where supported).
   */
  pipelineRoleArn?: string;
  /**
   * User-defined tags for the pipeline.
   */
  tags?: Record<string, string>;
}

export interface Pipeline extends Resource<
  "AWS.OSIS.Pipeline",
  PipelineProps,
  {
    /**
     * Name of the pipeline.
     */
    pipelineName: string;
    /**
     * ARN of the pipeline.
     */
    pipelineArn: string;
    /**
     * Pipeline status (e.g. `ACTIVE`, `CREATING`, `UPDATING`).
     */
    status: string;
    /**
     * Minimum Ingestion OCUs the pipeline scales down to.
     */
    minUnits: number | undefined;
    /**
     * Maximum Ingestion OCUs the pipeline scales up to.
     */
    maxUnits: number | undefined;
    /**
     * URLs to ingest data into the pipeline.
     */
    ingestEndpointUrls: string[] | undefined;
    /**
     * Tags on the pipeline.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon OpenSearch Ingestion (OSIS) pipeline — a managed Data Prepper
 * pipeline that ingests, transforms, and delivers data to OpenSearch domains,
 * serverless collections, or S3.
 *
 * Pipelines take roughly 5-10 minutes to provision and are billed per
 * Ingestion-OCU-hour while they exist (minimum 1 OCU). Destroy pipelines you
 * are not using.
 * @resource
 * @section Creating a Pipeline
 * @example HTTP Source to S3 Sink
 * ```typescript
 * const pipeline = yield* Pipeline("Logs", {
 *   minUnits: 1,
 *   maxUnits: 1,
 *   pipelineConfigurationBody: Output.interpolate`version: "2"
 * log-pipeline:
 *   source:
 *     http:
 *       path: "/logs"
 *   sink:
 *     - s3:
 *         aws:
 *           sts_role_arn: "${role.roleArn}"
 *           region: "us-west-2"
 *         bucket: "${bucket.bucketName}"
 *         threshold:
 *           event_collect_timeout: "60s"
 *         codec:
 *           ndjson:
 * `,
 * });
 * ```
 *
 * @example Pipeline with CloudWatch Logging
 * ```typescript
 * const pipeline = yield* Pipeline("Logs", {
 *   minUnits: 1,
 *   maxUnits: 2,
 *   pipelineConfigurationBody: configYaml,
 *   logPublishingOptions: {
 *     isLoggingEnabled: true,
 *     cloudWatchLogDestination: {
 *       logGroup: "/aws/vendedlogs/OpenSearchIngestion/logs",
 *     },
 *   },
 * });
 * ```
 */
export const Pipeline = Resource<Pipeline>("AWS.OSIS.Pipeline");

const toLogPublishingOptions = (
  options: PipelineLogPublishingOptions | undefined,
): osis.LogPublishingOptions | undefined =>
  options === undefined
    ? undefined
    : {
        IsLoggingEnabled: options.isLoggingEnabled,
        CloudWatchLogDestination:
          options.cloudWatchLogDestination !== undefined
            ? { LogGroup: options.cloudWatchLogDestination.logGroup }
            : undefined,
      };

export const PipelineProvider = () =>
  Provider.effect(
    Pipeline,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<PipelineProps>) =>
        props.pipelineName
          ? Effect.succeed(props.pipelineName)
          : createPhysicalName({ id, maxLength: 28, lowercase: true });

      const readPipeline = Effect.fn(function* (name: string) {
        return yield* osis.getPipeline({ PipelineName: name }).pipe(
          Effect.map((response) => response.Pipeline),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const waitForActive = Effect.fn(function* (name: string) {
        const pipeline = yield* waitForPipelineSettled(
          name,
          readPipeline(name),
        );
        if (pipeline === undefined) {
          return yield* Effect.fail(
            new Error(`OSIS pipeline '${name}' not found while waiting`),
          );
        }
        return pipeline;
      });

      const toAttrs = Effect.fn(function* (pipeline: osis.Pipeline) {
        if (!pipeline.PipelineName || !pipeline.PipelineArn) {
          return yield* Effect.fail(
            new Error(
              `OSIS pipeline '${pipeline.PipelineName}' is missing its ARN`,
            ),
          );
        }
        return {
          pipelineName: pipeline.PipelineName,
          pipelineArn: pipeline.PipelineArn,
          status: pipeline.Status ?? "ACTIVE",
          minUnits: pipeline.MinUnits,
          maxUnits: pipeline.MaxUnits,
          ingestEndpointUrls: pipeline.IngestEndpointUrls,
          tags: yield* readPipelineTags(pipeline.PipelineArn),
        };
      });

      return {
        stables: ["pipelineName", "pipelineArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const o: Partial<PipelineProps> = olds ?? {};
          const n: Partial<PipelineProps> = news ?? {};
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          // VPC options are create-only.
          if (!jsonEquals(o.vpcOptions, n.vpcOptions)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.pipelineName ?? (yield* toName(id, olds ?? {}));
          const pipeline = yield* readPipeline(name);
          if (pipeline === undefined) return undefined;
          const attrs = yield* toAttrs(pipeline);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.pipelineName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readPipeline(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* osis
              .createPipeline({
                PipelineName: name,
                MinUnits: props.minUnits,
                MaxUnits: props.maxUnits,
                PipelineConfigurationBody: props.pipelineConfigurationBody,
                LogPublishingOptions: toLogPublishingOptions(
                  props.logPublishingOptions,
                ),
                BufferOptions:
                  props.bufferOptions !== undefined
                    ? {
                        PersistentBufferEnabled:
                          props.bufferOptions.persistentBufferEnabled,
                      }
                    : undefined,
                EncryptionAtRestOptions:
                  props.encryptionAtRestOptions !== undefined
                    ? { KmsKeyArn: props.encryptionAtRestOptions.kmsKeyArn }
                    : undefined,
                VpcOptions:
                  props.vpcOptions !== undefined
                    ? {
                        SubnetIds: props.vpcOptions.subnetIds,
                        SecurityGroupIds: props.vpcOptions.securityGroupIds,
                      }
                    : undefined,
                PipelineRoleArn: props.pipelineRoleArn,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
          }

          // Creation and in-flight updates both surface as transitional
          // statuses; wait (bounded) so update calls do not conflict.
          observed = yield* waitForActive(name);

          // 3. Sync — compute the update delta from OBSERVED state.
          const update: osis.UpdatePipelineRequest = { PipelineName: name };
          let mutated = false;
          if (props.minUnits !== observed.MinUnits) {
            update.MinUnits = props.minUnits;
            mutated = true;
          }
          if (props.maxUnits !== observed.MaxUnits) {
            update.MaxUnits = props.maxUnits;
            mutated = true;
          }
          if (
            props.pipelineConfigurationBody.trim() !==
            (observed.PipelineConfigurationBody ?? "").trim()
          ) {
            update.PipelineConfigurationBody = props.pipelineConfigurationBody;
            mutated = true;
          }
          const desiredLogging = toLogPublishingOptions(
            props.logPublishingOptions,
          );
          if (
            desiredLogging !== undefined &&
            !jsonEquals(
              {
                IsLoggingEnabled:
                  observed.LogPublishingOptions?.IsLoggingEnabled,
                CloudWatchLogDestination:
                  observed.LogPublishingOptions?.CloudWatchLogDestination,
              },
              desiredLogging,
            )
          ) {
            update.LogPublishingOptions = desiredLogging;
            mutated = true;
          }
          if (
            props.bufferOptions !== undefined &&
            props.bufferOptions.persistentBufferEnabled !==
              observed.BufferOptions?.PersistentBufferEnabled
          ) {
            update.BufferOptions = {
              PersistentBufferEnabled:
                props.bufferOptions.persistentBufferEnabled,
            };
            mutated = true;
          }
          if (
            props.encryptionAtRestOptions !== undefined &&
            props.encryptionAtRestOptions.kmsKeyArn !==
              observed.EncryptionAtRestOptions?.KmsKeyArn
          ) {
            update.EncryptionAtRestOptions = {
              KmsKeyArn: props.encryptionAtRestOptions.kmsKeyArn,
            };
            mutated = true;
          }
          if (
            props.pipelineRoleArn !== undefined &&
            props.pipelineRoleArn !== observed.PipelineRoleArn
          ) {
            update.PipelineRoleArn = props.pipelineRoleArn;
            mutated = true;
          }

          if (mutated) {
            yield* osis.updatePipeline(update);
            observed = yield* waitForActive(name);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.PipelineArn;
          if (arn) {
            const observedTags = yield* readPipelineTags(arn);
            const { removed, upsert } = diffTags(observedTags, desiredTags);
            if (upsert.length > 0) {
              yield* osis.tagResource({ Arn: arn, Tags: upsert });
            }
            if (removed.length > 0) {
              yield* osis.untagResource({ Arn: arn, TagKeys: removed });
            }
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.pipelineName;
          // A pipeline mid-create/update rejects deletion with
          // ConflictException — wait (bounded, tolerant) for it to settle,
          // then retry conflicts through any residual transition.
          yield* waitForPipelineSettled(name, readPipeline(name)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          yield* retryWhilePipelineConflict(
            osis
              .deletePipeline({ PipelineName: name })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),

        list: () =>
          osis.listPipelines.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Pipelines ?? [])
                  .map((summary) => summary.PipelineName)
                  .filter((name): name is string => name !== undefined),
              ),
            ),
            Effect.flatMap(
              Effect.forEach(
                (name) =>
                  osis.getPipeline({ PipelineName: name }).pipe(
                    Effect.map((response) => response.Pipeline),
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((pipelines) =>
              pipelines.filter(
                (pipeline): pipeline is osis.Pipeline => pipeline !== undefined,
              ),
            ),
            Effect.flatMap(
              Effect.forEach((pipeline) => toAttrs(pipeline), {
                concurrency: 4,
              }),
            ),
          ),
      };
    }),
  );

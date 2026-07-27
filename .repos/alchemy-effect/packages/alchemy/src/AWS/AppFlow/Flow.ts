import * as appflow from "@distilled.cloud/aws/appflow";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readAppFlowTags, syncAppFlowTags } from "./internal.ts";

export interface FlowProps {
  /**
   * The name of the flow. Must be unique in the account/region, may contain
   * only letters, digits, hyphens, underscores, `!`, `@`, `#`, `.`, `$`.
   * If omitted, a deterministic physical name is generated. Changing the
   * name replaces the flow.
   */
  flowName?: string;
  /**
   * A description of the flow.
   */
  description?: string;
  /**
   * The ARN of a KMS key AppFlow uses to encrypt data. If omitted, the
   * AWS-managed AppFlow key is used.
   */
  kmsArn?: string;
  /**
   * How the flow is triggered — on demand, on a schedule, or by an event.
   * @default { triggerType: "OnDemand" }
   */
  triggerConfig?: appflow.TriggerConfig;
  /**
   * Configuration of the source connector (e.g. S3, Salesforce) the flow
   * pulls data from.
   */
  sourceFlowConfig: appflow.SourceFlowConfig;
  /**
   * Configuration of the destination connector(s) the flow pushes data to.
   */
  destinationFlowConfigList: appflow.DestinationFlowConfig[];
  /**
   * The field mapping tasks applied to records as they move from source to
   * destination.
   */
  tasks: appflow.Task[];
  /**
   * Glue Data Catalog configuration for cataloging flow output.
   */
  metadataCatalogConfig?: appflow.MetadataCatalogConfig;
  /**
   * User-defined tags for the flow.
   */
  tags?: Record<string, string>;
}

export interface Flow extends Resource<
  "AWS.AppFlow.Flow",
  FlowProps,
  {
    flowName: string;
    flowArn: string;
    flowStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon AppFlow flow. A flow transfers data between a source connector
 * and one or more destination connectors, applying field-mapping tasks.
 * The credential-free S3-to-S3 path is directly testable; other connectors
 * require a {@link ConnectorProfile} with vendor credentials.
 *
 * For an S3 source, the bucket policy must authorize the
 * `appflow.amazonaws.com` service principal (`s3:GetObject` + `s3:ListBucket`
 * on the source; `s3:PutObject` and the multipart/ACL actions on the
 * destination), and the source prefix must contain at least one object when
 * the flow is created — AppFlow validates connectivity by listing the source
 * at `CreateFlow` time and rejects an empty prefix with
 * `ConnectorServerException`.
 * @resource
 * @section Creating a Flow
 * @example S3 to S3 On-Demand Flow
 * ```typescript
 * const flow = yield* AppFlow.Flow("Copy", {
 *   triggerConfig: { triggerType: "OnDemand" },
 *   sourceFlowConfig: {
 *     connectorType: "S3",
 *     sourceConnectorProperties: {
 *       S3: { bucketName: srcBucket, bucketPrefix: "input" },
 *     },
 *   },
 *   destinationFlowConfigList: [
 *     {
 *       connectorType: "S3",
 *       destinationConnectorProperties: {
 *         S3: { bucketName: dstBucket, bucketPrefix: "output" },
 *       },
 *     },
 *   ],
 *   tasks: [
 *     {
 *       taskType: "Map_all",
 *       sourceFields: [],
 *       connectorOperator: { S3: "NO_OP" },
 *       taskProperties: {},
 *     },
 *   ],
 * });
 * ```
 */
export const Flow = Resource<Flow>("AWS.AppFlow.Flow");

const ON_DEMAND: appflow.TriggerConfig = { triggerType: "OnDemand" };

export const FlowProvider = () =>
  Provider.effect(
    Flow,
    Effect.gen(function* () {
      const toName = (id: string, props: FlowProps) =>
        props.flowName
          ? Effect.succeed(props.flowName)
          : createPhysicalName({ id, maxLength: 100 });

      return {
        stables: ["flowName", "flowArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.flowName ?? (yield* toName(id, olds ?? {}));
          const flow = yield* appflow
            .describeFlow({ flowName: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (flow === undefined || flow.flowArn === undefined)
            return undefined;
          const attrs = {
            flowName: name,
            flowArn: flow.flowArn,
            flowStatus: flow.flowStatus,
          };
          const tags = yield* readAppFlowTags(flow.flowArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.flowName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const trigger = news.triggerConfig ?? ON_DEMAND;

          // 1. Observe.
          let live = yield* appflow
            .describeFlow({ flowName: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // 2. Ensure — create if missing. Tolerate an AlreadyExists race by
          // falling back to describe.
          if (live === undefined) {
            yield* appflow
              .createFlow({
                flowName: name,
                description: news.description,
                kmsArn: news.kmsArn,
                triggerConfig: trigger,
                sourceFlowConfig: news.sourceFlowConfig,
                destinationFlowConfigList: news.destinationFlowConfigList,
                tasks: news.tasks,
                metadataCatalogConfig: news.metadataCatalogConfig,
                tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            live = yield* appflow.describeFlow({ flowName: name });
          } else {
            // 3. Sync — updateFlow converges the mutable configuration
            // (trigger, source/destination, tasks). It does not accept tags.
            yield* appflow.updateFlow({
              flowName: name,
              description: news.description,
              triggerConfig: trigger,
              sourceFlowConfig: news.sourceFlowConfig,
              destinationFlowConfigList: news.destinationFlowConfigList,
              tasks: news.tasks,
              metadataCatalogConfig: news.metadataCatalogConfig,
            });
            live = yield* appflow.describeFlow({ flowName: name });
          }

          // 3b. Sync tags against observed cloud tags.
          if (live.flowArn) {
            yield* syncAppFlowTags(live.flowArn, desiredTags);
          }

          yield* session.note(name);
          return {
            flowName: name,
            flowArn: live.flowArn!,
            flowStatus: live.flowStatus,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appflow
            .deleteFlow({ flowName: output.flowName, forceDelete: true })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          appflow.listFlows.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.flows ?? [])
                  .filter(
                    (
                      f,
                    ): f is appflow.FlowDefinition & {
                      flowName: string;
                      flowArn: string;
                    } => f.flowName !== undefined && f.flowArn !== undefined,
                  )
                  .map((f) => ({
                    flowName: f.flowName,
                    flowArn: f.flowArn,
                    flowStatus: f.flowStatus,
                  })),
              ),
            ),
          ),
      };
    }),
  );

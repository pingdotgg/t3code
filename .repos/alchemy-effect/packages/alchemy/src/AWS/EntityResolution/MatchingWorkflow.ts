import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readEntityResolutionTags,
  retryRolePropagation,
  syncEntityResolutionTags,
} from "./internal.ts";

export interface MatchingWorkflowProps {
  /**
   * Name of the matching workflow. Must be unique per account/region and
   * match `[a-zA-Z_0-9-]*`. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing the name replaces the workflow.
   */
  workflowName?: string;
  /**
   * A description of the workflow.
   */
  description?: string;
  /**
   * The input records to match: each entry names a Glue table
   * (`inputSourceARN`) and the schema mapping (`schemaName`) that describes
   * its columns.
   */
  inputSourceConfig: entityresolution.InputSource[];
  /**
   * Where matched output records are written: an S3 path (`outputS3Path`),
   * the columns to include (`output`), and an optional KMS key (`KMSArn`).
   */
  outputSourceConfig: entityresolution.OutputSource[];
  /**
   * How records are matched: `RULE_MATCHING` with `ruleBasedProperties`,
   * `ML_MATCHING`, or a `PROVIDER` service.
   */
  resolutionTechniques: entityresolution.ResolutionTechniques;
  /**
   * Incremental-run configuration. Only supported for `RULE_MATCHING`
   * workflows.
   */
  incrementalRunConfig?: entityresolution.IncrementalRunConfig;
  /**
   * The ARN of the IAM role Entity Resolution assumes to read the input Glue
   * tables and write the S3 output on your behalf.
   */
  roleArn: string;
  /**
   * Tags to apply to the workflow. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface MatchingWorkflow extends Resource<
  "AWS.EntityResolution.MatchingWorkflow",
  MatchingWorkflowProps,
  {
    /**
     * The name of the matching workflow.
     */
    workflowName: string;
    /**
     * The ARN of the matching workflow.
     */
    workflowArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Entity Resolution matching workflow — a data-processing job
 * definition that matches and deduplicates records across Glue table input
 * sources using rule-based or ML-powered matching, writing matched record
 * groups to S3.
 *
 * The workflow definition itself is cheap and instant; a matching RUN
 * (`StartMatchingJob`) processes the full input and takes many minutes.
 *
 * @resource
 * @section Creating Workflows
 * @example Rule-based matching over a Glue table
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const workflow = yield* AWS.EntityResolution.MatchingWorkflow("Dedupe", {
 *   inputSourceConfig: [
 *     { inputSourceARN: table.tableArn, schemaName: schema.schemaName },
 *   ],
 *   outputSourceConfig: [
 *     {
 *       outputS3Path: `s3://${bucket.bucketName}/matches/`,
 *       output: [{ name: "id" }, { name: "email" }],
 *     },
 *   ],
 *   resolutionTechniques: {
 *     resolutionType: "RULE_MATCHING",
 *     ruleBasedProperties: {
 *       rules: [{ ruleName: "ByEmail", matchingKeys: ["email"] }],
 *       attributeMatchingModel: "ONE_TO_ONE",
 *     },
 *   },
 *   roleArn: role.roleArn,
 * });
 * ```
 *
 * @example ML-powered matching
 * ```typescript
 * const workflow = yield* AWS.EntityResolution.MatchingWorkflow("MlDedupe", {
 *   inputSourceConfig: [
 *     { inputSourceARN: table.tableArn, schemaName: schema.schemaName },
 *   ],
 *   outputSourceConfig: [
 *     {
 *       outputS3Path: `s3://${bucket.bucketName}/ml-matches/`,
 *       output: [{ name: "id" }],
 *     },
 *   ],
 *   resolutionTechniques: { resolutionType: "ML_MATCHING" },
 *   roleArn: role.roleArn,
 * });
 * ```
 */
export const MatchingWorkflow = Resource<MatchingWorkflow>(
  "AWS.EntityResolution.MatchingWorkflow",
);

export const MatchingWorkflowProvider = () =>
  Provider.effect(
    MatchingWorkflow,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { workflowName?: string | undefined },
      ) {
        return (
          props.workflowName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      /** Get a workflow by name; typed not-found → undefined. */
      const getByName = Effect.fn(function* (workflowName: string) {
        return yield* entityresolution
          .getMatchingWorkflow({ workflowName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["workflowName", "workflowArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.workflowName ?? (yield* createName(id, olds ?? {}));
          const workflow = yield* getByName(name);
          if (workflow === undefined) return undefined;
          const attrs = {
            workflowName: workflow.workflowName,
            workflowArn: workflow.workflowArn,
          };
          // getMatchingWorkflow does not return tags — read them via
          // listTagsForResource for the ownership check.
          const tags = yield* readEntityResolutionTags(workflow.workflowArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.workflowName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — names are unique, so the name IS the identity.
          let workflow = yield* getByName(name);

          // 2. Ensure — create when missing. A freshly-created IAM role is
          //    transiently rejected while IAM propagates, so retry that
          //    typed AccessDeniedException on a bounded schedule; tolerate
          //    the concurrent-create race, then re-observe: the create
          //    response is a structural subset of the Get shape (it omits
          //    createdAt/updatedAt).
          if (workflow === undefined) {
            yield* entityresolution
              .createMatchingWorkflow({
                workflowName: name,
                description: news.description,
                inputSourceConfig: news.inputSourceConfig,
                outputSourceConfig: news.outputSourceConfig,
                resolutionTechniques: news.resolutionTechniques,
                incrementalRunConfig: news.incrementalRunConfig,
                roleArn: news.roleArn,
                tags: desiredTags,
              })
              .pipe(
                retryRolePropagation,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            workflow = yield* entityresolution.getMatchingWorkflow({
              workflowName: name,
            });
          }

          // 3. Sync — everything except the name updates in place via a
          //    full-PUT update. Only call the API on an actual delta
          //    between OBSERVED and desired configuration.
          const desired = {
            description: news.description ?? undefined,
            inputSourceConfig: news.inputSourceConfig,
            outputSourceConfig: news.outputSourceConfig,
            resolutionTechniques: news.resolutionTechniques,
            incrementalRunConfig: news.incrementalRunConfig ?? undefined,
            roleArn: news.roleArn,
          };
          const observed = {
            description: workflow.description ?? undefined,
            inputSourceConfig: workflow.inputSourceConfig,
            outputSourceConfig: workflow.outputSourceConfig,
            resolutionTechniques: workflow.resolutionTechniques,
            incrementalRunConfig: workflow.incrementalRunConfig ?? undefined,
            roleArn: workflow.roleArn,
          };
          if (!deepEqual(observed, desired)) {
            // The update response omits workflowArn/createdAt/updatedAt;
            // the ARN is stable, so keep the observed Get shape.
            yield* entityresolution
              .updateMatchingWorkflow({
                workflowName: name,
                description: news.description,
                inputSourceConfig: news.inputSourceConfig,
                outputSourceConfig: news.outputSourceConfig,
                resolutionTechniques: news.resolutionTechniques,
                incrementalRunConfig: news.incrementalRunConfig,
                roleArn: news.roleArn,
              })
              .pipe(retryRolePropagation);
          }

          const workflowArn = workflow.workflowArn;

          // 3b. Sync tags against OBSERVED cloud tags (adoption-safe).
          yield* syncEntityResolutionTags(workflowArn, desiredTags);

          yield* session.note(workflowArn);
          return { workflowName: name, workflowArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteMatchingWorkflow succeeds even when the workflow is
          // already gone; a running matching job conflicts — retry briefly.
          yield* entityresolution
            .deleteMatchingWorkflow({ workflowName: output.workflowName })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
            );
        }),

        list: () =>
          entityresolution.listMatchingWorkflows.items({}).pipe(
            Stream.map((summary) => ({
              workflowName: summary.workflowName,
              workflowArn: summary.workflowArn,
            })),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );

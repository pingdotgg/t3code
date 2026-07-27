import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface PutActionRevisionRequest extends Omit<
  SVC.PutActionRevisionInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:PutActionRevision` — informs
 * CodePipeline about a new revision available to a source action, starting
 * an execution if the revision is new.
 * @binding
 * @section Sources
 * @example Report a New Source Revision
 * ```typescript
 * const putRevision = yield* AWS.CodePipeline.PutActionRevision(pipeline);
 *
 * const { newRevision, pipelineExecutionId } = yield* putRevision({
 *   stageName: "Source",
 *   actionName: "S3Source",
 *   actionRevision: {
 *     revisionId: versionId,
 *     revisionChangeId: changeId,
 *     created: new Date(),
 *   },
 * });
 * ```
 */
export interface PutActionRevision extends Binding.Service<
  PutActionRevision,
  "AWS.CodePipeline.PutActionRevision",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: PutActionRevisionRequest,
    ) => Effect.Effect<SVC.PutActionRevisionOutput, SVC.PutActionRevisionError>
  >
> {}
export const PutActionRevision = Binding.Service<PutActionRevision>(
  "AWS.CodePipeline.PutActionRevision",
);

import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface BatchGetApplicationRevisionsRequest extends Omit<
  SVC.BatchGetApplicationRevisionsInput,
  "applicationName"
> {}

/**
 * Runtime binding for `codedeploy:BatchGetApplicationRevisions` — reads up
 * to 25 registered revisions of the bound application in one call.
 * @binding
 * @section Managing Revisions
 * @example Read Several Revisions
 * ```typescript
 * const batchGetApplicationRevisions =
 *   yield* AWS.CodeDeploy.BatchGetApplicationRevisions(app);
 *
 * const { revisions } = yield* batchGetApplicationRevisions({
 *   revisions: [revisionLocation],
 * });
 * ```
 */
export interface BatchGetApplicationRevisions extends Binding.Service<
  BatchGetApplicationRevisions,
  "AWS.CodeDeploy.BatchGetApplicationRevisions",
  <P extends Application>(
    application: P,
  ) => Effect.Effect<
    (
      request: BatchGetApplicationRevisionsRequest,
    ) => Effect.Effect<
      SVC.BatchGetApplicationRevisionsOutput,
      SVC.BatchGetApplicationRevisionsError
    >
  >
> {}
export const BatchGetApplicationRevisions =
  Binding.Service<BatchGetApplicationRevisions>(
    "AWS.CodeDeploy.BatchGetApplicationRevisions",
  );

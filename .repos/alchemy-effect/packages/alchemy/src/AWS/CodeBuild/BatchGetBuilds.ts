import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:BatchGetBuilds` — reads the status of one
 * or more builds by id (the ids returned from {@link StartBuild}). Bind it
 * to the project whose builds you poll.
 * @binding
 * @section Polling Builds
 * @example Poll a Build to Completion
 * ```typescript
 * const batchGetBuilds = yield* AWS.CodeBuild.BatchGetBuilds(project);
 *
 * const { builds } = yield* batchGetBuilds({ ids: [buildId] });
 * const status = builds?.[0]?.buildStatus; // IN_PROGRESS | SUCCEEDED | FAILED | ...
 * ```
 */
export interface BatchGetBuilds extends Binding.Service<
  BatchGetBuilds,
  "AWS.CodeBuild.BatchGetBuilds",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.BatchGetBuildsInput,
    ) => Effect.Effect<SVC.BatchGetBuildsOutput, SVC.BatchGetBuildsError>
  >
> {}
export const BatchGetBuilds = Binding.Service<BatchGetBuilds>(
  "AWS.CodeBuild.BatchGetBuilds",
);

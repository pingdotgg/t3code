import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:InvalidateProjectCache` — resets the
 * bound project's build cache so the next build starts cold.
 * @binding
 * @section Project Cache
 * @example Invalidate the Build Cache
 * ```typescript
 * const invalidateProjectCache = yield* AWS.CodeBuild.InvalidateProjectCache(project);
 *
 * yield* invalidateProjectCache();
 * ```
 */
export interface InvalidateProjectCache extends Binding.Service<
  InvalidateProjectCache,
  "AWS.CodeBuild.InvalidateProjectCache",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    () => Effect.Effect<
      SVC.InvalidateProjectCacheOutput,
      SVC.InvalidateProjectCacheError
    >
  >
> {}
export const InvalidateProjectCache = Binding.Service<InvalidateProjectCache>(
  "AWS.CodeBuild.InvalidateProjectCache",
);

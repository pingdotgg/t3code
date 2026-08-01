import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:StopSandbox` — stops a running sandbox of
 * the bound project by sandbox id.
 * @binding
 * @section Sandboxes
 * @example Stop a Sandbox
 * ```typescript
 * const stopSandbox = yield* AWS.CodeBuild.StopSandbox(project);
 *
 * yield* stopSandbox({ id: sandboxId });
 * ```
 */
export interface StopSandbox extends Binding.Service<
  StopSandbox,
  "AWS.CodeBuild.StopSandbox",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.StopSandboxInput,
    ) => Effect.Effect<SVC.StopSandboxOutput, SVC.StopSandboxError>
  >
> {}
export const StopSandbox = Binding.Service<StopSandbox>(
  "AWS.CodeBuild.StopSandbox",
);

import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:StartSandbox` — launches an interactive
 * sandbox environment for the bound project. Run commands in it with
 * {@link StartCommandExecution}; stop it with {@link StopSandbox}.
 * @binding
 * @section Sandboxes
 * @example Start a Sandbox
 * ```typescript
 * const startSandbox = yield* AWS.CodeBuild.StartSandbox(project);
 *
 * const { sandbox } = yield* startSandbox();
 * ```
 */
export interface StartSandbox extends Binding.Service<
  StartSandbox,
  "AWS.CodeBuild.StartSandbox",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.StartSandboxInput, "projectName">,
    ) => Effect.Effect<SVC.StartSandboxOutput, SVC.StartSandboxError>
  >
> {}
export const StartSandbox = Binding.Service<StartSandbox>(
  "AWS.CodeBuild.StartSandbox",
);

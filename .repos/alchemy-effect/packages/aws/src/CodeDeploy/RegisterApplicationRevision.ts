import type * as SVC from "@distilled.cloud/aws/codedeploy";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";

export interface RegisterApplicationRevisionRequest extends Omit<
  SVC.RegisterApplicationRevisionInput,
  "applicationName"
> {}

/**
 * Runtime binding for `codedeploy:RegisterApplicationRevision` — registers
 * a revision (S3 bundle or inline AppSpec) with the bound application so it
 * shows up for deployment.
 * ### Managing Revisions
 * **Example:** Register an S3 Revision
 * ```typescript
 * const registerApplicationRevision =
 *   yield* AWS.CodeDeploy.RegisterApplicationRevision(app);
 *
 * yield* registerApplicationRevision({
 *   revision: {
 *     revisionType: "S3",
 *     s3Location: { bucket, key, bundleType: "zip" },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface RegisterApplicationRevision extends Binding.Service<
  RegisterApplicationRevision,
  "AWS.CodeDeploy.RegisterApplicationRevision",
  <P extends Application>(
    application: P,
  ) => Effect.Effect<
    (
      request: RegisterApplicationRevisionRequest,
    ) => Effect.Effect<
      SVC.RegisterApplicationRevisionResponse,
      SVC.RegisterApplicationRevisionError
    >
  >
> {}
export const RegisterApplicationRevision = Binding.Service<RegisterApplicationRevision>(
  "AWS.CodeDeploy.RegisterApplicationRevision",
);

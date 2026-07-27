import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface GetApplicationRevisionRequest extends Omit<
  SVC.GetApplicationRevisionInput,
  "applicationName"
> {}

/**
 * Runtime binding for `codedeploy:GetApplicationRevision` — reads a
 * registered revision's metadata (description, deployment groups it was
 * deployed to, first-seen time).
 * @binding
 * @section Managing Revisions
 * @example Read a Revision
 * ```typescript
 * const getApplicationRevision =
 *   yield* AWS.CodeDeploy.GetApplicationRevision(app);
 *
 * const { revisionInfo } = yield* getApplicationRevision({
 *   revision: {
 *     revisionType: "S3",
 *     s3Location: { bucket, key, bundleType: "zip" },
 *   },
 * });
 * ```
 */
export interface GetApplicationRevision extends Binding.Service<
  GetApplicationRevision,
  "AWS.CodeDeploy.GetApplicationRevision",
  <P extends Application>(
    application: P,
  ) => Effect.Effect<
    (
      request: GetApplicationRevisionRequest,
    ) => Effect.Effect<
      SVC.GetApplicationRevisionOutput,
      SVC.GetApplicationRevisionError
    >
  >
> {}
export const GetApplicationRevision = Binding.Service<GetApplicationRevision>(
  "AWS.CodeDeploy.GetApplicationRevision",
);

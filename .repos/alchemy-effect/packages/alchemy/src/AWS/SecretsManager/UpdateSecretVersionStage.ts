import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

export interface UpdateSecretVersionStageRequest extends Omit<
  secretsmanager.UpdateSecretVersionStageRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:UpdateSecretVersionStage`.
 *
 * Bind this operation to a `Secret` to get a callable that moves a staging
 * label between versions — the final `finishSecret` step of the rotation
 * protocol, where `AWSCURRENT` is moved onto the new version. Provide the
 * implementation with
 * `Effect.provide(AWS.SecretsManager.UpdateSecretVersionStageHttp)`.
 * @binding
 * @section Rotating Secrets
 * @example Promote a Pending Version to AWSCURRENT
 * ```typescript
 * // init — bind the operation to the secret
 * const updateStage = yield* AWS.SecretsManager.UpdateSecretVersionStage(secret);
 *
 * // runtime — finishSecret: move AWSCURRENT onto the pending version
 * yield* updateStage({
 *   VersionStage: "AWSCURRENT",
 *   MoveToVersionId: pendingVersionId,
 *   RemoveFromVersionId: currentVersionId,
 * });
 * ```
 */
export interface UpdateSecretVersionStage extends Binding.Service<
  UpdateSecretVersionStage,
  "AWS.SecretsManager.UpdateSecretVersionStage",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request: UpdateSecretVersionStageRequest,
    ) => Effect.Effect<
      secretsmanager.UpdateSecretVersionStageResponse,
      secretsmanager.UpdateSecretVersionStageError
    >
  >
> {}

export const UpdateSecretVersionStage =
  Binding.Service<UpdateSecretVersionStage>(
    "AWS.SecretsManager.UpdateSecretVersionStage",
  );

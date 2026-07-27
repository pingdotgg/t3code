import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * `GetPasswordData` request with `InstanceId` injected from the bound
 * {@link Instance}.
 */
export interface GetPasswordDataRequest extends Omit<
  ec2.GetPasswordDataRequest,
  "InstanceId" | "InstanceIds"
> {}

/**
 * Runtime binding for the `GetPasswordData` operation scoped to the bound
 * {@link Instance} (IAM action `ec2:GetPasswordData` on the instance ARN).
 *
 * Retrieves the encrypted Windows administrator password for the instance.
 * The `PasswordData` field is sensitive and surfaces as
 * `Redacted.Redacted<string>` — decrypt it with the launch key pair's private
 * key. Linux instances return an empty value. Provide the implementation with
 * `Effect.provide(AWS.EC2.GetPasswordDataHttp)`.
 * @binding
 * @section Diagnostics
 * @example Fetch the encrypted Windows administrator password
 * ```typescript
 * // init — bind the operation to the instance
 * const getPasswordData = yield* AWS.EC2.GetPasswordData(instance);
 *
 * // runtime — the ciphertext is Redacted; unwrap explicitly to decrypt
 * const result = yield* getPasswordData();
 * const ciphertext = result.PasswordData; // Redacted<string>
 * ```
 */
export interface GetPasswordData extends Binding.Service<
  GetPasswordData,
  "AWS.EC2.GetPasswordData",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetPasswordDataRequest,
    ) => Effect.Effect<ec2.GetPasswordDataResult, ec2.GetPasswordDataError>
  >
> {}

export const GetPasswordData = Binding.Service<GetPasswordData>(
  "AWS.EC2.GetPasswordData",
);

import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { User } from "./User.ts";

/**
 * Runtime binding for `transfer:DeleteSshPublicKey`.
 *
 * Removes an SSH public key from the bound {@link User} by
 * `SshPublicKeyId` (returned by {@link ImportSshPublicKey} or listed via
 * {@link DescribeUser}) — the revocation half of key rotation. The
 * `ServerId` and `UserName` are injected from the binding. Deleting a key
 * that no longer exists fails with the typed `ResourceNotFoundException`.
 * Provide the implementation with
 * `Effect.provide(AWS.Transfer.DeleteSshPublicKeyHttp)`.
 * @binding
 * @section Managing SSH Keys at Runtime
 * @example Revoke a User's Key
 * ```typescript
 * // init — bind the operation to the user
 * const deleteSshPublicKey = yield* AWS.Transfer.DeleteSshPublicKey(user);
 *
 * // runtime
 * yield* deleteSshPublicKey({ SshPublicKeyId: keyId }).pipe(
 *   Effect.catchTag("ResourceNotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeleteSshPublicKey extends Binding.Service<
  DeleteSshPublicKey,
  "AWS.Transfer.DeleteSshPublicKey",
  (
    user: User,
  ) => Effect.Effect<
    (
      request: Omit<
        transfer.DeleteSshPublicKeyRequest,
        "ServerId" | "UserName"
      >,
    ) => Effect.Effect<
      transfer.DeleteSshPublicKeyResponse,
      transfer.DeleteSshPublicKeyError
    >
  >
> {}
export const DeleteSshPublicKey = Binding.Service<DeleteSshPublicKey>(
  "AWS.Transfer.DeleteSshPublicKey",
);

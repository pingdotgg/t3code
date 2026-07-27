import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { User } from "./User.ts";

/**
 * Runtime binding for `transfer:ImportSshPublicKey`.
 *
 * Registers an additional SSH public key on the bound {@link User} — the
 * key-rotation half of a self-service credential portal. The `ServerId` and
 * `UserName` are injected from the binding; only the public key body is
 * passed at runtime. Returns the new `SshPublicKeyId` for later
 * {@link DeleteSshPublicKey}. Importing a key that is already registered
 * fails with the typed `ResourceExistsException`. Provide the
 * implementation with `Effect.provide(AWS.Transfer.ImportSshPublicKeyHttp)`.
 * @binding
 * @section Managing SSH Keys at Runtime
 * @example Rotate a User's Key
 * ```typescript
 * // init — bind the operation to the user
 * const importSshPublicKey = yield* AWS.Transfer.ImportSshPublicKey(user);
 *
 * // runtime
 * const { SshPublicKeyId } = yield* importSshPublicKey({
 *   SshPublicKeyBody: "ssh-ed25519 AAAA…",
 * });
 * ```
 */
export interface ImportSshPublicKey extends Binding.Service<
  ImportSshPublicKey,
  "AWS.Transfer.ImportSshPublicKey",
  (
    user: User,
  ) => Effect.Effect<
    (
      request: Omit<
        transfer.ImportSshPublicKeyRequest,
        "ServerId" | "UserName"
      >,
    ) => Effect.Effect<
      transfer.ImportSshPublicKeyResponse,
      transfer.ImportSshPublicKeyError
    >
  >
> {}
export const ImportSshPublicKey = Binding.Service<ImportSshPublicKey>(
  "AWS.Transfer.ImportSshPublicKey",
);

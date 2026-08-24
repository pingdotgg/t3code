import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { User } from "./User.ts";

/**
 * Runtime binding for `transfer:DescribeUser`.
 *
 * Reads the bound {@link User}'s live configuration — home directory, role,
 * POSIX profile, and the SSH public keys currently registered (including
 * their `SshPublicKeyId`s, which {@link DeleteSshPublicKey} needs). The
 * `ServerId` and `UserName` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Transfer.DescribeUserHttp)`.
 * @binding
 * @section Managing Users at Runtime
 * @example Read the User's SSH Keys
 * ```typescript
 * // init — bind the operation to the user
 * const describeUser = yield* AWS.Transfer.DescribeUser(user);
 *
 * // runtime
 * const { User } = yield* describeUser();
 * const keyIds = (User.SshPublicKeys ?? []).map((k) => k.SshPublicKeyId);
 * ```
 */
export interface DescribeUser extends Binding.Service<
  DescribeUser,
  "AWS.Transfer.DescribeUser",
  (
    user: User,
  ) => Effect.Effect<
    (
      request?: Omit<transfer.DescribeUserRequest, "ServerId" | "UserName">,
    ) => Effect.Effect<
      transfer.DescribeUserResponse,
      transfer.DescribeUserError
    >
  >
> {}
export const DescribeUser = Binding.Service<DescribeUser>(
  "AWS.Transfer.DescribeUser",
);

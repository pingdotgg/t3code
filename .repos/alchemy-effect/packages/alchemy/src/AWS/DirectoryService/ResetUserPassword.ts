import type * as ds from "@distilled.cloud/aws/directory-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Directory } from "./Directory.ts";

/**
 * Runtime binding for the `ResetUserPassword` operation (IAM action
 * `ds:ResetUserPassword`), scoped to one {@link Directory}.
 *
 * Resets the password of any user in the bound Simple AD or Managed
 * Microsoft AD directory — the backbone of a self-service password-reset
 * function. `NewPassword` is sensitive; pass a `Redacted` value so it never
 * leaks into logs. The directory id is injected from the binding. Provide
 * the implementation with
 * `Effect.provide(AWS.DirectoryService.ResetUserPasswordHttp)`.
 * @binding
 * @section Managing Users
 * @example Reset a User's Password
 * ```typescript
 * // init — bind the operation to the directory
 * const resetUserPassword = yield* AWS.DirectoryService.ResetUserPassword(directory);
 *
 * // runtime
 * yield* resetUserPassword({
 *   UserName: "jdoe",
 *   NewPassword: Redacted.make("N3w-Secret!"),
 * });
 * ```
 */
export interface ResetUserPassword extends Binding.Service<
  ResetUserPassword,
  "AWS.DirectoryService.ResetUserPassword",
  (
    directory: Directory,
  ) => Effect.Effect<
    (
      request: Omit<ds.ResetUserPasswordRequest, "DirectoryId">,
    ) => Effect.Effect<ds.ResetUserPasswordResult, ds.ResetUserPasswordError>
  >
> {}
export const ResetUserPassword = Binding.Service<ResetUserPassword>(
  "AWS.DirectoryService.ResetUserPassword",
);

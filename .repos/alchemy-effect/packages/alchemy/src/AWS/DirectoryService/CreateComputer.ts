import type * as ds from "@distilled.cloud/aws/directory-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Directory } from "./Directory.ts";

/**
 * Runtime binding for the `CreateComputer` operation (IAM action
 * `ds:CreateComputer`), scoped to one {@link Directory}.
 *
 * Creates a computer account in the bound directory — the programmatic half
 * of joining a machine to the domain (e.g. from an instance-provisioning
 * workflow). `Password` is the one-time machine password and is sensitive;
 * pass a `Redacted` value. The directory id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DirectoryService.CreateComputerHttp)`.
 * @binding
 * @section Managing Computers
 * @example Create a Computer Account
 * ```typescript
 * // init — bind the operation to the directory
 * const createComputer = yield* AWS.DirectoryService.CreateComputer(directory);
 *
 * // runtime
 * const { Computer } = yield* createComputer({
 *   ComputerName: "BUILD-AGENT-01",
 *   Password: Redacted.make("0ne-Time-Secret!"),
 * });
 * ```
 */
export interface CreateComputer extends Binding.Service<
  CreateComputer,
  "AWS.DirectoryService.CreateComputer",
  (
    directory: Directory,
  ) => Effect.Effect<
    (
      request: Omit<ds.CreateComputerRequest, "DirectoryId">,
    ) => Effect.Effect<ds.CreateComputerResult, ds.CreateComputerError>
  >
> {}
export const CreateComputer = Binding.Service<CreateComputer>(
  "AWS.DirectoryService.CreateComputer",
);

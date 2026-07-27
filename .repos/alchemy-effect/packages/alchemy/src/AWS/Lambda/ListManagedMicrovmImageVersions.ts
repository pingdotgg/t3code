import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListManagedMicrovmImageVersionsRequest
  extends microvms.ListManagedMicrovmImageVersionsInput {}

/**
 * Runtime binding for `ListManagedMicrovmImageVersions` (account-scoped).
 *
 * Lists versions of an AWS-managed base MicroVM image. Bind with no resource:
 * `yield* AWS.Lambda.ListManagedMicrovmImageVersions()`.
 * @binding
 * @section Managed Base Images
 */
export interface ListManagedMicrovmImageVersions extends Binding.Service<
  ListManagedMicrovmImageVersions,
  "AWS.Lambda.ListManagedMicrovmImageVersions",
  () => Effect.Effect<
    (
      request: ListManagedMicrovmImageVersionsRequest,
    ) => Effect.Effect<
      microvms.ListManagedMicrovmImageVersionsOutput,
      microvms.ListManagedMicrovmImageVersionsError
    >
  >
> {}
export const ListManagedMicrovmImageVersions =
  Binding.Service<ListManagedMicrovmImageVersions>(
    "AWS.Lambda.ListManagedMicrovmImageVersions",
  );

import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListManagedMicrovmImagesRequest
  extends microvms.ListManagedMicrovmImagesInput {}

/**
 * Runtime binding for `ListManagedMicrovmImages` (account-scoped).
 *
 * Lists the AWS-managed base MicroVM images available for use as
 * `baseImage`. Bind with no resource: `yield* AWS.Lambda.ListManagedMicrovmImages()`.
 * @binding
 * @section Managed Base Images
 */
export interface ListManagedMicrovmImages extends Binding.Service<
  ListManagedMicrovmImages,
  "AWS.Lambda.ListManagedMicrovmImages",
  () => Effect.Effect<
    (
      request: ListManagedMicrovmImagesRequest,
    ) => Effect.Effect<
      microvms.ListManagedMicrovmImagesOutput,
      microvms.ListManagedMicrovmImagesError
    >
  >
> {}
export const ListManagedMicrovmImages =
  Binding.Service<ListManagedMicrovmImages>(
    "AWS.Lambda.ListManagedMicrovmImages",
  );

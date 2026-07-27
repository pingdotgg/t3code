import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListResourceSetResources}.
 */
export interface ListResourceSetResourcesRequest
  extends fms.ListResourceSetResourcesRequest {}

/**
 * Runtime binding for `fms:ListResourceSetResources`.
 *
 * Returns an array of the resources associated with the specified Firewall Manager resource set. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListResourceSetResourcesHttp)`.
 * @binding
 * @section Resource Sets
 * @example List a Resource Set's Members
 * ```typescript
 * // init — account-level binding takes no resource
 * const listResourceSetResources = yield* AWS.FMS.ListResourceSetResources();
 *
 * // runtime
 * const result = yield* listResourceSetResources({ Identifier: resourceSetId });
 * console.log(result.Items.length);
 * ```
 */
export interface ListResourceSetResources extends Binding.Service<
  ListResourceSetResources,
  "AWS.FMS.ListResourceSetResources",
  () => Effect.Effect<
    (
      request: ListResourceSetResourcesRequest,
    ) => Effect.Effect<
      fms.ListResourceSetResourcesResponse,
      fms.ListResourceSetResourcesError
    >
  >
> {}

export const ListResourceSetResources =
  Binding.Service<ListResourceSetResources>("AWS.FMS.ListResourceSetResources");

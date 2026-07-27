import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link UpdateLibraryItemMetadata} — `instanceId` is injected from the bound Q App.
 */
export interface UpdateLibraryItemMetadataRequest extends Omit<
  qapps.UpdateLibraryItemMetadataInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:UpdateLibraryItemMetadata`.
 *
 * Updates a library item's verification badge (`isVerified`). Provide the implementation with
 * `Effect.provide(AWS.QApps.UpdateLibraryItemMetadataHttp)`.
 * @binding
 * @section Library Items
 * @example Mark a Library Item Verified
 * ```typescript
 * // init — bind the operation to the Q App
 * const updateLibraryItemMetadata = yield* AWS.QApps.UpdateLibraryItemMetadata(app);
 *
 * // runtime
 * yield* updateLibraryItemMetadata({ libraryItemId, isVerified: true });
 * ```
 */
export interface UpdateLibraryItemMetadata extends Binding.Service<
  UpdateLibraryItemMetadata,
  "AWS.QApps.UpdateLibraryItemMetadata",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: UpdateLibraryItemMetadataRequest,
    ) => Effect.Effect<
      qapps.UpdateLibraryItemMetadataResponse,
      qapps.UpdateLibraryItemMetadataError
    >
  >
> {}

export const UpdateLibraryItemMetadata =
  Binding.Service<UpdateLibraryItemMetadata>(
    "AWS.QApps.UpdateLibraryItemMetadata",
  );

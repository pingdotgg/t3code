import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Revision } from "./Revision.ts";

/**
 * Runtime binding for `dataexchange:ListRevisionAssets`.
 *
 * Enumerates the assets imported into the bound revision. The data set
 * and revision ids are injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListRevisionAssetsHttp)`.
 * @binding
 * @section Reading Revisions & Assets
 * @example List A Revision's Assets
 * ```typescript
 * const listAssets = yield* AWS.DataExchange.ListRevisionAssets(revision);
 *
 * // runtime
 * const { Assets } = yield* listAssets();
 * yield* Effect.log(`${(Assets ?? []).length} assets`);
 * ```
 */
export interface ListRevisionAssets extends Binding.Service<
  ListRevisionAssets,
  "AWS.DataExchange.ListRevisionAssets",
  (
    revision: Revision,
  ) => Effect.Effect<
    (
      request?: Omit<
        dataexchange.ListRevisionAssetsRequest,
        "DataSetId" | "RevisionId"
      >,
    ) => Effect.Effect<
      dataexchange.ListRevisionAssetsResponse,
      dataexchange.ListRevisionAssetsError
    >
  >
> {}
export const ListRevisionAssets = Binding.Service<ListRevisionAssets>(
  "AWS.DataExchange.ListRevisionAssets",
);

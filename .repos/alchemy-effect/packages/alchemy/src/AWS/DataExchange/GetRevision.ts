import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Revision } from "./Revision.ts";

/**
 * Runtime binding for `dataexchange:GetRevision`.
 *
 * Reads the bound revision's detail — comment, finalized state, and
 * revocation status. The data set and revision ids are injected from
 * the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.GetRevisionHttp)`.
 * @binding
 * @section Reading Revisions & Assets
 * @example Check A Revision's State
 * ```typescript
 * const getRevision = yield* AWS.DataExchange.GetRevision(revision);
 *
 * // runtime
 * const detail = yield* getRevision();
 * yield* Effect.log(`finalized: ${detail.Finalized}`);
 * ```
 */
export interface GetRevision extends Binding.Service<
  GetRevision,
  "AWS.DataExchange.GetRevision",
  (
    revision: Revision,
  ) => Effect.Effect<
    () => Effect.Effect<
      dataexchange.GetRevisionResponse,
      dataexchange.GetRevisionError
    >
  >
> {}
export const GetRevision = Binding.Service<GetRevision>(
  "AWS.DataExchange.GetRevision",
);

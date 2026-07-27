import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Revision } from "./Revision.ts";

/**
 * Runtime binding for `dataexchange:RevokeRevision`.
 *
 * Revokes the bound revision from subscribers with a required
 * revocation comment — the remediation path when bad or sensitive data
 * was published. The data set and revision ids are injected from the
 * binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.RevokeRevisionHttp)`.
 * @binding
 * @section Managing Assets
 * @example Revoke A Published Revision
 * ```typescript
 * const revokeRevision = yield* AWS.DataExchange.RevokeRevision(revision);
 *
 * // runtime
 * yield* revokeRevision({
 *   RevocationComment: "Published with corrupted price data",
 * });
 * ```
 */
export interface RevokeRevision extends Binding.Service<
  RevokeRevision,
  "AWS.DataExchange.RevokeRevision",
  (
    revision: Revision,
  ) => Effect.Effect<
    (
      request: Omit<
        dataexchange.RevokeRevisionRequest,
        "DataSetId" | "RevisionId"
      >,
    ) => Effect.Effect<
      dataexchange.RevokeRevisionResponse,
      dataexchange.RevokeRevisionError
    >
  >
> {}
export const RevokeRevision = Binding.Service<RevokeRevision>(
  "AWS.DataExchange.RevokeRevision",
);

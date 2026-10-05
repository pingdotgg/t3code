import type * as privateca from "@distilled.cloud/gcp/privateca_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CaPool } from "./CaPool.ts";

export interface FetchCaCertsRequest {
  /**
   * Optional UUID used to make the fetch idempotent for at least 60
   * minutes.
   */
  requestId?: string;
}

/**
 * Runtime binding for Certificate Authority Service `caPools.fetchCaCerts`.
 *
 * Bind this operation to a {@link CaPool} in a Function/Action init phase.
 * Provide {@link FetchCaCertsHttp}. Returns PEM CA certificate chains for
 * authorities in the ENABLED, DISABLED, or STAGED states.
 *
 * ### Fetching CA Certificates
 * **Example:** Fetch the pool's trust anchors
 * ```typescript
 * const fetchCaCerts = yield* GCP.PrivateCA.FetchCaCerts(pool);
 * const { caCerts } = yield* fetchCaCerts();
 * ```
 *
 * @binding
 * @category PrivateCA
 */
export interface FetchCaCerts extends Binding.Service<
  FetchCaCerts,
  "GCP.PrivateCA.FetchCaCerts",
  (
    pool: CaPool,
  ) => Effect.Effect<
    (
      request?: FetchCaCertsRequest,
    ) => Effect.Effect<
      privateca.FetchCaCertsResponse,
      privateca.FetchCaCertsProjectsLocationsCaPoolsError,
      RuntimeContext
    >
  >
> {}

export const FetchCaCerts = Binding.Service<FetchCaCerts>(
  "GCP.PrivateCA.FetchCaCerts",
);

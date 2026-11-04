import * as privateca from "@distilled.cloud/gcp/privateca_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { CaPool } from "./CaPool.ts";
import { FetchCaCerts, type FetchCaCertsRequest } from "./FetchCaCerts.ts";

/**
 * HTTP implementation of {@link FetchCaCerts}.
 *
 * @layer
 * @provides GCP.PrivateCA.FetchCaCerts
 */
export const FetchCaCertsHttp = Layer.effect(
  FetchCaCerts,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const fetchCaCertsProjectsLocationsCaPools = yield* GCPBindings.withCredentials(
      privateca.fetchCaCertsProjectsLocationsCaPools,
    );
    return Effect.fn(function* <P extends CaPool>(pool: P) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.PrivateCA.FetchCaCerts(${pool})`({
          iam: [
            grantFor({ role: "roles/privateca.poolReader", on: "privateca.caPool" }, pool.name),
          ],
        });
      }
      const name = yield* pool.name;
      return Effect.fn(`GCP.PrivateCA.FetchCaCerts(${pool.LogicalId})`)(function* (
        request?: FetchCaCertsRequest,
      ) {
        return yield* fetchCaCertsProjectsLocationsCaPools({
          caPool: yield* name,
          body: request?.requestId !== undefined ? { requestId: request.requestId } : {},
        });
      });
    });
  }),
);

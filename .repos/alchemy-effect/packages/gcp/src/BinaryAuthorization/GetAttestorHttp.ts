import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Attestor } from "./Attestor.ts";
import { GetAttestor, type GetAttestorRequest } from "./GetAttestor.ts";

/**
 * HTTP implementation of {@link GetAttestor}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.GetAttestor
 */
export const GetAttestorHttp = Layer.effect(
  GetAttestor,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getAttestor = yield* GCPBindings.withCredentials(
      binaryauthorization.getProjectsAttestors,
    );
    return Effect.fn(function* (attestor: Attestor) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BinaryAuthorization.GetAttestor(${attestor})`({
          iam: [
            grantFor(
              {
                role: "roles/binaryauthorization.attestorsViewer",
                on: "binaryauthorization.attestor",
              },
              attestor.name,
            ),
          ],
        });
      }
      const name = yield* attestor.name;
      return Effect.fn(`GCP.BinaryAuthorization.GetAttestor(${attestor.LogicalId})`)(function* (
        request?: GetAttestorRequest,
      ) {
        const attestorName = yield* name;
        return yield* getAttestor({
          ...request,
          name: attestorName,
        });
      });
    });
  }),
);

import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Attestor } from "./Attestor.ts";
import { GetAttestor, type GetAttestorRequest } from "./GetAttestor.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link GetAttestor}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.GetAttestor
 */
export const GetAttestorHttp = Layer.effect(
  GetAttestor,
  Effect.gen(function* () {
    const getAttestor = yield* binaryauthorization.getProjectsAttestors;
    return Effect.fn(function* (attestor: Attestor) {
      yield* bindGcpHost({
        tag: "GCP.BinaryAuthorization.GetAttestor",
        resource: attestor,
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
      const name = yield* attestor.name;
      return Effect.fn(
        `GCP.BinaryAuthorization.GetAttestor(${attestor.LogicalId})`,
      )(function* (request?: GetAttestorRequest) {
        const attestorName = yield* name;
        return yield* getAttestor({
          ...request,
          name: attestorName,
        });
      });
    });
  }),
);

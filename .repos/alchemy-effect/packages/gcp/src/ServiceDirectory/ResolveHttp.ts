import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import { Resolve, type ResolveRequest } from "./Resolve.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of {@link Resolve}.
 *
 * @layer
 * @provides GCP.ServiceDirectory.Resolve
 */
export const ResolveHttp = Layer.effect(
  Resolve,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const resolveProjectsLocationsNamespacesServices = yield* GCPBindings.withCredentials(
      servicedirectory.resolveProjectsLocationsNamespacesServices,
    );
    return Effect.fn(function* <S extends Service>(service: S) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.ServiceDirectory.Resolve(${service})`({
          iam: [
            grantFor(
              {
                role: "roles/servicedirectory.viewer",
                on: "servicedirectory.service",
              },
              service.name,
            ),
          ],
        });
      }
      const name = yield* service.name;
      return Effect.fn(`GCP.ServiceDirectory.Resolve(${service.LogicalId})`)(function* (
        request?: ResolveRequest,
      ) {
        return yield* resolveProjectsLocationsNamespacesServices({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);

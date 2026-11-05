import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import { GetService, type GetServiceRequest } from "./GetService.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of {@link GetService}.
 *
 * @layer
 * @provides GCP.Run.GetService
 */
export const GetServiceHttp = Layer.effect(
  GetService,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const get = yield* GCPBindings.withCredentials(cloudrun.getProjectsLocationsServices);
    return Effect.fn(function* <T extends Service>(service: T) {
      const name = yield* service.name;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Run.GetService(${service})`({
          iam: [grantFor({ role: "roles/run.viewer", on: "run.service" }, service.name)],
        });
      }
      return Effect.fn(`GCP.Run.GetService(${service.LogicalId})`)(function* (
        request?: GetServiceRequest,
      ) {
        return yield* get({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);

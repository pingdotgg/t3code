import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import { GetWorkerPool, type GetWorkerPoolRequest } from "./GetWorkerPool.ts";
import type { WorkerPool } from "./WorkerPool.ts";

/**
 * HTTP implementation of {@link GetWorkerPool}.
 *
 * @layer
 * @provides GCP.Run.GetWorkerPool
 */
export const GetWorkerPoolHttp = Layer.effect(
  GetWorkerPool,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getProjectsLocationsWorkerPools = yield* GCPBindings.withCredentials(
      cloudrun.getProjectsLocationsWorkerPools,
    );
    return Effect.fn(function* <T extends WorkerPool>(pool: T) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Run.GetWorkerPool(${pool})`({
          iam: [grantFor({ role: "roles/run.viewer", on: "run.workerPool" }, pool.name)],
        });
      }
      const name = yield* pool.name;
      return Effect.fn(`GCP.Run.GetWorkerPool(${pool.LogicalId})`)(function* (
        request?: GetWorkerPoolRequest,
      ) {
        return yield* getProjectsLocationsWorkerPools({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);

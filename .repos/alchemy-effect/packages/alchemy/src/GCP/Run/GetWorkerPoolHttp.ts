import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GetWorkerPool, type GetWorkerPoolRequest } from "./GetWorkerPool.ts";
import type { WorkerPool } from "./WorkerPool.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link GetWorkerPool}.
 *
 * @layer
 * @provides GCP.Run.GetWorkerPool
 */
export const GetWorkerPoolHttp = Layer.effect(
  GetWorkerPool,
  Effect.gen(function* () {
    const getProjectsLocationsWorkerPools =
      yield* cloudrun.getProjectsLocationsWorkerPools;
    return Effect.fn(function* <T extends WorkerPool>(pool: T) {
      yield* bindGcpHost({
        tag: "GCP.Run.GetWorkerPool",
        resource: pool,
        iam: [
          grantFor(
            { role: "roles/run.viewer", on: "run.workerPool" },
            pool.name,
          ),
        ],
      });
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

import type * as cloudrun from "@distilled.cloud/gcp/run_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { WorkerPool } from "./WorkerPool.ts";

export interface GetWorkerPoolRequest extends Omit<
  cloudrun.GetProjectsLocationsWorkerPoolsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Run `workerPools.get`.
 *
 * Bind this operation to a {@link WorkerPool} in a Function/Action init
 * phase. Provide {@link GetWorkerPoolHttp}.
 *
 * ### Reading a Worker Pool
 * **Example:** Get the bound worker pool
 * ```typescript
 * const getWorkerPool = yield* GCP.Run.GetWorkerPool(pool);
 * const live = yield* getWorkerPool();
 * ```
 *
 * @binding
 * @category Run
 */
export interface GetWorkerPool extends Binding.Service<
  GetWorkerPool,
  "GCP.Run.GetWorkerPool",
  (
    pool: WorkerPool,
  ) => Effect.Effect<
    (
      request?: GetWorkerPoolRequest,
    ) => Effect.Effect<
      cloudrun.GoogleCloudRunV2WorkerPool,
      cloudrun.GetProjectsLocationsWorkerPoolsError,
      RuntimeContext
    >
  >
> {}

export const GetWorkerPool = Binding.Service<GetWorkerPool>(
  "GCP.Run.GetWorkerPool",
);

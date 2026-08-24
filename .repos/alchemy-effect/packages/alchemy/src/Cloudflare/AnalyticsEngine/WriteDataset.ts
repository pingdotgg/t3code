import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Dataset as AnalyticsEngineDatasetLike } from "./Dataset.ts";

/**
 * Bind an {@link AnalyticsEngineDatasetLike} dataset to a Worker and obtain the
 * Effect-native client (`writeDataPoint`, `raw`).
 *
 * `WriteDataset` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.AnalyticsEngine.WriteDataset(dataset)`.
 *
 * @binding
 * @product Analytics Engine
 * @category Observability & Analytics
 *
 * @example Write a data point inside a Worker
 * ```typescript
 * const analytics = yield* Cloudflare.AnalyticsEngine.WriteDataset(Dataset);
 * yield* analytics.writeDataPoint({ blobs: ["signup"] });
 * ```
 */
export interface WriteDataset extends Binding.Service<
  WriteDataset,
  "Cloudflare.AnalyticsEngineDataset.WriteDataset",
  (dataset: AnalyticsEngineDatasetLike) => Effect.Effect<DatasetClient>
> {}

export const WriteDataset = Binding.Service<WriteDataset>(
  "Cloudflare.AnalyticsEngineDataset.WriteDataset",
);

export interface DataPoint {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
}

export interface RuntimeAnalyticsEngineDataset {
  writeDataPoint(dataPoint: DataPoint): void;
}

export class DatasetError extends Data.TaggedError("DatasetError")<{
  message: string;
  cause: Error;
}> {}

export interface DatasetClient {
  raw: Effect.Effect<RuntimeAnalyticsEngineDataset, never, RuntimeContext>;
  writeDataPoint(
    dataPoint: DataPoint,
  ): Effect.Effect<void, DatasetError, RuntimeContext>;
}

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Dataset as AnalyticsEngineDatasetLike } from "./Dataset.ts";
import {
  DatasetError,
  type DatasetClient,
  type RuntimeAnalyticsEngineDataset,
  WriteDataset,
} from "./WriteDataset.ts";

export const WriteDatasetBinding = Layer.effect(
  WriteDataset,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (dataset: AnalyticsEngineDatasetLike) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind(dataset.name, {
          bindings: [
            {
              type: "analytics_engine",
              name: dataset.name,
              dataset: dataset.dataset,
            },
          ],
        });
      }

      const raw = Effect.sync(
        () =>
          (env as Record<string, RuntimeAnalyticsEngineDataset>)[dataset.name]!,
      );

      return {
        raw,
        writeDataPoint: (dataPoint) =>
          raw.pipe(
            Effect.flatMap((raw) =>
              Effect.try({
                try: () => raw.writeDataPoint(dataPoint),
                catch: (error: any) =>
                  new DatasetError({
                    message: error?.message ?? "Unknown error",
                    cause: error,
                  }),
              }),
            ),
          ),
      } satisfies DatasetClient;
    });
  }),
);

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { AnalyticsEngineDataset as AnalyticsEngineDatasetLike } from "./AnalyticsEngineDataset.ts";

export interface AnalyticsEngineDataPoint {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
}

export interface RuntimeAnalyticsEngineDataset {
  writeDataPoint(dataPoint: AnalyticsEngineDataPoint): void;
}

export class AnalyticsEngineDatasetError extends Data.TaggedError(
  "AnalyticsEngineDatasetError",
)<{
  message: string;
  cause: Error;
}> {}

export interface AnalyticsEngineDatasetClient {
  raw: Effect.Effect<RuntimeAnalyticsEngineDataset, never, RuntimeContext>;
  writeDataPoint(
    dataPoint: AnalyticsEngineDataPoint,
  ): Effect.Effect<void, AnalyticsEngineDatasetError, RuntimeContext>;
}

export class AnalyticsEngineDatasetBinding extends Binding.Service<
  AnalyticsEngineDatasetBinding,
  (
    dataset: AnalyticsEngineDatasetLike,
  ) => Effect.Effect<AnalyticsEngineDatasetClient>
>()("Cloudflare.AnalyticsEngineDataset.Binding") {}

export const AnalyticsEngineDatasetBindingLive = Layer.effect(
  AnalyticsEngineDatasetBinding,
  Effect.gen(function* () {
    const bind = yield* AnalyticsEngineDatasetBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fnUntraced(function* (dataset: AnalyticsEngineDatasetLike) {
      yield* bind(dataset);

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
                  new AnalyticsEngineDatasetError({
                    message: error?.message ?? "Unknown error",
                    cause: error,
                  }),
              }),
            ),
          ),
      } satisfies AnalyticsEngineDatasetClient;
    });
  }),
);

export class AnalyticsEngineDatasetBindingPolicy extends Binding.Policy<
  AnalyticsEngineDatasetBindingPolicy,
  (dataset: AnalyticsEngineDatasetLike) => Effect.Effect<void>
>()("Cloudflare.AnalyticsEngineDataset.Binding") {}

export const AnalyticsEngineDatasetBindingPolicyLive =
  AnalyticsEngineDatasetBindingPolicy.layer.succeed(
    Effect.fnUntraced(function* (
      host: ResourceLike,
      dataset: AnalyticsEngineDatasetLike,
    ) {
      if (isWorker(host)) {
        yield* host.bind(dataset.name, {
          bindings: [
            {
              type: "analytics_engine",
              name: dataset.name,
              dataset: dataset.dataset,
            },
          ],
        });
      } else {
        return yield* Effect.die(
          new Error(
            `AnalyticsEngineDatasetBinding does not support runtime '${host.Type}'`,
          ),
        );
      }
    }),
  );

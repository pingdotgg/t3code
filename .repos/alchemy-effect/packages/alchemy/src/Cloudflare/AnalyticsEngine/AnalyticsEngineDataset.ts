import * as Effect from "effect/Effect";
import { AnalyticsEngineDatasetBinding } from "./AnalyticsEngineDatasetBinding.ts";

type AnalyticsEngineDatasetTypeId = typeof AnalyticsEngineDatasetTypeId;
const AnalyticsEngineDatasetTypeId =
  "Cloudflare.AnalyticsEngineDataset" as const;

export type AnalyticsEngineDatasetProps = {
  /**
   * Dataset name. If omitted, the logical ID is used.
   */
  dataset?: string;
};

/**
 * A Cloudflare Workers Analytics Engine dataset binding.
 *
 * Analytics Engine datasets are configured as Worker bindings. The binding
 * exposes `writeDataPoint()` at runtime and does not require separate
 * provisioning through the Cloudflare API.
 *
 * @resource
 *
 * @section Binding to a Worker
 * @example Basic Analytics Engine binding
 * ```typescript
 * const Analytics = yield* Cloudflare.AnalyticsEngineDataset("Analytics", {
 *   dataset: "app-events",
 * });
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   bindings: { Analytics },
 * });
 * ```
 *
 * @example Effect-style worker
 * ```typescript
 * const analytics = yield* Cloudflare.AnalyticsEngineDataset.bind(Analytics);
 * yield* analytics.writeDataPoint({ blobs: ["signup"] });
 * ```
 */
export type AnalyticsEngineDataset = {
  kind: AnalyticsEngineDatasetTypeId;
  name: string;
  dataset: string;
};

export const isAnalyticsEngineDataset = (
  value: unknown,
): value is AnalyticsEngineDataset =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as AnalyticsEngineDataset).kind === AnalyticsEngineDatasetTypeId;

export const AnalyticsEngineDataset: {
  (
    name: string,
    props?: AnalyticsEngineDatasetProps,
  ): Effect.Effect<AnalyticsEngineDataset>;
  /**
   * Bind Analytics Engine to the surrounding Worker, returning an
   * Effect-native client with access to the native Workers runtime binding.
   */
  bind: typeof AnalyticsEngineDatasetBinding.bind;
} = Object.assign(
  Effect.fnUntraced(function* (
    name: string,
    props?: AnalyticsEngineDatasetProps,
  ) {
    return {
      kind: AnalyticsEngineDatasetTypeId,
      name,
      dataset: props?.dataset ?? name,
    } satisfies AnalyticsEngineDataset;
  }),
  {
    bind: (...args: Parameters<typeof AnalyticsEngineDatasetBinding.bind>) =>
      AnalyticsEngineDatasetBinding.bind(...args),
  },
);

import * as Effect from "effect/Effect";

type TypeId = typeof TypeId;
const TypeId = "Cloudflare.AnalyticsEngine.Dataset" as const;

export type DatasetProps = {
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
 * const Analytics = yield* Cloudflare.AnalyticsEngine.Dataset("Analytics", {
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
 * const analytics = yield* Cloudflare.AnalyticsEngine.WriteDataset(Analytics);
 * yield* analytics.writeDataPoint({ blobs: ["signup"] });
 * ```
 */
export type Dataset = {
  kind: TypeId;
  name: string;
  dataset: string;
};

export const isDataset = (value: unknown): value is Dataset =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as Dataset).kind === TypeId;

export const Dataset: {
  (name: string, props?: DatasetProps): Effect.Effect<Dataset>;
} = Effect.fn(function* (name: string, props?: DatasetProps) {
  return {
    kind: TypeId,
    name,
    dataset: props?.dataset ?? name,
  } satisfies Dataset;
});

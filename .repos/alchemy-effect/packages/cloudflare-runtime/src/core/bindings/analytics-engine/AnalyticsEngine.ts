import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
const AnalyticsEngineWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/analytics-engine/analytics-engine.worker",
    ),
};
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";

export class AnalyticsEngine extends Plugin.Service<AnalyticsEngine>()(
  "cloudflare-runtime/plugin/AnalyticsEngine",
) {}

const EXTENSION_MODULE_NAME = "cloudflare-runtime:analytics-engine";

export const AnalyticsEngineLive = Layer.succeed(
  AnalyticsEngine,
  AnalyticsEngine.of(
    Effect.map(formatExtensionModule(AnalyticsEngineWorker), (esModule) => ({
      extensions: [
        {
          modules: [
            {
              name: EXTENSION_MODULE_NAME,
              internal: true,
              esModule,
            },
          ],
        },
      ],
    })),
  ),
);

/**
 * No-op local Analytics Engine binding. Matches Miniflare's behavior:
 * `writeDataPoint` is accepted but discarded in dev.
 */
export const local = (
  binding: string,
  dataset: string,
): BindingHook<AnalyticsEngine> =>
  Plugin.useSync(AnalyticsEngine, () => ({
    name: binding,
    wrapped: {
      moduleName: EXTENSION_MODULE_NAME,
      innerBindings: [{ name: "dataset", json: JSON.stringify(dataset) }],
    },
  }));

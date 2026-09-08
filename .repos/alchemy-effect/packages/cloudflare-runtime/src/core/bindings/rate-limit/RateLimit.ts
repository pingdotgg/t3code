import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
const RateLimitBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/rate-limit/RateLimitBinding.worker",
    ),
};
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import type { RateLimitProps } from "./RateLimitProps.shared.ts";

export class RateLimit extends Plugin.Service<RateLimit>()(
  "cloudflare-runtime/plugin/RateLimit",
) {}

export const RateLimitLive = Layer.succeed(
  RateLimit,
  RateLimit.of(
    Effect.map(formatExtensionModule(RateLimitBindingWorker), (esModule) => ({
      extensions: [
        {
          modules: [
            {
              name: "cloudflare-runtime:rate-limit",
              internal: true,
              esModule,
            },
          ],
        },
      ],
    })),
  ),
);

export const local = (props: RateLimitProps): BindingHook<RateLimit> =>
  Plugin.useSync(RateLimit, () => ({
    name: props.binding,
    wrapped: {
      moduleName: "cloudflare-runtime:rate-limit",
      innerBindings: [
        {
          name: "PROPS",
          json: JSON.stringify(props),
        },
      ],
    },
  }));

import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
const HyperdriveBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/hyperdrive/hyperdrive-binding.worker",
    ),
};
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import * as PluginContext from "../../PluginContext.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type { HyperdriveOrigin } from "./HyperdriveOrigin.shared.ts";

export class Hyperdrive extends Plugin.Service<
  Hyperdrive,
  Record<string, HyperdriveOrigin>
>()("cloudflare-runtime/plugin/Hyperdrive") {}

export const HyperdriveLive = Layer.succeed(
  Hyperdrive,
  Hyperdrive.of(
    PluginContext.use(({ worker: { hyperdrives } }) => {
      if (!hyperdrives || Object.keys(hyperdrives).length === 0)
        return Effect.succeed({ api: {} });
      return Effect.map(
        formatExtensionModule(HyperdriveBindingWorker),
        (esModule) => ({
          extensions: [
            {
              modules: [
                {
                  name: "cloudflare-runtime:hyperdrive",
                  internal: true,
                  esModule,
                },
              ],
            },
          ],
          api: hyperdrives,
        }),
      );
    }),
  ),
);

export const local = (
  binding: string,
  hyperdriveId: string,
): BindingHook<Hyperdrive> =>
  Plugin.use(Hyperdrive, (hyperdrive) =>
    hyperdrive.api[hyperdriveId]
      ? Effect.succeed({
          name: binding,
          wrapped: {
            moduleName: "cloudflare-runtime:hyperdrive",
            innerBindings: [
              {
                name: "ORIGIN",
                json: JSON.stringify(hyperdrive.api[hyperdriveId]),
              },
            ],
          },
        })
      : Effect.fail(
          new ConfigError({
            subtag: "HyperdriveOriginMissing",
            message: `No hyperdrive origin was provided for binding "${binding}" (id: ${hyperdriveId}).`,
            hint: `Add an entry for "${hyperdriveId}" to \`worker.hyperdrives\`.`,
            detail: { binding, hyperdriveId },
          }),
        ),
  );

import {
  makeDeployTarget,
  type DeployTarget,
  type DeployTargetServer,
} from "@alchemy.run/frontend-frameworks/core";
import * as Miniflare from "../miniflare/miniflare.ts";
import {
  moduleTypeFromExtension,
  type MiniflareModule,
} from "../miniflare/miniflare-module.ts";
import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Path from "effect/Path";
import type * as Options from "./Options.ts";

/**
 * The e2e harness's Cloudflare deploy target: a framework-core `DeployTarget`
 * value whose `serve` boots miniflare over a `BuildOutput` (the
 * preview-parity engine the harness has always used for `e2e preview` / the
 * Playwright `live` mode). Serving built output is *architecturally* the
 * target's concern — the implementation lives in the harness for now because
 * miniflare is a harness dependency.
 */
export interface CloudflareTarget extends DeployTarget<Options.CloudflareTargetOptions> {
  /** Always available on the harness's cloudflare target. */
  readonly serve: NonNullable<DeployTarget["serve"]>;
}

/**
 * Miniflare requires a script even for an assets-only deploy, so when a
 * `BuildOutput` carries no server modules (and the preview config hand-rolls
 * none), this stub stands in behind `routerConfig.has_user_worker: false`.
 * Every real request must be answered by the asset layer — a request reaching
 * the stub means the routing is misconfigured, so it 500s loudly.
 */
const ASSETS_ONLY_STUB: MiniflareModule = {
  type: "ESModule",
  path: "__assets-only-stub.js",
  contents: `export default { fetch: () => new Response("assets-only build: no user worker — a request reached the stub, so asset routing is misconfigured", { status: 500 }) }`,
};

export const makeCloudflareTarget = (
  config: Options.CloudflareTargetOptions,
): CloudflareTarget =>
  makeDeployTarget({
    platform: "cloudflare",
    config,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    serve: (context) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const preview = config.preview ?? {};
        const build = context.output;
        const modules = build.serverModules?.flatMap(
          (module): MiniflareModule | Array<MiniflareModule> => {
            const type = moduleTypeFromExtension(path.extname(module.name));
            if (type === "SourceMap") {
              return [];
            }
            return {
              path: module.name,
              type,
              contents: module.content as
                | string
                | Uint8Array<ArrayBuffer>
                | undefined,
            };
          },
        );
        // Assets-only build: no server modules in the BuildOutput and none
        // hand-rolled in the preview config. The harness synthesizes the
        // stub script miniflare requires and routes every request to the
        // asset layer (`has_user_worker: false`) — fixtures don't hand-roll
        // stubs.
        const resolvedModules = modules ?? preview.modules;
        const assetsOnly =
          resolvedModules === undefined || resolvedModules.length === 0;
        const instance = yield* Effect.acquireDisposable(
          Effect.promise(
            async () =>
              await Miniflare.createMiniflare({
                ...preview,
                assets:
                  preview.assets && build.clientDirectory
                    ? {
                        ...preview.assets,
                        directory: build.clientDirectory,
                        ...(assetsOnly
                          ? {
                              routerConfig: {
                                ...preview.assets.routerConfig,
                                has_user_worker: false,
                              },
                            }
                          : undefined),
                      }
                    : undefined,
                modules: assetsOnly ? [ASSETS_ONLY_STUB] : resolvedModules,
              }),
          ),
        );
        return {
          url: instance.url.toString(),
          // miniflare's Response type differs nominally from the DOM's; the
          // harness has always cast across this boundary.
          fetch: cast<
            Miniflare.MiniflareInstance["fetch"],
            DeployTargetServer["fetch"]
          >(instance.fetch),
        };
      }),
  });

import type { InputProps } from "alchemy/Input";
import { effectClass } from "alchemy/Util/effect";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type ViteOptions,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface FoldkitProps<Bindings extends WorkerBindingProps = {}> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle" | "rules"
> {
  /**
   * Custom Worker entry for a client-only app. Relative paths resolve from
   * {@link rootDir}; the Worker can serve client assets through `ASSETS`.
   * Cannot be combined with Foldkit's `ssr.build`, which generates the
   * Worker handler from the app's server entry.
   */
  main?: string;
  /**
   * Foldkit project root directory, resolved from the working directory.
   * @default process.cwd()
   */
  rootDir?: string;
  /**
   * Controls which files are content-hashed to decide whether to rebuild.
   * Defaults to non-gitignored project files and the nearest lockfile, with
   * imported workspaces detected from the build. See {@link ViteOptions.memo}.
   */
  memo?: ViteOptions["memo"];
  /**
   * Overrides static asset routing defaults. Client-only apps use
   * `notFoundHandling: "single-page-application"`. SSR and prerendered apps
   * serve matching assets and send unmatched requests to Foldkit's handler.
   * Explicit options take precedence over these defaults.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a [Foldkit](https://foldkit.dev) app.
 *
 * Builds the project's Vite configuration and deploys its client assets
 * and generated server handler. Configure rendering in the app's
 * `foldkit(...)` plugin call; Alchemy derives asset routing from the
 * plugin's completed build metadata.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * ### Deploying a Foldkit App
 * The same declaration supports client-only, server-rendered, and
 * prerendered apps.
 *
 * **Example:** Foldkit app
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website");
 * ```
 *
 * **Example:** Foldkit project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   rootDir: "apps/web",
 * });
 * ```
 *
 * ### Server Rendering and Prerendering
 * Enable `ssr.build` to generate the Worker handler. Foldkit manages the
 * shared hydration identity for the client and server automatically.
 * Requires `@foldkit/vite-plugin` 0.27.0 or newer and a compatible Foldkit
 * version (0.167.0 or newer). Import CSS from the client entry and export
 * `renderDocument = Server.renderDocument` alongside `renderPage` in the
 * server entry. SSR/SSG documents are generated from code; no source index.html is needed.
 *
 * **Example:** vite.config.ts for a server-rendered app
 * ```typescript
 * import { foldkit } from "@foldkit/vite-plugin";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [
 *     foldkit({
 *       ssr: {
 *         serverEntry: "/src/entry.server.ts",
 *         clientEntry: "/src/entry.ts",
 *         build: true,
 *       },
 *     }),
 *   ],
 * });
 * ```
 *
 * **Example:** Prerendering the server entry's `prerenderPaths`
 * ```typescript
 * foldkit({
 *   ssr: {
 *     serverEntry: "/src/entry.server.ts",
 *     clientEntry: "/src/entry.ts",
 *     build: { prerender: true },
 *   },
 * });
 * ```
 *
 * ### Asset Routing
 * Use `assets` to override the rendering mode's defaults (see
 * {@link FoldkitProps.assets}).
 *
 * **Example:** Client-only app with a custom 404 page
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * ### Custom Worker Entry
 * For a client-only app with API routes or other Worker handlers, set
 * `main` and route those requests through the Worker. Bindings in `env`
 * are available to the Worker, not to browser code.
 *
 * **Example:** Custom Worker with a KV binding
 * ```typescript
 * const ticker = yield* Cloudflare.KV.Namespace("Ticker");
 *
 * const site = yield* Cloudflare.Website.Foldkit("Platform", {
 *   main: "src/worker.ts",
 *   env: { TICKER: ticker },
 *   assets: { runWorkerFirst: ["/api/*"] },
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * Narrow the files hashed for rebuilds while retaining the Vite config
 * and lockfile as build inputs.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   memo: {
 *     include: [
 *       "src/**",
 *       "public/**",
 *       "index.html",
 *       "vite.config.ts",
 *       "package.json",
 *     ],
 *     lockfile: true,
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Use the class form when other resources need to reference the Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Foldkit<Website>()("Website") {}
 *
 * const site = yield* Website;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const Foldkit: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<FoldkitProps<Bindings>>
        | Effect.Effect<InputProps<FoldkitProps<Bindings>>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>]: NormalizedBindings<
          Bindings,
          WorkerAssetsConfig
        >[binding];
      }>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | InputProps<FoldkitProps<Bindings>>
      | Effect.Effect<InputProps<FoldkitProps<Bindings>>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>]: NormalizedBindings<
        Bindings,
        WorkerAssetsConfig
      >[binding];
    }>,
    never,
    Req | Providers
  >;
} = (<const Bindings extends WorkerBindingProps = {}, Req = never>(
  id?: string,
  propsEff?:
    | InputProps<FoldkitProps<Bindings>>
    | Effect.Effect<InputProps<FoldkitProps<Bindings>>, never, Req>,
) =>
  id === undefined
    ? <const Bindings extends WorkerBindingProps = {}, Req = never>(
        id: string,
        propsEff?:
          | InputProps<FoldkitProps<Bindings>>
          | Effect.Effect<InputProps<FoldkitProps<Bindings>>, never, Req>,
      ) => effectClass(Foldkit(id, propsEff))
    : Worker(
        id,
        Effect.map(Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff), (props) => {
          const { main, rootDir, memo, ...workerProps } = props ?? {};
          return {
            ...workerProps,
            vite: {
              framework: "foldkit" as const,
              main,
              rootDir,
              memo,
            },
          };
        }),
      )) as any;

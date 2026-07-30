import * as Effect from "effect/Effect";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
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

export interface ViteProps<Bindings extends WorkerBindingProps = {}>
  extends Omit<WorkerProps<Bindings>, "vite" | "main" | "assets">, ViteOptions {
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a Vite project.
 *
 * `Vite` uses the Cloudflare Vite plugin to build both the server bundle
 * and client assets in a single `vite build` invocation — no manual
 * `main` entrypoint, build command, output directory, or Wrangler
 * configuration required.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 *
 * @section Deploying a Static Site
 * For a pure static site (no SSR), a single call is all you need.
 * Vite builds the project and Alchemy deploys the output as a
 * Cloudflare Worker with static assets.
 *
 * @example Static Vite site
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Website");
 * ```
 *
 * @section SSR Frameworks
 * For SSR frameworks like TanStack Start or SolidStart, enable
 * `nodejs_compat` so the server bundle can use Node.js APIs.
 *
 * @example TanStack Start
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("TanStackStart", {
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 * });
 * ```
 *
 * @example SolidStart with worker-first routing
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("SolidStart", {
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 *   assets: { runWorkerFirst: true },
 * });
 * ```
 *
 * @section React Server Components
 * Frameworks that emit more than one server environment (e.g. React
 * Server Components, which split into an `rsc` environment and an `ssr`
 * environment) need `viteEnvironments` to declare which environment
 * produces the deployed Worker entry and which additional server
 * environments to bundle alongside it. The `client` environment is
 * always deployed as static assets.
 *
 * @example React Router with RSC
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("ReactRouterRSC", {
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 *   viteEnvironments: {
 *     entry: "rsc",
 *     children: ["ssr"],
 *   },
 * });
 * ```
 *
 * @section Custom Worker Entry
 * By default the deployed Worker entry is the server bundle the
 * framework produces. When the Worker must export more than the
 * framework's fetch handler — Durable Object classes, additional
 * handlers — point `main` at your own module that wraps the framework
 * handler and re-exports the extras. `main` takes precedence over any
 * entry configured in the Vite config.
 *
 * @example Custom entry hosting Durable Objects
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("App", {
 *   main: "worker/index.ts",
 *   viteEnvironments: {
 *     entry: "rsc",
 *     children: ["ssr"],
 *   },
 * });
 * ```
 *
 * @section Single-Page Applications
 * For SPAs (React, Vue, etc.), configure asset handling so all
 * routes fall back to `index.html`.
 *
 * @example Vue SPA
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("Vue", {
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 *   assets: {
 *     htmlHandling: "auto-trailing-slash",
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether
 * a rebuild is needed. Use `memo` to narrow the scope when your
 * project has large directories that don't affect the build output.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Docs", {
 *   memo: {
 *     include: ["src/**", "content/**", "package.json"],
 *   },
 * });
 * ```
 *
 * @section Class Form
 * Calling `Vite` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both
 * an `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Vite<Website>()("Website", {
 *   compatibility: { flags: ["nodejs_compat"] },
 * }) {}
 *
 * const site = yield* Website;
 * ```
 */
export const Vite: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<ViteProps<Bindings>>
        | Effect.Effect<InputProps<ViteProps<Bindings>>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [binding in keyof NormalizedBindings<
          Bindings,
          WorkerAssetsConfig
        >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
      }>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | InputProps<ViteProps<Bindings>>
      | Effect.Effect<InputProps<ViteProps<Bindings>>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [binding in keyof NormalizedBindings<
        Bindings,
        WorkerAssetsConfig
      >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
    }>,
    never,
    Req | Providers
  >;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(Vite(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            main: undefined!,
            vite: {
              main: props?.main,
              rootDir: props?.rootDir,
              memo: props?.memo,
              viteEnvironments: props?.viteEnvironments,
            },
          }),
        ),
      )) as any;

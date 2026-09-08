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
 *
 * ### Deploying a Static Site
 * For a pure static site (no SSR), a single call is all you need.
 * Vite builds the project and Alchemy deploys the output as a
 * Cloudflare Worker with static assets.
 *
 * **Example:** Static Vite site
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Website");
 * ```
 *
 * ### SSR Frameworks
 * SSR frameworks like TanStack Start or SolidStart work with a single
 * call — the `nodejs_compat` compatibility flag is enabled by default
 * so the server bundle can use Node.js APIs.
 *
 * **Example:** TanStack Start
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("TanStackStart");
 * ```
 *
 * **Example:** SolidStart with worker-first routing
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("SolidStart", {
 *   assets: { runWorkerFirst: true },
 * });
 * ```
 *
 * **Example:** React Router
 * React Router's server build (`virtual:react-router/server-build`) is a
 * build manifest with no default export, so it cannot be deployed as the
 * Worker entry directly. Point `main` at a module that wraps it with
 * `createRequestHandler` (React Router's Cloudflare template ships this
 * as `workers/app.ts`):
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("ReactRouter", {
 *   main: "workers/app.ts",
 * });
 * ```
 *
 * ### React Server Components
 * Frameworks that emit more than one server environment (e.g. React
 * Server Components, which split into an `rsc` environment and an `ssr`
 * environment) need `viteEnvironments` to declare which environment
 * produces the deployed Worker entry and which additional server
 * environments to bundle alongside it. The `client` environment is
 * always deployed as static assets.
 *
 * **Example:** React Router with RSC
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("ReactRouterRSC", {
 *   viteEnvironments: {
 *     entry: "rsc",
 *     children: ["ssr"],
 *   },
 * });
 * ```
 *
 * ### Custom Worker Entry
 * By default the deployed Worker entry is the server bundle the
 * framework produces. When the Worker must export more than the
 * framework's fetch handler — Durable Object classes, additional
 * handlers — point `main` at your own module that wraps the framework
 * handler and re-exports the extras. `main` takes precedence over any
 * entry configured in the Vite config.
 *
 * **Example:** Custom entry hosting Durable Objects
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
 * ### Single-Page Applications
 * For SPAs (React, Vue, etc.), configure asset handling so unmatched
 * routes fall back to `index.html` and the client router takes over.
 *
 * **Example:** Vue SPA
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("Vue", {
 *   assets: {
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 *
 * **Example:** Foldkit
 * [Foldkit](https://foldkit.dev) apps are client-only Vite projects, so a
 * single call deploys them — the Foldkit Vite plugin in the app's own
 * `vite.config.ts` composes with the injected Cloudflare plugin. Enable
 * `single-page-application` not-found handling so deep links boot the app:
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("Foldkit", {
 *   assets: {
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 * {@link Foldkit | Cloudflare.Website.Foldkit} is the same thing with that
 * default already applied.
 *
 * **Example:** Octane SPA
 * A client-only [OctaneJS](https://octanejs.dev) app (no `octane.config.ts`
 * routes) is a plain Vite SPA — the `octane()` compiler plugin in the app's
 * own `vite.config.ts` composes with the injected Cloudflare plugin:
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("Octane", {
 *   assets: {
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 * Fullstack Octane apps (routes + SSR in `octane.config.ts`) run their own
 * two-pass build through Octane's Cloudflare adapter — deploy those with
 * `Cloudflare.Website.Octane` instead.
 *
 * ### Serving on a Zone Route with a Path Prefix
 * Cloudflare matches static assets against the full request pathname,
 * so a site attached to a route like `example.com/docs*` only serves
 * assets whose uploaded paths carry the `/docs` prefix. Set Vite's
 * `base` in your `vite.config.ts` — the emitted HTML references its
 * assets under the prefix, and Alchemy keys the uploaded asset manifest
 * with the same resolved `base` so the two always agree.
 *
 * **Example:** vite.config.ts
 * ```typescript
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   base: "/docs/",
 * });
 * ```
 *
 * **Example:** alchemy.run.ts
 * ```typescript
 * const docs = yield* Cloudflare.Website.Vite("Docs", {
 *   routes: [{ pattern: "example.com/docs*", zoneName: "example.com" }],
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether
 * a rebuild is needed. Use `memo` to narrow the scope when your
 * project has large directories that don't affect the build output.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Docs", {
 *   memo: {
 *     include: ["src/**", "content/**", "package.json"],
 *   },
 * });
 * ```
 *
 * **Example:** Rebuilding when a sibling workspace package changes
 * The default scope only hashes files under the project root (plus the
 * nearest lockfile), so edits to a sibling workspace package the app
 * imports do not retrigger the build on their own. Add the sibling's
 * sources with a `../` include glob — and keep `lockfile: true`, since
 * providing `include` otherwise drops the lockfile from the hash:
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Web", {
 *   rootDir: "apps/web",
 *   memo: {
 *     include: ["**\/*", "../../packages/env/src/**"],
 *     lockfile: true,
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `Vite` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both
 * an `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Vite<Website>()("Website") {}
 *
 * const site = yield* Website;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
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
        [
          binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
        ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
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
      [
        binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
      ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
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

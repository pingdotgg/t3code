import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface FoldkitProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * Overrides the module that becomes the deployed Worker entry. Relative
   * paths resolve from {@link rootDir}.
   *
   * A Foldkit deployment is assets-only by default — no Worker code runs
   * at request time. Point `main` at a custom module when the deployment
   * needs code at the edge — API routes, error reporting, Durable Object
   * classes. The entry serves the client build through its `ASSETS`
   * binding:
   *
   * ```typescript
   * // src/worker.ts
   * export default {
   *   async fetch(request: Request, env: { ASSETS: Fetcher }) {
   *     const url = new URL(request.url);
   *     if (url.pathname === "/api/health") {
   *       return Response.json({ ok: true });
   *     }
   *     return env.ASSETS.fetch(request);
   *   },
   * };
   * ```
   */
  main?: string;
  /**
   * Foldkit project root directory.
   * Defaults to the current working directory (`process.cwd()`).
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether a rebuild is needed.
   * By default every non-gitignored file under `rootDir` is hashed, plus the
   * nearest package-manager lockfile. Provide explicit globs to narrow the
   * scope.
   */
  memo?: MemoOptions & {
    /**
     * Additional workspace directories to hash (relative to `rootDir`).
     * By default (`"auto"`), workspaces are auto-detected from the build's
     * module graph; an explicit array pins them.
     * @default "auto"
     */
    workspaces?: "auto" | Array<MemoOptions & { cwd: string }>;
  };
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   *
   * Foldkit apps route on the client, so `notFoundHandling` defaults to
   * `"single-page-application"` — unmatched paths serve `index.html` and
   * the app's router takes over. Set `notFoundHandling` explicitly to
   * override (e.g. `"404-page"` to serve the built `404.html`).
   *
   * @default { notFoundHandling: "single-page-application" }
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a [Foldkit](https://foldkit.dev) app.
 *
 * Foldkit apps are client-only Vite projects, so `Foldkit` drives the
 * project's own `vite build` — the Foldkit Vite plugin in the app's
 * `vite.config.ts` composes with the injected Cloudflare plugin — and
 * deploys the client output as static assets. No Wrangler configuration,
 * build command, or output directory required.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * Foldkit apps route on the client, so `assets.notFoundHandling`
 * defaults to `"single-page-application"` — deep links serve
 * `index.html` and the Foldkit router takes over.
 *
 *
 * ### Deploying a Foldkit App
 * A single call builds the project and deploys the client output as
 * static assets — no configuration required.
 *
 * **Example:** Foldkit app
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website");
 * ```
 *
 * **Example:** Foldkit project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Single-Page Application Routing
 * Unmatched paths serve `index.html` by default so deep links boot the
 * app and the Foldkit router resolves the route. A site that ships real
 * 404 content overrides the default with `notFoundHandling: "404-page"`.
 *
 * **Example:** Serving a real 404 page
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   assets: {
 *     notFoundHandling: "404-page",
 *   },
 * });
 * ```
 *
 * ### Custom Worker Entry
 * By default the deployment is assets-only. When code must run at the
 * edge — API routes, error reporting, Durable Object classes — point
 * `main` at your own module that serves the client build through the
 * `ASSETS` binding (see {@link FoldkitProps.main}). Bindings passed in
 * `env` are reachable from the entry (and from cron handlers), not from
 * browser code — a Foldkit app runs on the client, so anything it needs
 * must come from a route the Worker serves.
 *
 * **Example:** Custom entry serving an API route from a KV namespace
 * ```typescript
 * const ticker = yield* Cloudflare.KV.Namespace("Ticker");
 *
 * const site = yield* Cloudflare.Website.Foldkit("Platform", {
 *   main: "src/worker.ts",
 *   env: {
 *     TICKER: ticker,
 *   },
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when your project
 * has large directories that don't affect the build output.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Foldkit("Website", {
 *   memo: {
 *     include: ["src/**", "public/**", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `Foldkit` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
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
        [
          binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
        ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
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
      [
        binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
      ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
    }>,
    never,
    Req | Providers
  >;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(Foldkit(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            // Foldkit routes on the client; serve index.html for unmatched
            // paths so deep links boot the app instead of 404ing. An
            // explicit `assets.notFoundHandling` wins over the default.
            assets: {
              notFoundHandling: "single-page-application" as const,
              ...props?.assets,
            },
            main: undefined!,
            vite: {
              main: props?.main,
              rootDir: props?.rootDir,
              memo: props?.memo,
            },
          }),
        ),
      )) as any;

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

/**
 * The specifier of the Nuxt source-provider module. The package must be
 * installed in the user's project — `loadSource` fails with a
 * `SourceProviderError` naming it otherwise.
 */
const NUXT_SOURCE_PROVIDER = "@alchemy.run/frontend-frameworks/nuxt/source";

export interface NuxtProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * Nuxt project root (the directory containing `nuxt.config.ts`).
   * Relative paths resolve from the process working directory.
   * @default process.cwd()
   */
  rootDir?: string;
  /**
   * Overrides the module that becomes the deployed Worker entry (nitro's
   * entry/exports seam). Relative paths resolve from {@link rootDir}.
   *
   * By default nitro's own `cloudflare_module` entry is deployed. Point
   * `main` at a custom module when the deployed Worker must export more
   * than the framework's fetch handler — e.g. Durable Object classes. The
   * custom entry wraps nitro's handler by importing it from
   * `nitropack/presets/cloudflare/runtime/cloudflare-module` and
   * re-exports the extras:
   *
   * ```typescript
   * // worker-entry.ts
   * import nitroHandler from "nitropack/presets/cloudflare/runtime/cloudflare-module";
   * export class Counter extends DurableObject {}
   * export default nitroHandler;
   * ```
   */
  main?: string;
  /**
   * Controls which files are content-hashed to decide whether a rebuild is
   * needed. By default every non-gitignored file under `rootDir` (plus the
   * nearest package-manager lockfile) is hashed; narrow the scope with
   * `include`/`exclude` globs when the project sits in a large repository.
   */
  memo?: MemoOptions;
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
  /**
   * Nuxt config overrides merged over the project's own `nuxt.config.ts`
   * (the highest-priority c12 layer — a value here wins over the file).
   * Use it for deploy-time values the config file can't express, e.g.
   * per-stage `runtimeConfig`; `nuxt.config.ts` remains the primary home
   * for everything else.
   *
   * Must be JSON-serializable — no functions, plugins, or modules (the
   * value persists in state and participates in the rebuild hash).
   * `nitro.preset` is always owned by the deploy target and cannot be
   * overridden here.
   */
  nuxt?: Record<string, unknown>;
}

/**
 * A Cloudflare Worker deployed from a [Nuxt](https://nuxt.com) project.
 *
 * `Nuxt` builds the app programmatically through the project's own
 * `@nuxt/kit` with nitro's `cloudflare_module` preset — the project's
 * `nuxt.config.ts` loads natively, no `nitro.preset` edits, no Wrangler
 * configuration, and no build command required. The nitro server bundle
 * deploys as the Worker script; client assets and prerendered pages
 * (`.output/public`) deploy as Worker static assets.
 *
 * Requires the `@alchemy.run/frontend-frameworks` package to be installed in
 * your project; the integration is loaded from its `/nuxt` export. Input files
 * are content-hashed
 * (respecting `.gitignore` by default) so unchanged projects skip the
 * build and deploy entirely.
 *
 * The server build uses nitro's hybrid workerd Node compatibility
 * (`cloudflare.nodeCompat`), which relies on workerd's native `node:*`
 * modules — the `nodejs_compat` compatibility flag is always included in
 * the Worker's compatibility flags to match.
 *
 * On local dev: `alchemy dev` runs Nuxt's own dev server (nitro dev, SSR
 * in a Node worker thread, full HMR) with the Worker's bindings served on
 * `event.context.cloudflare` through cloudflare-runtime's platform proxy —
 * wrangler-free. Literal `env` values overlay the proxied bindings;
 * resource bindings (KV, R2, D1, ...) round-trip to the proxy's local
 * workerd instance, so dev state is live and shared. Durable Objects
 * declared via a custom `main` entry only exist in the production build
 * and are not servable in dev yet.
 *
 *
 * ### Deploying a Nuxt App
 * A single call builds and deploys the app — server-rendered pages, API
 * routes, prerendered pages, and client assets included.
 *
 * **Example:** Basic Nuxt site
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website");
 * ```
 *
 * **Example:** Nuxt project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   rootDir: "apps/web",
 * });
 * ```
 *
 * ### Bindings
 * Values passed via `env` are exposed to server routes and SSR through
 * nitro's `cloudflare_module` runtime contract:
 * `event.context.cloudflare.env` (plus `event.context.cf` and
 * `event.context.cloudflare.context.waitUntil`).
 *
 * **Example:** Reading env from an API route
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   env: {
 *     API_KEY: Config.redacted("API_KEY"),
 *   },
 * });
 *
 * // server/api/hello.ts
 * // export default defineEventHandler((event) => ({
 * //   hasKey: event.context.cloudflare?.env?.API_KEY !== undefined,
 * // }));
 * ```
 *
 * **Example:** Binding an R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("Uploads");
 *
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   env: {
 *     UPLOADS: bucket,
 *   },
 * });
 * ```
 *
 * ### Prerendering
 * Routes marked for prerendering in `routeRules` (or via
 * `nitro.prerender`) render at build time into `.output/public` and are
 * served as static assets — no Worker invocation. Configure them in
 * your `nuxt.config.ts`, which loads natively:
 *
 * **Example:** Prerendering a route (nuxt.config.ts)
 * ```typescript
 * // nuxt.config.ts
 * export default defineNuxtConfig({
 *   routeRules: {
 *     "/about": { prerender: true },
 *   },
 * });
 * ```
 *
 * ### Config Overrides
 * `nuxt.config.ts` is the primary home for Nuxt configuration — it loads
 * natively. The `nuxt` prop layers deploy-time overrides on top (the
 * highest-priority c12 layer) for values the file can't express, like
 * per-stage settings. The bag must be JSON-serializable — no functions,
 * plugins, or modules — and `nitro.preset` stays owned by the deploy
 * target.
 *
 * **Example:** Deploy-time config overrides
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   nuxt: {
 *     app: { baseURL: "/docs/" },
 *     runtimeConfig: {
 *       public: { apiBase: "https://api.example.com" },
 *     },
 *   },
 * });
 * ```
 *
 * ### Custom Worker Exports (Durable Objects)
 * Nitro's entry module is the Worker's exports seam. Point `main` at your
 * own module that re-exports nitro's runtime handler (imported from
 * `nitropack/presets/cloudflare/runtime/cloudflare-module`) and adds
 * extra exports — Durable Object classes must live on the deployed
 * Worker for their namespace bindings to resolve. Every framework route
 * keeps working through the re-exported handler.
 *
 * **Example:** Custom entry hosting a Durable Object
 * ```typescript
 * // worker-entry.ts
 * // import nitroHandler from "nitropack/presets/cloudflare/runtime/cloudflare-module";
 * // export class Counter extends DurableObject { ... }
 * // export default nitroHandler;
 *
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   main: "worker-entry.ts",
 *   env: {
 *     COUNTER: Cloudflare.DurableObject("Counter", {
 *       className: "Counter",
 *     }),
 *   },
 * });
 * ```
 *
 * ### Dev
 * `alchemy dev` runs Nuxt's own dev server (nitro dev, full HMR) with
 * `event.context.cloudflare` served wrangler-free through
 * cloudflare-runtime's platform proxy: resource bindings resolve against
 * a local workerd instance, and literal `env` values overlay them.
 *
 * **Example:** Reading bindings in dev and production alike
 * ```typescript
 * // server/api/greeting.ts — identical code in dev and deployed
 * // export default defineEventHandler((event) => ({
 * //   greeting: event.context.cloudflare?.env?.GREETING,
 * // }));
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   env: { GREETING: "hello" },
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when the project
 * lives in a large repository.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   memo: {
 *     include: ["app/**", "server/**", "public/**", "nuxt.config.ts", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Limitations
 * Nitro's `isr` route rule (incremental static regeneration) is
 * implemented only by the Vercel and Netlify presets — on Cloudflare it
 * is silently ignored at build time, and the route renders on demand in
 * the Worker like any other SSR route. Use `prerender` for build-time
 * static routes, or `cache` route rules for runtime caching.
 *
 * ### Class Form
 * Calling `Nuxt` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Nuxt<Website>()(
 *   "Website",
 * ) {}
 *
 * const site = yield* Website;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const Nuxt: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<NuxtProps<Bindings>>
        | Effect.Effect<InputProps<NuxtProps<Bindings>>, never, Req>,
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
      | InputProps<NuxtProps<Bindings>>
      | Effect.Effect<InputProps<NuxtProps<Bindings>>, never, Req>,
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
    ? (id: string, propsEff: any) => effectClass(Nuxt(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            // The server build uses nitro's hybrid workerd node-compat
            // (`cloudflare.nodeCompat: true`), which relies on workerd's
            // native `node:*` modules — `getCompatibility` already adds
            // `nodejs_compat` to every non-python Worker.
            // `main` is the source provider's user-entry seam (nitro's
            // entry), not the Worker's own bundling entry.
            main: undefined!,
            source: {
              provider: NUXT_SOURCE_PROVIDER,
              devMode: "server",
              rootDir: props?.rootDir,
              options: {
                rootDir: props?.rootDir,
                main: props?.main,
                memo: props?.memo,
                nuxt: props?.nuxt,
              },
            },
          }),
        ),
      )) as any;

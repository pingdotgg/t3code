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
 * The specifier of the Octane source-provider module. The package must be
 * installed in the user's project — `loadSource` fails with a
 * `SourceProviderError` naming it otherwise.
 */
const OCTANE_SOURCE_PROVIDER = "@alchemy.run/frontend-frameworks/octane/source";

export interface OctaneProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * Octane project root (the directory containing `vite.config.ts` and
   * `octane.config.ts`). Relative paths resolve from the process working
   * directory.
   * @default process.cwd()
   */
  rootDir?: string;
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
   *
   * Octane's intended routing is asset-first with SSR on miss: exact files
   * in `dist/client` serve without invoking the Worker, and every miss
   * reaches Octane SSR. Leave `notFoundHandling` unset (`"none"`) — both
   * `"single-page-application"` and `"404-page"` would prevent
   * browser-navigation misses from reaching SSR.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from an [OctaneJS](https://octanejs.dev)
 * fullstack project.
 *
 * Octane wraps Vite, so `Octane` is deliberately thin: it drives the
 * project's own `vite build` — `@octanejs/vite-plugin` (from the app's
 * `vite.config.ts`) builds the client bundle and the SSR server bundle, and
 * the app's `adapter: cloudflare()` (from `@octanejs/adapter-cloudflare`,
 * selected in `octane.config.ts`) emits the module Worker entry at
 * `dist/server/worker.js`. That entry deploys as the Worker script and
 * `dist/client` deploys as static assets — no Wrangler configuration and
 * no build command required.
 *
 * Requires the `@alchemy.run/frontend-frameworks` package to be installed in
 * your project; the integration is loaded from its `/octane` export. The
 * project also needs `octane`, `@octanejs/vite-plugin`, and
 * `@octanejs/adapter-cloudflare`. Input files are content-hashed
 * (respecting `.gitignore` by default) so unchanged projects skip the
 * build and deploy entirely.
 *
 * Octane's server runtime needs synchronous SHA-256 and
 * `AsyncLocalStorage`, so the `nodejs_compat` compatibility flag (enabled
 * by default for every Worker) is required.
 *
 * A client-only Octane SPA (no `octane.config.ts` routes) is a plain Vite
 * project — deploy it with {@link Vite | Cloudflare.Website.Vite} instead,
 * where the `octane()` compiler plugin composes with the injected
 * Cloudflare Vite plugin.
 *
 *
 * ### Deploying an Octane App
 * A single call builds and deploys the app — server-rendered routes,
 * server (API) routes, and client assets included. The app's own
 * `octane.config.ts` must select the Cloudflare adapter:
 *
 * **Example:** octane.config.ts
 * ```typescript
 * import { cloudflare } from "@octanejs/adapter-cloudflare";
 * import { defineConfig, RenderRoute } from "@octanejs/vite-plugin";
 *
 * export default defineConfig({
 *   adapter: cloudflare(),
 *   router: {
 *     routes: [new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] })],
 *   },
 * });
 * ```
 *
 * **Example:** alchemy.run.ts
 * ```typescript
 * const site = yield* Cloudflare.Website.Octane("Website");
 * ```
 *
 * **Example:** Octane project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.Octane("Website", {
 *   rootDir: "apps/web",
 * });
 * ```
 *
 * ### Bindings
 * Values passed via `env` reach Octane middleware and `ServerRoute`
 * handlers through the adapter's runtime contract: `context.platform` is
 * the Cloudflare `{ env, ctx }` pair, so `platform.env.MY_KV` is the live
 * binding and `platform.ctx.waitUntil` schedules background work.
 *
 * **Example:** Reading a binding from a ServerRoute
 * ```typescript
 * // octane.config.ts route
 * // new ServerRoute({
 * //   path: "/api/hello",
 * //   methods: ["GET"],
 * //   handler: (context) => {
 * //     const platform = context.platform as { env: { API_KEY: string } };
 * //     return Response.json({ hasKey: platform.env.API_KEY !== undefined });
 * //   },
 * // })
 *
 * const site = yield* Cloudflare.Website.Octane("Website", {
 *   env: {
 *     API_KEY: Config.redacted("API_KEY"),
 *   },
 * });
 * ```
 *
 * **Example:** Binding a KV namespace
 * ```typescript
 * const cache = yield* Cloudflare.KV.Namespace("Cache");
 *
 * const site = yield* Cloudflare.Website.Octane("Website", {
 *   env: {
 *     CACHE: cache,
 *   },
 * });
 * ```
 *
 * ### Dev
 * `alchemy dev` runs Octane's own Vite dev server (the plugin's in-process
 * SSR middleware — rendering, server routes, and RPC with full HMR).
 * NOTE: Octane's dev middleware does not supply request-scoped platform
 * bindings (`context.platform` is `undefined` in dev — an upstream
 * limitation), so code touching `platform.env` must tolerate `undefined`
 * during dev; bindings are live in deployed Workers.
 *
 * ### Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when the project
 * lives in a large repository.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Octane("Website", {
 *   memo: {
 *     include: ["src/**", "public/**", "octane.config.ts", "vite.config.ts", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `Octane` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Octane<Website>()(
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
export const Octane: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<OctaneProps<Bindings>>
        | Effect.Effect<InputProps<OctaneProps<Bindings>>, never, Req>,
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
      | InputProps<OctaneProps<Bindings>>
      | Effect.Effect<InputProps<OctaneProps<Bindings>>, never, Req>,
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
    ? (id: string, propsEff: any) => effectClass(Octane(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            // Octane's server bundle externalizes `node:` modules for
            // workerd's native node-compat — `getCompatibility` already
            // adds `nodejs_compat` to every non-python Worker.
            main: undefined!,
            source: {
              provider: OCTANE_SOURCE_PROVIDER,
              devMode: "server",
              rootDir: props?.rootDir,
              options: {
                rootDir: props?.rootDir,
                memo: props?.memo,
              },
            },
          }),
        ),
      )) as any;

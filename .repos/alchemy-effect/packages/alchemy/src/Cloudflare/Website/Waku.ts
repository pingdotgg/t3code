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
 * The specifier of the Waku source-provider module. The package must be
 * installed in the user's project — `loadSource` fails with a
 * `SourceProviderError` naming it otherwise.
 */
const WAKU_SOURCE_PROVIDER = "@alchemy.run/frontend-frameworks/waku/source";

export interface WakuProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * Overrides the module that becomes the deployed Worker entry. Relative
   * paths resolve from {@link rootDir}.
   *
   * By default Waku's own RSC server entry is deployed. Point `main` at a
   * custom module when the deployed Worker must export more than Waku's
   * fetch handler — e.g. Durable Object classes or additional handlers.
   * The custom entry wraps Waku's handler by importing it from
   * `virtual:waku/server-entry` and re-exports the extras:
   *
   * ```typescript
   * // src/worker-entry.ts
   * import wakuHandler from "virtual:waku/server-entry";
   * export class Counter extends DurableObject {}
   * export default {
   *   fetch: (request, env, ctx) => wakuHandler.fetch(request, env, ctx),
   * };
   * ```
   */
  main?: string;
  /**
   * Root directory of the Waku project. Defaults to the process working
   * directory.
   */
  rootDir?: string;
  /**
   * Controls which files feed the content hash that decides whether a
   * rebuild is needed. By default every non-gitignored file under
   * {@link rootDir} is hashed, plus the nearest package-manager lockfile.
   * Provide `include`/`exclude` globs to narrow the scope.
   */
  memo?: MemoOptions;
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   *
   * Waku links SSG pages without trailing slashes (`/about`), so
   * `htmlHandling` defaults to `"drop-trailing-slash"` — the prerendered
   * `about/index.html` serves directly at `/about` instead of 307-redirecting
   * to `/about/`. Set `htmlHandling` explicitly to override.
   *
   * @default { htmlHandling: "drop-trailing-slash" }
   */
  assets?: AssetsConfig;
  /**
   * Waku config overrides merged over the project's `waku.config.*`
   * (per-key; deploy-time values win). For values that vary by stage or
   * come from other resources — static config belongs in `waku.config.*`.
   */
  waku?: {
    /**
     * Waku `srcDir` (relative to {@link rootDir}).
     * @default "src"
     */
    srcDir?: string;
    /**
     * Waku `distDir` (relative to {@link rootDir}). If `waku.config.*`
     * customizes `distDir`, mirror it here (or add it to `memo.exclude`)
     * so the build output stays excluded from the rebuild-deciding input
     * hash.
     * @default "dist"
     */
    distDir?: string;
    /**
     * Waku `basePath`.
     * @default "/"
     */
    basePath?: string;
  };
}

/**
 * A Cloudflare Worker deployed from a [Waku](https://waku.gg) project.
 *
 * `Waku` builds the project programmatically — no `waku.config.ts` edits,
 * no Wrangler configuration, and no build command required. A project's
 * `waku.config.*` loads natively (same as waku's CLI) and is where all
 * Waku configuration (`srcDir`, `distDir`, `basePath`, ...) lives; the
 * `waku` prop overrides it per key at deploy time.
 * `unstable_adapter` is owned by Alchemy and must not be set. Note that a
 * standalone `vite.config.ts` is NOT loaded (same as waku's CLI) — Vite
 * config belongs in `waku.config.*`'s `vite` field. The RSC server
 * bundle deploys as the Worker script and the client output (including
 * SSG-prerendered pages) deploys as static assets.
 *
 * Requires the `@alchemy.run/frontend-frameworks` package to be installed in
 * your project; the integration is loaded from its `/waku` export. Input files
 * are content-hashed
 * (respecting `.gitignore` by default) so unchanged projects skip the
 * build and deploy entirely.
 *
 * Waku's server runtime uses `AsyncLocalStorage`, so the `nodejs_als`
 * compatibility flag is enabled automatically when your compatibility
 * flags include neither `nodejs_als` nor `nodejs_compat`. SSG pages are
 * served at their extensionless URLs (`/about`) via the default
 * `drop-trailing-slash` asset handling.
 *
 *
 * ### Deploying a Waku Site
 * A single call builds the project and deploys the RSC server bundle plus
 * the client assets — no configuration required.
 *
 * **Example:** Waku site
 * ```typescript
 * const site = yield* Cloudflare.Website.Waku("Site");
 * ```
 *
 * **Example:** Waku project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   rootDir: "apps/web",
 * });
 * ```
 *
 * ### Waku Config Overrides
 * Waku configuration lives in your `waku.config.*`. The `waku` prop
 * overrides it per key at deploy time — for values that vary by stage
 * or come from other resources.
 *
 * **Example:** Stage-dependent base path
 * ```typescript
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   waku: {
 *     basePath: "/docs/",
 *   },
 * });
 * ```
 *
 * ### Bindings
 * Pass resources through `env` like any other Worker. Server components
 * and API routes read them from the `cloudflare:workers` env at request
 * time. Prefer a guarded dynamic import in page modules — Waku's SSG step
 * renders static pages in Node, where a top-level
 * `import { env } from "cloudflare:workers"` cannot resolve.
 *
 * **Example:** Binding an R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("Uploads");
 *
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   env: {
 *     UPLOADS: bucket,
 *   },
 * });
 * ```
 *
 * ### Custom Worker Entry
 * By default the deployed Worker entry is Waku's own RSC server entry.
 * When the Worker must export more than Waku's fetch handler — Durable
 * Object classes, additional handlers — point `main` at your own module
 * that wraps Waku's handler (imported from `virtual:waku/server-entry`)
 * and re-exports the extras.
 *
 * **Example:** Custom entry hosting a Durable Object
 * ```typescript
 * // src/worker-entry.ts
 * // import wakuHandler from "virtual:waku/server-entry";
 * // export class Counter extends DurableObject { ... }
 * // export default { fetch: (req, env, ctx) => wakuHandler.fetch(req, env, ctx) };
 *
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   main: "src/worker-entry.ts",
 *   env: {
 *     COUNTER: Cloudflare.DurableObject("Counter", {
 *       className: "Counter",
 *     }),
 *   },
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when your project has
 * large directories that don't affect the build output.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   memo: {
 *     include: ["src/**", "public/**", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `Waku` with no arguments returns a constructor you can `extend`
 * to declare the Worker as a named class. The class is both an `Effect`
 * you can `yield*` to deploy and a type you can reference elsewhere —
 * useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Waku Worker class
 * ```typescript
 * class Site extends Cloudflare.Website.Waku<Site>()("Site") {}
 *
 * const site = yield* Site;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const Waku: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<WakuProps<Bindings>>
        | Effect.Effect<InputProps<WakuProps<Bindings>>, never, Req>,
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
      | InputProps<WakuProps<Bindings>>
      | Effect.Effect<InputProps<WakuProps<Bindings>>, never, Req>,
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
    ? (id: string, propsEff: any) => effectClass(Waku(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            compatibility: {
              ...props?.compatibility,
              // Waku's server runtime needs AsyncLocalStorage — default to
              // nodejs_als when the user hasn't enabled it (or the broader
              // nodejs_compat) themselves.
              flags:
                props?.compatibility?.flags?.includes("nodejs_als") ||
                props?.compatibility?.flags?.includes("nodejs_compat")
                  ? props.compatibility!.flags
                  : [...(props?.compatibility?.flags ?? []), "nodejs_als"],
            },
            // Waku links SSG pages without trailing slashes; serve
            // `about/index.html` at `/about` directly instead of redirecting.
            assets: {
              htmlHandling: "drop-trailing-slash" as const,
              ...props?.assets,
            },
            main: undefined!,
            source: {
              provider: WAKU_SOURCE_PROVIDER,
              devMode: "server",
              rootDir: props?.rootDir,
              options: {
                rootDir: props?.rootDir,
                // Custom worker entry (wraps waku's handler via
                // `virtual:waku/server-entry`); resolved against `rootDir`
                // by the source provider.
                main: props?.main,
                // Deploy-time waku config overrides, merged over the
                // project's `waku.config.*` by the source provider.
                srcDir: props?.waku?.srcDir,
                distDir: props?.waku?.distDir,
                basePath: props?.waku?.basePath,
                memo: props?.memo,
              },
            },
          }),
        ),
      )) as any;

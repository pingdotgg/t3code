import type { MemoOptions } from "alchemy/Command/Memo";
import type { InputProps } from "alchemy/Input";
import { effectClass } from "alchemy/Util/effect";
import { resolveAstroSettings } from "alchemy/Website/AstroOutput";
import * as Effect from "effect/Effect";
import { Namespace } from "../KV/Namespace.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface AstroProps<Bindings extends WorkerBindingProps = {}> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle" | "rules"
> {
  /**
   * Astro project root directory.
   * Defaults to the current working directory (`process.cwd()`).
   */
  rootDir?: string;
  /**
   * A custom Worker entry that wraps Astro's handler and adds exports of its
   * own (Durable Object classes, a `scheduled` handler, ...). Import the Astro
   * handler from `@alchemy.run/frontend-frameworks/astro/entrypoints/server`
   * and re-export or extend its `default`:
   *
   * ```ts
   * import handler from "@alchemy.run/frontend-frameworks/astro/entrypoints/server";
   * export { MyDurableObject } from "./do.ts";
   * export default { ...handler, scheduled: async () => {} };
   * ```
   *
   * A relative path resolves against {@link rootDir}; a bare specifier resolves
   * as a package import. When unset, Astro's server entrypoint is deployed.
   */
  main?: string;
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
   * The name of the KV binding backing Astro's session API.
   *
   * A KV namespace is auto-provisioned and bound under this name on
   * deploy, so `Astro.session` works with zero configuration. Bind your
   * own KV namespace under this name in `env` to use it instead of the
   * auto-provisioned one, or set this to `false` to disable session
   * provisioning entirely.
   * @default "SESSION"
   */
  sessionKVBindingName?: string | false;
  /**
   * Runtime used to prerender static pages. `"workerd"` renders them in the
   * production Worker runtime; `"node"` uses Astro's stock Node prerenderer.
   * @default "workerd"
   */
  prerenderEnvironment?: "workerd" | "node";
  /**
   * Deploy-time Astro config overrides, merged OVER your natively-loaded
   * `astro.config.*` (values here win). Use it for values that vary per
   * stage or derive from other resources' Outputs — everything else
   * belongs in the config file.
   */
  astro?: {
    /** Deployed URL origin (astro's `site`). */
    site?: string;
    /** Base path the site is served from (astro's `base`). */
    base?: string;
    /**
     * Astro output target — a deploy-topology decision (whether Worker
     * code runs at request time). `"server"` renders pages on demand in
     * the Worker; individual pages opt into prerendering with
     * `export const prerender = true`. `"static"` prerenders every page
     * at build time and deploys assets-only. Overrides the `output` in
     * your `astro.config.*`; leave it unset to use the file's value.
     * @default the config file's `output`, else `"server"`
     */
    output?: "server" | "static";
    /** Source directory (astro's `srcDir`). */
    srcDir?: string;
    /** Public assets directory (astro's `publicDir`). */
    publicDir?: string;
    /** Build output directory (astro's `outDir`). */
    outDir?: string;
    /** Trailing-slash handling (astro's `trailingSlash`). */
    trailingSlash?: "always" | "never" | "ignore";
  };
  /**
   * Path to an alternate astro config file, relative to `rootDir`.
   * Defaults to astro's own config discovery.
   */
  config?: string;
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

// These options are inspected while constructing the Worker. Resolve them in
// the outer props Effect; pass-through properties can remain deferred Inputs.
type AstroInput<Bindings extends WorkerBindingProps> = InputProps<
  AstroProps<Bindings>,
  "sessionKVBindingName" | "astro" | "env" | "rootDir" | "config"
>;

/**
 * A Cloudflare Worker deployed from an [Astro](https://astro.build)
 * project.
 *
 * `Astro` runs Astro's programmatic build with a wrangler-free
 * Cloudflare adapter (`@alchemy.run/frontend-frameworks/astro`): server-rendered pages
 * execute in the Worker, prerendered pages and client assets deploy as
 * static assets. Your `astro.config.*` loads natively — no adapter
 * setup or Wrangler configuration required.
 *
 * Input files are content-hashed (respecting `.gitignore` by default)
 * so unchanged projects skip the build and deploy entirely.
 *
 * The `@alchemy.run/frontend-frameworks` package must be installed in your
 * project; its `/astro` export is loaded dynamically at deploy time:
 *
 * ```sh
 * bun add -d @alchemy.run/frontend-frameworks
 * ```
 *
 *
 * ### Deploying an Astro Site
 * A single call builds the project and deploys the server bundle plus
 * static assets. Pages are server-rendered by default; pages that
 * `export const prerender = true` are served as static assets. Astro's
 * server runtime is built against Node APIs, so `nodejs_compat` is
 * always included in the Worker's compatibility flags.
 *
 * **Example:** Astro site
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Website");
 * ```
 *
 * ### Static Sites
 * When your `astro.config.*` or `astro: { output: "static" }` declares
 * `output: "static"`, every page is prerendered at build time and the
 * deploy is **assets-only**: no server bundle is uploaded —
 * Cloudflare's asset layer answers every request (serve the built
 * `404.html` via `assets: { notFoundHandling: "404-page" }`). Session
 * provisioning is skipped for static sites since no Worker
 * code runs at request time.
 *
 * **Example:** Fully static Astro site
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Docs", {
 *   astro: { output: "static" },
 *   assets: {
 *     notFoundHandling: "404-page",
 *   },
 * });
 * ```
 *
 * ### Bindings
 * Bind resources through `env` like any other Worker. Astro code reads
 * them via `import { env } from "cloudflare:workers"` (or
 * `Astro.locals.runtime.env`).
 *
 * **Example:** Astro site with a KV namespace and an R2 bucket
 * ```typescript
 * const kv = yield* Cloudflare.KV.Namespace("Cache");
 * const bucket = yield* Cloudflare.R2.Bucket("Uploads");
 *
 * const site = yield* Cloudflare.Website.Astro("Website", {
 *   env: {
 *     CACHE: kv,
 *     UPLOADS: bucket,
 *   },
 * });
 * ```
 *
 * ### Sessions
 * Astro's session API is backed by a KV namespace. One is provisioned
 * and bound under the session binding name (`SESSION` by default)
 * automatically, so `Astro.session` works with zero configuration.
 * Bind your own namespace under that name to use it instead, or set
 * `sessionKVBindingName: false` to opt out of session provisioning.
 *
 * **Example:** Bringing your own session namespace
 * ```typescript
 * const sessions = yield* Cloudflare.KV.Namespace("Sessions");
 *
 * const site = yield* Cloudflare.Website.Astro("Website", {
 *   env: {
 *     SESSION: sessions,
 *   },
 * });
 * ```
 *
 * **Example:** Opting out of session provisioning
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Website", {
 *   sessionKVBindingName: false,
 * });
 * ```
 *
 * ### Route Caching
 * Astro's route cache works with Workers Cache. Set the cache provider to
 * `cacheCloudflare()` and Workers Cache is turned on for the Worker. Pages
 * then go to the edge cache with the rules you give in `routeRules` or
 * `Astro.cache.set()`. A response with no cache rule is not cached. Set
 * `cache` on the site to override the Worker cache settings.
 *
 * **Example:** Caching a route at the edge
 * ```typescript
 * // astro.config.mjs
 * import { defineConfig } from "astro/config";
 * import { cacheCloudflare } from "@alchemy.run/frontend-frameworks/astro/cache";
 *
 * export default defineConfig({
 *   cache: { provider: cacheCloudflare() },
 *   routeRules: { "/insights": { maxAge: 600, swr: 86400 } },
 * });
 * ```
 *
 * ```typescript
 * // alchemy.run.ts
 * const site = yield* Cloudflare.Website.Astro("Website");
 * ```
 *
 * ### Custom Worker Entry
 * By default the deployed Worker entry is Astro's server entrypoint.
 * When the Worker must export more than Astro's fetch handler — Durable
 * Object classes, a `scheduled` handler — point `main` at your own module
 * that wraps Astro's handler (imported from
 * `@alchemy.run/frontend-frameworks/astro/entrypoints/server`) and
 * re-exports the extras.
 *
 * **Example:** Custom entry hosting a Durable Object
 * ```typescript
 * // src/worker-entry.ts
 * // import handler from "@alchemy.run/frontend-frameworks/astro/entrypoints/server";
 * // export class Counter extends DurableObject { ... }
 * // export default { ...handler, scheduled: async () => { ... } };
 *
 * const site = yield* Cloudflare.Website.Astro("Website", {
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
 * rebuild is needed. Use `memo` to narrow the scope when your project
 * has large directories that don't affect the build output.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Docs", {
 *   memo: {
 *     include: ["src/**", "public/**", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Astro Configuration
 * Your `astro.config.*` is the home for Astro configuration
 * (integrations, Vite plugins, `site`, `base`, ...) and loads natively.
 * The Cloudflare adapter is injected for you — declaring an `adapter`
 * in the config file fails the build. The `astro` prop is a
 * deploy-time override bag merged OVER the file (values here win) for
 * settings that vary per stage or derive from other resources'
 * Outputs, which a config file cannot consume. `output` comes from the
 * prop, then the config file, then defaults to `"server"` — astro's
 * zero-config `"static"` default would prerender every page inside
 * workerd, where the Worker's bindings don't exist.
 * Use `config` to point at an alternate config file (relative to
 * `rootDir`).
 *
 * **Example:** Per-stage site URL override
 * ```typescript
 * const site = yield* Cloudflare.Website.Astro("Blog", {
 *   astro: { site: "https://blog.example.com" },
 * });
 * ```
 *
 * ### Class Form
 * Calling `Astro` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Astro<Website>()("Website") {}
 *
 * const site = yield* Website;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const Astro: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?: AstroInput<Bindings> | Effect.Effect<AstroInput<Bindings>, never, Req>,
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
    propsEff?: AstroInput<Bindings> | Effect.Effect<AstroInput<Bindings>, never, Req>,
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
  propsEff?: AstroInput<Bindings> | Effect.Effect<AstroInput<Bindings>, never, Req>,
) =>
  id === undefined
    ? <const Bindings extends WorkerBindingProps = {}, Req = never>(
        id: string,
        propsEff?: AstroInput<Bindings> | Effect.Effect<AstroInput<Bindings>, never, Req>,
      ) => effectClass(Astro(id, propsEff))
    : Worker(
        id,
        Effect.gen(function* () {
          const props = (Effect.isEffect(propsEff) ? yield* propsEff : propsEff) ?? {};
          // The prop wins, then the config file's `output`, then
          // `"server"`: astro's own zero-config default is `"static"`,
          // which would prerender every page at build time inside workerd
          // — where the Worker's bindings don't exist.
          const { output, workerCache } = yield* resolveAstroSettings({
            rootDir: props.rootDir,
            config: props.config,
            output: props.astro?.output,
          });
          const session = props.sessionKVBindingName;
          const sessionBindingName = typeof session === "string" ? session : "SESSION";
          let env: WorkerBindingProps | undefined = props.env;
          // Auto-provision the KV namespace backing Astro's session API
          // unless the user opted out (`sessionKVBindingName: false`) or
          // already bound their own namespace under the session name.
          // An `output: "static"` site is assets-only — no Worker
          // script runs at request time, so a session namespace could never
          // be read; skip provisioning it. Resource creation is deduped by
          // logical id, so re-evaluating this props effect is safe.
          if (session !== false && output !== "static" && env?.[sessionBindingName] === undefined) {
            const sessions = yield* Namespace(`${id}Session`);
            env = { ...env, [sessionBindingName]: sessions };
          }
          return {
            ...props,
            env,
            // Astro's Cloudflare cache provider caches responses in Workers
            // Cache, so turn it on for the Worker unless `cache` is set.
            cache:
              props.cache ?? (workerCache && output !== "static" ? { enabled: true } : undefined),
            // Astro's vendored server runtime is built against Node APIs
            // and needs `nodejs_compat`; `getCompatibility` already adds it
            // to every non-python Worker (honoring an explicit
            // `no_nodejs_compat` opt-out and the v2-mode date guard).
            main: undefined!,
            source: {
              provider: "@alchemy.run/frontend-frameworks/astro/source",
              devMode: "server",
              rootDir: props.rootDir,
              options: {
                rootDir: props.rootDir,
                main: props.main,
                memo: props.memo,
                // Passed through verbatim (including `false`) so the
                // source provider can skip its session-driver wiring on
                // opt-out.
                sessionKVBindingName: props.sessionKVBindingName,
                prerenderEnvironment: props.prerenderEnvironment,
                // The `astro` bag is the deploy-time overlay merged OVER
                // the natively-loaded `astro.config.*`.
                astro: { ...props.astro, output },
                config: props.config,
              },
            },
          };
        }),
      )) as any;

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

export interface SvelteKitProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * SvelteKit project root (the directory containing `package.json` and
   * `src/routes`). Relative paths resolve from the process working
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
   * SvelteKit config overrides for the `sveltekit(...)` plugin call, merged
   * over the options of the user's own call (these win). JSON-serializable
   * only — no `preprocess`/`vitePlugin`/functions; construction-time options
   * (`preprocess`, `extensions`, `compilerOptions`, `vitePlugin`) can only
   * apply when no user `vite.config.*` exists. The `adapter` field is
   * always owned by alchemy.
   */
  kit?: Record<string, unknown>;
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a SvelteKit project.
 *
 * `SvelteKit` builds the app with SvelteKit's own Vite pipeline and a
 * wrangler-free in-memory Cloudflare adapter, then re-bundles the
 * Node-flavored server output for workerd. A project-owned
 * `vite.config.*` loads natively (its `sveltekit(...)` options apply) —
 * no `svelte.config.js` (kit v3 dropped it), no
 * `@sveltejs/adapter-cloudflare`, no Wrangler configuration required.
 * Client assets and prerendered pages are deployed as Worker static
 * assets; dynamic routes are served by the generated Worker.
 *
 * The `@alchemy.run/frontend-frameworks` package must be installed in your
 * project — its `/sveltekit` export is loaded dynamically at deploy time.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * SvelteKit's server code runs under `nodejs_compat` (the server graph is
 * built for Node), so the flag is always included in the Worker's
 * compatibility flags.
 *
 * Note on local dev: `alchemy dev` runs SvelteKit's own Vite dev server
 * (Node SSR with full HMR). `platform.env` carries the Worker's real
 * Cloudflare bindings (KV, R2, D1, ...) served by the cloudflare-runtime
 * platform proxy, with literal `env` values (strings and secrets)
 * overlaid.
 *
 *
 * ### Deploying a SvelteKit App
 * A single call builds and deploys the app — server-rendered routes,
 * prerendered pages, and client assets included.
 *
 * **Example:** Basic SvelteKit site
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website");
 * ```
 *
 * ### Bindings
 * Values passed via `env` are exposed to server routes through
 * SvelteKit's `platform.env`.
 *
 * **Example:** Reading env from a server route
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   env: {
 *     API_KEY: Config.redacted("API_KEY"),
 *   },
 * });
 *
 * // src/routes/+page.server.ts
 * // export const load = ({ platform }) => ({
 * //   hasKey: platform?.env?.API_KEY !== undefined,
 * // });
 * ```
 *
 * ### Kit Options and 404 Handling
 * Kit options live in the `sveltekit(...)` call in your
 * `vite.config.ts`, which loads natively. Fallback-page behavior is
 * driven by the platform-native `assets.notFoundHandling` knob — the
 * build generates the matching fallback page (rendering the app shell,
 * so kit's own error page shows).
 *
 * **Example:** App-shell 404 fallback
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   assets: {
 *     notFoundHandling: "404-page",
 *   },
 * });
 * ```
 *
 * The `kit` prop is a deploy-time override bag merged over your own
 * `sveltekit(...)` options (the prop wins) — useful for per-stage values
 * the config file can't compute. JSON-serializable values only.
 *
 * **Example:** Deploy-time kit overrides
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   kit: {
 *     paths: { base: "/docs" },
 *   },
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
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   memo: {
 *     include: ["src/**", "static/**", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `SvelteKit` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.SvelteKit<Website>()(
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
export const SvelteKit: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<SvelteKitProps<Bindings>>
        | Effect.Effect<InputProps<SvelteKitProps<Bindings>>, never, Req>,
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
      | InputProps<SvelteKitProps<Bindings>>
      | Effect.Effect<InputProps<SvelteKitProps<Bindings>>, never, Req>,
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
    ? (id: string, propsEff: any) => effectClass(SvelteKit(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            // SvelteKit's server graph is built for Node and needs
            // `nodejs_compat` — `getCompatibility` already adds it to every
            // non-python Worker.
            assets: props?.assets,
            source: {
              provider: "@alchemy.run/frontend-frameworks/sveltekit/source",
              devMode: "server",
              rootDir: props?.rootDir,
              options: {
                rootDir: props?.rootDir,
                memo: props?.memo,
                kit: props?.kit,
                // The adapter's build-time page GENERATION (404.html /
                // app-shell index.html) is derived from the one
                // platform-native knob, `assets.notFoundHandling`, so a
                // single prop configures generation AND serving — the two
                // halves can never disagree. The generated 404-page
                // renders the app shell so kit's own error page shows.
                ...(props?.assets?.notFoundHandling !== undefined &&
                props.assets.notFoundHandling !== "none"
                  ? {
                      adapter: {
                        notFoundHandling: props.assets.notFoundHandling,
                        fallback: "spa",
                      },
                    }
                  : {}),
              },
            },
          }),
        ),
      )) as any;

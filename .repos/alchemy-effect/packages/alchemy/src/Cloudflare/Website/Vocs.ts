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

const VOCS_SOURCE_PROVIDER = "@alchemy.run/frontend-frameworks/vocs/source";

export interface VocsProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * Root directory of the Vocs project.
   * @default process.cwd()
   */
  rootDir?: string;
  /**
   * Vocs build output directory, relative to {@link rootDir}. Set this when
   * `vocs.config.*` customizes `outDir` so generated output stays outside the
   * rebuild hash.
   * @default "dist"
   */
  outDir?: string;
  /**
   * Controls which files feed the content hash that decides whether Vocs
   * rebuilds. By default every non-gitignored file under {@link rootDir} is
   * hashed, plus the nearest package-manager lockfile.
   */
  memo?: MemoOptions;
  /**
   * Static asset routing configuration. Vocs links prerendered pages without
   * trailing slashes, so extensionless routing is enabled by default.
   * @default { htmlHandling: "drop-trailing-slash" }
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a [Vocs](https://vocs.dev) documentation project.
 *
 * Vocs' `vocs.config.*` loads natively. Alchemy runs Vocs' Waku/RSC build,
 * deploys its server environments as a Worker, and publishes the client and
 * prerendered output as static assets. No Vite or Wrangler config is required.
 *
 * Requires `@alchemy.run/frontend-frameworks`, `vocs`, and Vocs' Waku peer
 * dependencies in the project.
 *
 * Input files are content-hashed (respecting `.gitignore` by default), so an
 * unchanged project skips its build and deployment. Vocs' server runtime uses
 * Node APIs, enabled by the Worker's compatibility date
 * flags automatically.
 *
 * ### Deploying a Vocs Site
 * A single resource builds the documentation project and deploys its server
 * runtime, prerendered pages, generated files, and public assets.
 *
 * **Example:** Vocs documentation site
 * ```typescript
 * const docs = yield* Cloudflare.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 * });
 * ```
 *
 * ### Bindings
 * Pass Cloudflare resources through `env` like any other Worker. Server-side
 * Vocs and MDX code can access them from `cloudflare:workers`.
 *
 * **Example:** Vocs with a KV namespace
 * ```typescript
 * const searchCache = yield* Cloudflare.KV.Namespace("SearchCache");
 *
 * const docs = yield* Cloudflare.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   env: {
 *     SEARCH_CACHE: searchCache,
 *   },
 * });
 * ```
 *
 * ### Custom Build Output
 * Vocs configuration continues to own the output directory. When
 * `vocs.config.*` changes `outDir`, mirror that value on the resource so the
 * generated directory is excluded from the rebuild hash and read correctly.
 *
 * **Example:** Custom output directory
 * ```typescript
 * // vocs.config.ts: defineConfig({ outDir: "build" })
 * const docs = yield* Cloudflare.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   outDir: "build",
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * Use `memo` to narrow the files that trigger a rebuild in large projects.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const docs = yield* Cloudflare.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   memo: {
 *     include: ["src/**", "public/**", "vocs.config.ts", "package.json"],
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `Vocs` without arguments returns a constructor for declaring the
 * deployed Worker as a named class.
 *
 * **Example:** Declaring a Vocs Worker class
 * ```typescript
 * class Docs extends Cloudflare.Website.Vocs<Docs>()("Docs", {
 *   rootDir: "./docs",
 * }) {}
 *
 * const docs = yield* Docs;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const Vocs: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<VocsProps<Bindings>>
        | Effect.Effect<InputProps<VocsProps<Bindings>>, never, Req>,
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
      | InputProps<VocsProps<Bindings>>
      | Effect.Effect<InputProps<VocsProps<Bindings>>, never, Req>,
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
    ? (id: string, propsEff: any) => effectClass(Vocs(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            // The Worker compatibility resolver enables Node.js APIs from
            // the date (or adds the flag when a caller pins an older date).
            assets: {
              htmlHandling: "drop-trailing-slash" as const,
              ...props?.assets,
            },
            main: undefined!,
            source: {
              provider: VOCS_SOURCE_PROVIDER,
              devMode: "server",
              options: {
                rootDir: props?.rootDir,
                outDir: props?.outDir,
                memo: props?.memo,
              },
            },
          }),
        ),
      )) as any;

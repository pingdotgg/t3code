import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Command, type CommandProps } from "../../Build/Command.ts";
import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface StaticSiteProps<Bindings extends WorkerBindingProps = {}>
  extends
    Omit<WorkerProps<Bindings, WorkerAssetsConfig>, "assets" | "dev">,
    Omit<CommandProps, "env"> {
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assetsConfig?: AssetsConfig;
  dev?: {
    command: string;
  };
}

export type StaticSite = ReturnType<typeof StaticSite>;

/**
 * A Cloudflare Worker that serves static assets built by a shell command.
 *
 * `StaticSite` runs a build command (e.g. `npm run build`), content-hashes
 * the output directory, and deploys the result as a Cloudflare Worker with
 * static assets. Use this when your site has its own build step that
 * produces a directory of files — Hugo, Zola, Eleventy, or any custom
 * pipeline.
 *
 * For Vite-based projects, prefer `Cloudflare.Vite` which handles
 * building automatically.
 *
 * @resource
 *
 * @section Basic Usage
 * Point `command` at your build script, `outdir` at where it writes
 * output, and `main` at a Worker entrypoint that serves the assets.
 * Alchemy runs the command, hashes the output, and deploys the
 * Worker bound to the built assets.
 *
 * The Worker receives an `ASSETS` binding it can delegate to. A
 * minimal passthrough Worker looks like:
 *
 * ```typescript
 * // src/worker.ts
 * export default {
 *   fetch: (request: Request, env: { ASSETS: Fetcher }) =>
 *     env.ASSETS.fetch(request),
 * };
 * ```
 *
 * @example Deploying a Hugo site
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 *   main: "./src/worker.ts",
 * });
 * ```
 *
 * @section Asset Configuration
 * Use `assetsConfig` to control how Cloudflare handles routing for
 * your static files — HTML handling, not-found behavior, etc.
 *
 * @example SPA-style routing
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "./src/worker.ts",
 *   assetsConfig: {
 *     htmlHandling: "auto-trailing-slash",
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 *
 * @section Building from a Subdirectory
 * Set `cwd` to run the build command in a subdirectory (e.g. a
 * monorepo package). `outdir` is resolved relative to `cwd`.
 *
 * @example Building a frontend in a monorepo
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "apps/web/worker.ts",
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, all non-gitignored files are hashed to decide whether
 * the build should re-run. Use `memo` to narrow the scope.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("Docs", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "./src/worker.ts",
 *   memo: {
 *     include: ["content/**", "templates/**", "config.toml"],
 *   },
 * });
 * ```
 */
export const StaticSite = <
  const Bindings extends WorkerBindingProps = {},
  Req = never,
>(
  id: string,
  propsEff:
    | InputProps<StaticSiteProps<Bindings>>
    | Effect.Effect<InputProps<StaticSiteProps<Bindings>>, never, Req>,
) =>
  Effect.gen(function* () {
    const props = Effect.isEffect(propsEff)
      ? propsEff
      : Effect.succeed(propsEff);

    // TODO(sam): local dev/hmr support?
    const build = yield* Command(
      "Build",
      Effect.map(props, (props) => ({
        command: props.command,
        cwd: props.cwd,
        memo: props.memo,
        outdir: props.outdir,
        env: props.env
          ? Object.fromEntries(
              Object.entries(props.env).flatMap(([k, v]) => {
                if (v === undefined) return [];
                if (typeof v === "string" || Redacted.isRedacted(v))
                  return [[k, v]];
                return [[k, JSON.stringify(v)]];
              }),
            )
          : undefined,
      })),
    );

    return yield* Worker<Bindings, WorkerAssetsConfig, Req>(
      "Worker",
      Effect.map(props, (props) => ({
        ...props,
        assets: {
          path: build.outdir,
          hash: build.hash,
          config: props.assetsConfig,
        },
        // Omit the dev command from WorkerProps since it's different from WorkerProps["dev"].
        // TODO: we'll need to update this when we add local dev support for StaticSite.
        dev: undefined,
      })),
    );
  }).pipe(Namespace.push(id));

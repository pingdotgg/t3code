import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import type { Input, InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { effectClass } from "../../Util/effect.ts";
import { asEffect } from "../../Util/types.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface StaticSiteProps<Bindings extends WorkerBindingProps = {}>
  extends
    Omit<WorkerProps<Bindings, WorkerAssetsConfig>, "assets" | "dev">,
    Omit<Command.BuildProps, "env"> {
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */

  assets?: AssetsConfig;
  /**
   * Local dev configuration. When `alchemy dev` runs, the build command is
   * skipped and `command` is spawned as a long-lived child process tied to
   * the stack's scope. Alchemy does not proxy or interpret the process —
   * the dev server's own URL (e.g. `http://localhost:5173`) is what you
   * open in the browser.
   *
   * @example
   * ```typescript
   * Cloudflare.Website.StaticSite("App", {
   *   command: "npm run build",
   *   outdir: "dist",
   *   main: "./src/worker.ts",
   *   dev: { command: "npm run dev" },
   * });
   * ```
   */
  dev?: {
    /**
     * Shell command to run as the local dev server (e.g. `npm run dev`).
     */
    command: string;
    /**
     * Working directory for {@link command}. Defaults to
     * {@link Command.BuildProps.cwd} (the build command's `cwd`), or
     * `process.cwd()` if neither is set.
     */
    cwd?: string;
    /**
     * Environment variables for {@link command}, merged on top of
     * `process.env`. When set, these replace the top-level `env` for the
     * dev process; otherwise the top-level `env` is passed through.
     * `Redacted` values stay out of logs and state, so put secrets here
     * rather than interpolating them into {@link command}.
     */
    env?: Record<string, string | Redacted.Redacted<string>>;
    /**
     * Override for the `url` output if alchemy fails to detect it from the stdout of the dev command
     */
    url?: string;
  };
}

type StaticSiteWorker<Bindings extends WorkerBindingProps> = Worker<{
  [binding in keyof NormalizedBindings<
    Bindings,
    WorkerAssetsConfig
  >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
}>;

/**
 * A Cloudflare Worker that serves static assets built by a shell command.
 *
 * `StaticSite` runs a build command (e.g. `npm run build`), content-hashes
 * the output directory, and deploys the result as a Cloudflare Worker with
 * static assets. Use this when your site has its own build step that
 * produces a directory of files — Hugo, Zola, Eleventy, or any custom
 * pipeline.
 *
 * For Vite-based projects, prefer `Cloudflare.Website.Vite` which handles
 * building automatically.
 *
 * @resource
 * @product Website
 * @category Workers & Compute
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
 * const site = yield* Cloudflare.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 *   main: "./src/worker.ts",
 * });
 * ```
 *
 * @section Asset Configuration
 * Use `assets` to control how Cloudflare handles routing for
 * your static files — HTML handling, not-found behavior, etc.
 *
 * @example SPA-style routing
 * ```typescript
 * const site = yield* Cloudflare.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "./src/worker.ts",
 *   assets: {
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
 * const site = yield* Cloudflare.Website.StaticSite("Web", {
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
 * const site = yield* Cloudflare.Website.StaticSite("Docs", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "./src/worker.ts",
 *   memo: {
 *     include: ["content/**", "templates/**", "config.toml"],
 *   },
 * });
 * ```
 *
 * @section Class Form
 * Calling `StaticSite` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both
 * an `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Blog extends Cloudflare.Website.StaticSite<Blog>()("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 *   main: "./src/worker.ts",
 * }) {}
 *
 * const site = yield* Blog;
 * ```
 */
export const StaticSite: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff:
        | InputProps<StaticSiteProps<Bindings>, "dev">
        | Effect.Effect<
            InputProps<StaticSiteProps<Bindings>, "dev">,
            never,
            Req
          >,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): StaticSiteWorker<Bindings>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff:
      | InputProps<StaticSiteProps<Bindings>, "dev">
      | Effect.Effect<InputProps<StaticSiteProps<Bindings>, "dev">, never, Req>,
  ): Effect.Effect<StaticSiteWorker<Bindings>, never, Req | Providers>;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(makeStaticSite(id, propsEff))
    : makeStaticSite(id, propsEff)) as any;

const makeStaticSite = <
  const Bindings extends WorkerBindingProps = {},
  Req = never,
>(
  id: string,
  propsEff:
    | InputProps<StaticSiteProps<Bindings>, "dev">
    | Effect.Effect<InputProps<StaticSiteProps<Bindings>, "dev">, never, Req>,
) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const props = yield* asEffect(propsEff);

    // In dev mode with a dev.command, declare a DevCommand resource so
    // the sidecar owns the process lifecycle (survives user-code HMR),
    // skip the build, and tell Worker not to start a local instance.
    const dev =
      ctx.dev && props.dev
        ? yield* Command.Dev("Dev", {
            command: props.dev.command,
            cwd:
              props.dev.cwd ??
              (typeof props.cwd === "string" ? props.cwd : undefined),
            env: serializeEnv(props.dev.env ?? props.env),
          }).pipe(
            Effect.map((d) =>
              Output.map(d.url, (url) => ({
                url: url ?? props.dev?.url,
              })),
            ),
          )
        : undefined;

    const build = dev
      ? undefined
      : yield* Command.Build("Build", {
          command: props.command,
          cwd: props.cwd,
          memo: props.memo,
          outdir: props.outdir,
          env: serializeEnv(props.env),
        });

    // Pure-static sites don't need a custom Worker entrypoint —
    // delegate every request straight to the ASSETS binding. Only
    // injected when the user provided neither `main` nor `script`.
    const fallbackScript =
      props.main == null && props.script == null
        ? `export default { fetch: (request, env) => env.ASSETS.fetch(request) };`
        : undefined;

    return yield* Worker<Bindings, WorkerAssetsConfig, Req>("Worker", {
      ...props,
      assets: build
        ? cast({
            directory: build.outdir,
            hash: build.hash,
            ...props.assets,
          })
        : undefined,
      // Opt out of the local Worker in dev when the external DevCommand
      // is serving the content. The Worker resource still exists in
      // state with a stub Attributes shape.
      dev: dev ? { mode: "external", url: dev.url } : undefined,
      script: fallbackScript ?? props.script,
    });
  }).pipe(Namespace.push(id));

const serializeEnv = (
  env: Input<
    | WorkerBindingProps
    | Record<string, string | Redacted.Redacted<string>>
    | undefined
  >,
) =>
  Object.fromEntries(
    Object.entries(env ?? {}).flatMap(([k, v]) => {
      if (v === undefined) return [];
      if (typeof v === "string" || Redacted.isRedacted(v)) return [[k, v]];
      return [[k, JSON.stringify(v)]];
    }),
  );

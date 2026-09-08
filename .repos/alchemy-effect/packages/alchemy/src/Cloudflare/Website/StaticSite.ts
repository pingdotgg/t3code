import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import type { Input, InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { renamedFrom } from "../../Rename.ts";
import {
  effectClass,
  isYieldableEffectLike,
  type YieldableEffectLike,
} from "../../Util/effect.ts";
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
import { isContainerDecl } from "../Workers/WorkerAsyncBindings.ts";

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
  [
    binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
  ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
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
 *
 * ### Basic Usage
 * Point `command` at your build script and `outdir` at where it writes
 * output. Alchemy runs the command, hashes the output, and deploys it as
 * an assets-only Worker — no Worker code is uploaded, and Cloudflare's
 * asset layer serves every request itself.
 *
 * **Example:** Deploying a Hugo site
 * ```typescript
 * const site = yield* Cloudflare.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * ```
 *
 * Provide `main` to put your own Worker in front of the assets instead.
 * The Worker receives an `ASSETS` binding it can delegate to:
 *
 * ```typescript
 * // src/worker.ts
 * export default {
 *   fetch: (request: Request, env: { ASSETS: Fetcher }) =>
 *     env.ASSETS.fetch(request),
 * };
 * ```
 *
 * **Example:** Custom Worker in front of the assets
 * ```typescript
 * const site = yield* Cloudflare.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 *   main: "./src/worker.ts",
 * });
 * ```
 *
 * ### Asset Configuration
 * Use `assets` to control how Cloudflare handles routing for
 * your static files — HTML handling, not-found behavior, etc.
 *
 * **Example:** SPA-style routing
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
 * ### Building from a Subdirectory
 * Set `cwd` to run the build command in a subdirectory (e.g. a
 * monorepo package). `outdir` is resolved relative to `cwd`.
 *
 * **Example:** Building a frontend in a monorepo
 * ```typescript
 * const site = yield* Cloudflare.Website.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "apps/web/worker.ts",
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * By default, all non-gitignored files are hashed to decide whether
 * the build should re-run. Use `memo` to narrow the scope.
 *
 * **Example:** Narrowing the memo scope
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
 * **Example:** Rebuilding when a sibling workspace package changes
 * The default scope only hashes files under `cwd` (plus the nearest
 * lockfile), so edits to a sibling workspace package the app imports do
 * not retrigger the build on their own. Add the sibling's sources with a
 * `../` include glob — and keep `lockfile: true`, since providing
 * `include` otherwise drops the lockfile from the hash:
 * ```typescript
 * const site = yield* Cloudflare.Website.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 *   main: "./src/worker.ts",
 *   memo: {
 *     include: ["**\/*", "../../packages/env/src/**"],
 *     lockfile: true,
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Calling `StaticSite` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both
 * an `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Blog extends Cloudflare.Website.StaticSite<Blog>()("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 *   main: "./src/worker.ts",
 * }) {}
 *
 * const site = yield* Blog;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
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

    // `Dev` and `Build` carry constant logical ids, so they are namespaced
    // under `id` to keep two sites on one stack from colliding. Nothing
    // else is: the site's own `props` — and the resources its `env`
    // bindings declare — must resolve in the CALLER's namespace. Pushing
    // the namespace around the whole body instead re-declares a shared
    // resource referenced from `env` as a second copy under `<id>/`.
    // `Vite` already passes `id` straight through to `Worker`.

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
            env: yield* serializeEnv(props.dev.env ?? props.env),
          }).pipe(
            Namespace.push(id),
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
          env: yield* serializeEnv(props.env),
        }).pipe(Namespace.push(id));

    // Pure-static sites (neither `main` nor `script`) deploy as
    // assets-only Workers: no script is uploaded and Cloudflare's asset
    // layer serves every request itself.
    //
    // The Worker's FQN was `<id>/Worker` before #1053 flattened it to
    // `<id>`; `renamedFrom` migrates the pre-existing state row to the new
    // FQN instead of letting the engine plan a create+delete replacement
    // (a new physical name, a torn-down workers.dev URL, and a
    // custom-domain handover that crashes the deploy).
    return yield* Worker<Bindings, WorkerAssetsConfig, Req>(id, {
      ...props,
      assets: build
        ? cast({
            directory: build.outdir,
            hash: build.hash.output,
            ...props.assets,
          })
        : undefined,
      // Opt out of the local Worker in dev when the external DevCommand
      // is serving the content. The Worker resource still exists in
      // state with a stub Attributes shape.
      dev: dev ? { mode: "external", url: dev.url } : undefined,
      script: props.script,
    }).pipe(renamedFrom(`${id}/Worker`));
  });

/**
 * Serialize the site's `env` for the build/dev subprocess. The same record
 * doubles as the Worker's binding props, so entries may be plain strings,
 * `Redacted` secrets, `effect/Config` values, `Output` references, or
 * binding Effects:
 *
 * - strings and `Redacted` values pass through unchanged
 * - `Config` (and any other runnable Effect) is resolved here, at stack
 *   construction — passing it through unresolved would hand the subprocess
 *   the JSON-serialized `Config` object (`{"_id":"Config"}`) instead of its
 *   value (#796)
 * - `Output` references resolve at reconcile; the resolved value is
 *   serialized the same way inline values are (an `Output<object>` must
 *   reach the subprocess as JSON, not `[object Object]`)
 * - binding Effects (`~alchemy/Kind`-marked, e.g. a `WorkerLoader`) and
 *   `Cloudflare.Container` declarations have no env-var representation and
 *   are dropped
 * - remaining plain values (`null`, numbers, JSON objects) are stringified
 */
const serializeEnv = Effect.fn(function* (
  env: Input<
    | WorkerBindingProps
    | Record<string, string | Redacted.Redacted<string>>
    | undefined
  >,
) {
  const entries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) continue;
    if (typeof v === "string" || Redacted.isRedacted(v)) {
      entries.push([k, v]);
    } else if (Output.isOutput(v)) {
      entries.push([k, Output.map(v, serializeEnvValue)]);
    } else if (isContainerDecl(v)) {
      // A `Cloudflare.Container` declaration is Effect-shaped but is a
      // binding (DO namespace + ContainerApplication) — yielding it would
      // resolve the started-instance tag, which only exists inside a
      // Durable Object (#997). Deploy-time only, nothing to expose to the
      // build subprocess.
      continue;
    } else if (isYieldableEffectLike(v)) {
      const resolved = serializeEnvValue(
        yield* asEffect(v as YieldableEffectLike<unknown, unknown, never>).pipe(
          Effect.orDie,
        ),
      );
      if (resolved === undefined) continue;
      entries.push([k, resolved]);
    } else if (v !== null && typeof v === "object" && "~alchemy/Kind" in v) {
      // A binding Effect (e.g. WorkerLoader) — deploy-time only, nothing to
      // expose to the build subprocess.
      continue;
    } else {
      entries.push([k, JSON.stringify(v)]);
    }
  }
  return Object.fromEntries(entries) as Record<
    string,
    string | Redacted.Redacted<string>
  >;
});

/**
 * Serialize one resolved env value for the build/dev subprocess: strings and
 * `Redacted` pass through, everything else becomes JSON.
 */
const serializeEnvValue = (
  value: unknown,
): string | Redacted.Redacted<string> | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.isRedacted(value)
        ? (value as Redacted.Redacted<string>)
        : JSON.stringify(value);

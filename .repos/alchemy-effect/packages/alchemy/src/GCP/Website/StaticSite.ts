import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { loadFrontendCore } from "../../Website/FrontendCore.ts";
import { Service } from "../Run/Service.ts";
import {
  type FrameworkSite,
  type WebsiteAssetsProps,
  type WebsiteServiceProps,
  staticConfigFromAssets,
  websiteServiceProps,
} from "./FrameworkSite.ts";

export interface StaticSiteProps extends WebsiteServiceProps {
  /**
   * Path to the local site directory (working directory for
   * {@link build.command}).
   * @default "."
   */
  path?: string;
  /**
   * Build executed before deploy.
   */
  build: {
    /** Shell command that produces the site (e.g. `"hugo --minify"`). */
    command: string;
    /** Directory the command writes, relative to {@link path}. */
    output: string;
    /** Environment variables for the build command. */
    env?: Record<string, string | Redacted.Redacted<string>>;
  };
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Process environment for the hosted static server.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Miss handling for the generated file server.
   */
  assets?: WebsiteAssetsProps;
  /**
   * Local dev configuration. When `alchemy dev` runs with `dev.command`,
   * the build is skipped and `command` is spawned as a long-lived child.
   */
  dev?: {
    /**
     * Shell command to run as the local dev server (e.g. `npm run dev`).
     */
    command: string;
    /**
     * Working directory for {@link command}. Defaults to {@link path}.
     */
    cwd?: string;
    /**
     * Environment variables for {@link command}.
     */
    env?: Record<string, string | Redacted.Redacted<string>>;
    /**
     * Override for the `url` output if alchemy fails to detect it from
     * stdout of the dev command.
     */
    url?: string;
  };
}

/**
 * Deploy a static site built by a shell command to Cloud Run.
 *
 * `StaticSite` runs a build command (e.g. `npm run build` / `hugo`),
 * content-hashes the output directory, and deploys a Cloud Run service
 * whose image is a tiny Node file server over those files (plus
 * `/health`). Use this when the site has its own build step — Hugo, Zola,
 * Eleventy, or any custom pipeline.
 *
 * For Vite-based projects, prefer `GCP.Website.Vite`. For a bucket-backed
 * site behind a CDN, compose `GCP.Storage.Bucket` with a load balancer
 * instead (see the `gcp-static-site` example).
 *
 * `Build` / `Dev` use constant logical ids under `Namespace.push(id)`.
 * The Cloud Run service stays in the caller namespace.
 *
 *
 * ### Basic Usage
 * **Example:** Deploying a Hugo site
 * ```typescript
 * const site = yield* GCP.Website.StaticSite("Blog", {
 *   build: { command: "hugo --minify", output: "public" },
 * });
 * ```
 *
 * **Example:** SPA-style routing
 * ```typescript
 * const site = yield* GCP.Website.StaticSite("App", {
 *   build: { command: "npm run build", output: "dist" },
 *   assets: { notFoundHandling: "single-page-application" },
 * });
 * ```
 *
 * ### Building from a Subdirectory
 * **Example:** Building a frontend in a monorepo
 * ```typescript
 * const site = yield* GCP.Website.StaticSite("Web", {
 *   path: "apps/web",
 *   build: { command: "npm run build", output: "dist" },
 * });
 * ```
 *
 * ### Cloud Run Settings
 * **Example:** Private site with a warm instance
 * ```typescript
 * const site = yield* GCP.Website.StaticSite("Internal", {
 *   build: { command: "npm run build", output: "dist" },
 *   public: false,
 *   scaling: { minInstanceCount: 1 },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** External dev command
 * ```typescript
 * const site = yield* GCP.Website.StaticSite("App", {
 *   build: { command: "npm run build", output: "dist" },
 *   dev: { command: "npm run dev" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const StaticSite = (id: string, props: StaticSiteProps) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;
    const path = yield* Path.Path;

    if (isLocal && props.dev) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? props.path,
        env: props.dev.env ?? props.env,
      }).pipe(Namespace.push(id));
      const url = Output.map(dev.url, (value) => value ?? props.dev?.url);
      return { url, service: undefined } satisfies FrameworkSite;
    }

    const build = yield* Command.Build("Build", {
      command: props.build.command,
      cwd: props.path,
      memo: props.memo,
      outdir: props.build.output,
      env: props.build.env ?? props.env,
    }).pipe(Namespace.push(id));

    const cwd = path.resolve(initialCwd, props.path ?? ".");
    const outdir = path.resolve(cwd, props.build.output);
    const internal = staticConfigFromAssets(props.assets);
    const notFoundHandling =
      internal.errorPage !== undefined
        ? ("404-page" as const)
        : internal.spa === true
          ? ("spa" as const)
          : ("none" as const);

    const {
      NODE_SERVE_ENTRY_FILE_NAME,
      relativeClientDirExpression,
      writeNodeServeEntry,
    } = yield* loadFrontendCore;
    const servePath = path.join(
      path.dirname(outdir),
      NODE_SERVE_ENTRY_FILE_NAME,
    );
    yield* writeNodeServeEntry({
      output: {
        clientDirectory: outdir,
        serverModules: [],
        externalWorkspaces: new Set<string>(),
      },
      servePath,
      serveModuleName: NODE_SERVE_ENTRY_FILE_NAME,
      clientDirExpression: relativeClientDirExpression(servePath, outdir),
      notFoundHandling,
      printUrl: isLocal,
      platform: "node",
    });

    if (isLocal) {
      const runtime = yield* Effect.sync(() => process.execPath);
      const dev = yield* Command.Dev("Dev", {
        command: `${runtime} ${servePath}`,
        cwd: path.dirname(servePath),
        env: {
          ...props.env,
          PORT: "0",
          HOST: "127.0.0.1",
          ALCHEMY_BUILD_HASH: build.hash.output as unknown as string,
        },
      }).pipe(Namespace.push(id));
      return {
        url: Output.map(dev.url, (value) => value),
        service: undefined,
      } satisfies FrameworkSite;
    }

    const service = yield* Service(
      id,
      websiteServiceProps(props, {
        main: servePath,
        extraFiles: [
          {
            // Keep the build dependency so planning cannot hash the previous artifact.
            source: Output.map(build.outdir, (dir) =>
              path.resolve(initialCwd, dir),
            ) as unknown as string,
            dest: path.basename(outdir),
          },
        ],
      }),
    );

    return { url: service.uri, service } satisfies FrameworkSite;
  }).pipe(Effect.orDie);

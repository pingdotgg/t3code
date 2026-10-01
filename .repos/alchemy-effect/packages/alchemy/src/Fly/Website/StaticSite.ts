import {
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "@alchemy.run/frontend-frameworks/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { App } from "../App.ts";
import { Certificate } from "../Certificate.ts";
import { IpAssignment } from "../IpAssignment.ts";
import { Service } from "../Service.ts";
import {
  type FrameworkSite,
  type Ref,
  type WebsiteAssetsProps,
  staticConfigFromAssets,
} from "./FrameworkSite.ts";

const DEFAULT_PORT = 3000;

const resolveRef = <T>(ref: Ref<T>) =>
  Effect.isEffect(ref) ? ref : Effect.succeed(ref);

export interface StaticSiteProps {
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
   * Parent Fly App. When omitted, a `Fly.App` is created. The Service
   * stays in the caller namespace; only `Build` / `Dev` are pushed.
   */
  app?: Ref<App>;
  /**
   * Optional custom hostname. Requests ACME (`Fly.Certificate`) on the App.
   */
  domain?: string;
  /**
   * User-defined tags. Accepted for API parity; Fly Services do not
   * surface resource tags.
   */
  tags?: Record<string, string>;
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
     * Working directory for {@link command}. Defaults to {@link cwd}.
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
 * Deploy a static site built by a shell command to Fly.
 *
 * `StaticSite` runs a build command (e.g. `npm run build` / `hugo`),
 * content-hashes the output directory, and deploys a Service that serves
 * those files (plus `/health`). Use this when the site has its own build
 * step — Hugo, Zola, Eleventy, or any custom pipeline.
 *
 * For Vite-based projects, prefer `Fly.Website.Vite`.
 *
 * `Build` / `Dev` use constant logical ids under `Namespace.push(id)`.
 * The Service stays in the caller namespace (same as
 * `Cloudflare.Website.StaticSite`).
 *
 *
 * ### Basic Usage
 * **Example:** Deploying a Hugo site
 * ```typescript
 * const site = yield* Fly.Website.StaticSite("Blog", {
 *   build: { command: "hugo --minify", output: "public" },
 * });
 * ```
 *
 * **Example:** SPA-style routing
 * ```typescript
 * const site = yield* Fly.Website.StaticSite("App", {
 *   build: { command: "npm run build", output: "dist" },
 *   assets: { notFoundHandling: "single-page-application" },
 * });
 * ```
 *
 * ### Building from a Subdirectory
 * **Example:** Building a frontend in a monorepo
 * ```typescript
 * const site = yield* Fly.Website.StaticSite("Web", {
 *   path: "apps/web",
 *   build: { command: "npm run build", output: "dist" },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** External dev command
 * ```typescript
 * const site = yield* Fly.Website.StaticSite("App", {
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

    const empty = (): FrameworkSite => ({
      url: undefined,
      app: undefined,
      service: undefined,
      ip: undefined,
      certificate: undefined,
    });

    if (isLocal && props.dev) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? props.path,
        env: props.dev.env ?? props.env,
      }).pipe(Namespace.push(id));
      const url = Output.map(dev.url, (value) => value ?? props.dev?.url);
      return { ...empty(), url };
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

    const servePath = path.join(
      path.dirname(outdir),
      NODE_SERVE_ENTRY_FILE_NAME,
    );
    const serveOutput = {
      clientDirectory: outdir,
      serverModules: [],
      externalWorkspaces: new Set<string>(),
    };
    yield* writeNodeServeEntry({
      output: serveOutput,
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
        ...empty(),
        url: Output.map(dev.url, (value) => value),
      };
    }

    const main = servePath;

    const app =
      props.app !== undefined
        ? yield* resolveRef(props.app)
        : yield* App("App").pipe(Namespace.push(id));

    const ip = yield* IpAssignment("Shared", {
      app,
      type: "shared_v4",
    }).pipe(Namespace.push(id));

    // Serve the built tree from the Machine. Fly Tigris `statics` on
    // `urlPrefix: "/"` do not rewrite HTML routes and hang GET `/`.
    // Hashed `/assets` still go to Tigris on FrameworkSite.
    const service = yield* Service(id, {
      app,
      main,
      port: DEFAULT_PORT,
      // Generated static-file server is a complete bun/node program.
      isExternal: true,
      env: props.env,
      extraFiles: [
        {
          source: outdir,
          dest: path.basename(outdir),
        },
      ],
    });

    const certificate =
      props.domain !== undefined
        ? yield* Certificate("Certificate", {
            app,
            hostname: props.domain,
            kind: "acme",
          }).pipe(Namespace.push(id))
        : undefined;

    const url =
      props.domain !== undefined ? `https://${props.domain}` : app.url;

    return { url, app, service, ip, certificate };
  }).pipe(Effect.orDie);

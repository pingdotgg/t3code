import {
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "@alchemy.run/frontend-frameworks/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import * as Namespace from "../../Namespace.ts";
import type * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { CustomDomain } from "../CustomDomain.ts";
import { Project } from "../Project.ts";
import { Service } from "../Service.ts";
import {
  WEBSITE_PORT,
  type FrameworkSiteProps,
  type Website,
} from "./FrameworkSite.ts";

// `env` comes from FrameworkSiteProps (which additionally accepts `Output`
// values, e.g. `VITE_API_URL: api.url`) — it must be omitted from the
// BuildProps side because interfaces cannot extend two parents whose `env`
// members differ.
export interface StaticSiteProps
  extends
    Omit<Command.BuildProps, "env">,
    Pick<
      FrameworkSiteProps,
      "project" | "environment" | "domain" | "tags" | "env"
    > {
  /**
   * Local dev configuration. When `alchemy dev` runs with `dev.command`,
   * the build is skipped and `command` is spawned as a long-lived child
   * (`Command.Dev`). Without `dev.command`, the site still builds and a
   * local static server serves `outdir` — no Railway Service is created.
   */
  dev?: {
    /**
     * Shell command to run as the local dev server (e.g. `npm run dev`).
     */
    command: string;
    /**
     * Working directory for {@link command}. Defaults to
     * {@link Command.BuildProps.cwd}.
     */
    cwd?: string;
    /**
     * Environment variables for {@link command}, merged on top of
     * `process.env`.
     */
    env?: Record<string, string | Redacted.Redacted<string>>;
    /**
     * Override for the `url` output if alchemy fails to detect it from
     * the stdout of the dev command.
     */
    url?: string;
  };
  /**
   * Answer misses with the index page (200) instead of a 404 so
   * client-side routes deep-link. Mutually exclusive with {@link errorPage}.
   */
  spa?: boolean;
  /**
   * Serve this page (e.g. `404.html`) with status 404 when no file
   * matches. Mutually exclusive with {@link spa}.
   */
  errorPage?: string;
}

const envRecord = (
  env:
    | Record<
        string,
        string | Redacted.Redacted<string> | Output.Output<string | undefined>
      >
    | undefined,
): Record<string, string | Output.Output<string | undefined>> | undefined => {
  if (env === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );
};

/**
 * A Railway Service that serves static assets built by a shell command.
 *
 * `StaticSite` runs a build command (e.g. `npm run build`), content-hashes
 * the output directory, and deploys the result as a Node static-file
 * server on one `Railway.Service`. Use this when your site has its own
 * build step that produces a directory of files — Hugo, Zola, Eleventy, or
 * any custom pipeline.
 *
 * For Vite-based projects, prefer {@link Vite | Railway.Website.Vite}
 * which handles building automatically.
 *
 * Cloudflare DX: top-level `command` + `outdir` (`Command.BuildProps`).
 * Only `Command.Build("Build")` / `Command.Dev("Dev")` are pushed under
 * the site id; the Service stays in the caller namespace.
 *
 * During `alchemy dev`, `dev.command` skips the build and is the site.
 * Without `dev.command`, the site still builds and a local static server
 * serves `outdir` — no Project or Service is created.
 *
 * ### Basic Usage
 * **Example:** Deploying a Hugo site
 * ```typescript
 * const site = yield* Railway.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * ```
 *
 * **Example:** SPA-style routing
 * ```typescript
 * const site = yield* Railway.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   spa: true,
 * });
 * ```
 *
 * ### Building from a Subdirectory
 * **Example:** Building a frontend in a monorepo
 * ```typescript
 * const site = yield* Railway.Website.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 * });
 * ```
 *
 * ### Local Development
 * **Example:** External dev command
 * ```typescript
 * const site = yield* Railway.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
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
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (isLocal && props.dev !== undefined) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? props.cwd,
        env: props.dev.env ?? props.env,
      }).pipe(Namespace.push(id));
      return {
        url: props.dev.url ?? dev.url,
        service: undefined,
        project: undefined,
      } satisfies Website;
    }

    yield* Command.Build("Build", {
      command: props.command,
      cwd: props.cwd,
      memo: props.memo,
      outdir: props.outdir,
      env: props.env,
      shell: props.shell,
      timeout: props.timeout,
    }).pipe(Namespace.push(id));

    const cwd = path.resolve(initialCwd, props.cwd ?? ".");
    const clientAbs = path.resolve(cwd, props.outdir);

    const servePath = path.join(
      path.dirname(clientAbs),
      NODE_SERVE_ENTRY_FILE_NAME,
    );
    yield* writeNodeServeEntry({
      output: {
        clientDirectory: clientAbs,
        serverModules: [],
        externalWorkspaces: new Set<string>(),
      },
      servePath,
      serveModuleName: NODE_SERVE_ENTRY_FILE_NAME,
      clientDirExpression: relativeClientDirExpression(servePath, clientAbs),
      notFoundHandling:
        props.errorPage !== undefined
          ? "404-page"
          : props.spa === true
            ? "spa"
            : "none",
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
        },
      }).pipe(Namespace.push(id));
      return {
        url: dev.url,
        service: undefined,
        project: undefined,
      } satisfies Website;
    }

    const project = Effect.isEffect(props.project)
      ? yield* props.project
      : (props.project ?? (yield* Project("Project").pipe(Namespace.push(id))));
    const environment = Effect.isEffect(props.environment)
      ? yield* props.environment
      : (props.environment ?? project);
    const service = yield* Service(id, {
      project,
      environment,
      main: servePath,
      port: WEBSITE_PORT,
      healthcheck: "/health",
      isExternal: true,
      env: envRecord(props.env),
      extraFiles: [{ source: clientAbs, dest: path.basename(clientAbs) }],
    });

    if (props.domain !== undefined && props.domain.length > 0) {
      yield* CustomDomain("Domain", {
        service,
        environment,
        domain: props.domain,
        targetPort: WEBSITE_PORT,
      }).pipe(Namespace.push(id));
      return {
        url: `https://${props.domain}`,
        service,
        project,
      } satisfies Website;
    }

    return {
      url: service.url,
      service,
      project,
    } satisfies Website;
  }).pipe(Effect.orDie);

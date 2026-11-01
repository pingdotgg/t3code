import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { WebsiteArtifact } from "./Artifact.ts";
import {
  deployWebsite,
  type FrameworkSiteProps,
  type Website,
} from "./FrameworkSite.ts";
import { loadFrontendCore } from "../../Website/FrontendCore.ts";

/** A command-built website with the same build vocabulary as Fly and Railway. */
export interface StaticSiteProps
  extends
    Omit<Command.BuildProps, "env">,
    Omit<FrameworkSiteProps, "dev" | "memo"> {
  /** Local command; skips the production build. Without a command, a local static server serves the built output. */
  dev?: {
    /** Shell command that starts the native dev server. */
    command: string;
    /** Dev command directory; defaults to cwd or rootDir. */
    cwd?: string;
    /** Additional development environment variables. */
    env?: Record<string, string | Redacted.Redacted<string>>;
    /** Explicit dev URL when the command does not print one. */
    url?: string;
  };
  /** Return index.html on unmatched paths. Mutually exclusive with errorPage. */
  spa?: boolean;
  /** HTML file returned with HTTP 404; relative to outdir. Mutually exclusive with spa. */
  errorPage?: string;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Build a static website with a shell command and serve it on Prisma Compute.
 * Only the output directory is packaged; the repository is never uploaded.
 * Native development declares no Prisma Project, Compute, or custom domain.
 * `Alchemy.remote()` opts into the live deployment during development.
 *
 * ### Creating a Static Website
 * **Example:** Hugo website
 * ```typescript
 * const site = yield* Prisma.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * ```
 *
 * ### Monorepos and Development
 * **Example:** A custom frontend build
 * ```typescript
 * const site = yield* Prisma.Website.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 *   spa: true,
 *   dev: { command: "npm run dev" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const StaticSite = (id: string, props: StaticSiteProps) =>
  Effect.gen(function* () {
    const context = yield* AlchemyContext;
    const remote = yield* ProviderModePolicy;
    const local = context.dev && remote !== true;
    const cwd = props.cwd ?? props.rootDir;
    if (local && props.dev !== undefined) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? cwd,
        env: { ...props.env, ...props.dev.env },
      });
      return {
        url: props.dev.url ?? dev.url,
        compute: undefined,
        project: undefined,
        domain: undefined,
      } satisfies Website;
    }
    if (props.spa && props.errorPage !== undefined) {
      return yield* Effect.die(
        new Error("StaticSite spa and errorPage are mutually exclusive."),
      );
    }
    const build = yield* Command.Build("Build", {
      command: props.command,
      cwd,
      env: props.env,
      outdir: props.outdir,
      memo: props.memo,
      shell: props.shell,
      timeout: props.timeout,
    });
    const handling = props.assets?.notFoundHandling;
    const options = {
      notFoundHandling:
        props.errorPage !== undefined
          ? ("404-page" as const)
          : props.spa
            ? ("spa" as const)
            : handling === "single-page-application"
              ? ("spa" as const)
              : (handling ?? ("none" as const)),
      htmlHandling: props.assets?.htmlHandling,
      errorPage: props.errorPage,
    };
    if (local) {
      const { makeNodeServeEntrySource } = yield* loadFrontendCore;
      const path = yield* Path.Path;
      const runtime = yield* Effect.sync(() => process.execPath);
      const command = Output.map(build.outdir, (outdir) => {
        const source = makeNodeServeEntrySource({
          ...options,
          clientDirExpression: JSON.stringify(path.resolve(initialCwd, outdir)),
          printUrl: true,
        });
        return `${quote(runtime)} --eval ${quote(source)}`;
      });
      const dev = yield* Command.Dev("Dev", {
        command,
        cwd,
        shell: true,
        env: { ...props.env, HOST: "127.0.0.1", PORT: "0" },
      });
      return {
        url: dev.url,
        compute: undefined,
        project: undefined,
        domain: undefined,
      } satisfies Website;
    }
    const artifact = yield* WebsiteArtifact("Artifact", {
      root: cwd ?? ".",
      distDir: build.outdir,
      buildHash: build.hash.output,
      static: options,
    });
    return yield* deployWebsite(props, artifact);
  }).pipe(Namespace.push(id));

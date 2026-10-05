import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import type { ExtraFile } from "../../Util/extraFiles.ts";
import { initialCwd } from "../../Util/Node.ts";
import {
  staticConfigFromAssets,
  type WebsiteAssetsProps,
  type WebsiteNotFoundHandling,
} from "../../Website/assets.ts";
import { packSiteExtraFiles } from "../../Website/packExtraFiles.ts";
import {
  Server as FrameworkServer,
  type ServerDevProps,
} from "../../Website/Server.ts";
import {
  Service,
  type ResourceRequirements,
  type RevisionScaling,
  type ServiceProps,
} from "../Run/Service.ts";

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/** Port the Node serve entry listens on (Cloud Run injects `PORT`). */
export const WEBSITE_PORT = 8080;

/** Process environment value for a hosted website. */
export type WebsiteEnvValue =
  | string
  | Redacted.Redacted<string>
  | Output.Output<string | undefined>;

/**
 * Cloud Run knobs shared by every GCP website composite (framework sites
 * and `StaticSite`).
 */
export interface WebsiteServiceProps {
  /**
   * Allow unauthenticated requests. `true` disables Cloud Run's invoker IAM
   * check so anyone can load the site; `false` requires a Google-signed
   * identity token on every request.
   * @default true
   */
  public?: boolean;
  /**
   * Ingress (`INGRESS_TRAFFIC_ALL`, `INGRESS_TRAFFIC_INTERNAL_ONLY`,
   * `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`).
   * @default "INGRESS_TRAFFIC_ALL"
   */
  ingress?: ServiceProps["ingress"];
  /**
   * Revision scaling. Set `minInstanceCount: 1` to avoid cold starts.
   */
  scaling?: RevisionScaling;
  /**
   * CPU / memory for the server container, e.g.
   * `{ limits: { cpu: "1", memory: "1Gi" } }`.
   * @default Cloud Run's default (1 vCPU, 512Mi)
   */
  resources?: ResourceRequirements;
  /**
   * Request timeout (e.g. `"60s"`).
   * @default "300s"
   */
  timeout?: string;
  /**
   * Max concurrent requests per instance.
   * @default 80
   */
  maxInstanceRequestConcurrency?: number;
  /**
   * Runtime service account email. When omitted, Alchemy mints a
   * dedicated service account with no roles (deleted on destroy).
   */
  serviceAccount?: string;
  /**
   * User labels applied to the Cloud Run service. Alchemy ownership labels
   * are merged in automatically.
   */
  tags?: Record<string, string>;
}

/**
 * Props shared by every GCP framework website composite.
 */
export interface FrameworkSiteProps extends WebsiteServiceProps {
  /**
   * Project root directory (the directory containing `package.json`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Process environment for the hosted server (Cloud Run container env
   * vars). Accepts `Output`s (e.g. `VITE_API_URL: api.uri`). `Redacted`
   * values are unwrapped into plain container env vars.
   */
  env?: Record<string, WebsiteEnvValue>;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`). Client
   * files are baked into the container image and served by the Node
   * server.
   */
  assets?: WebsiteAssetsProps;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** Node deploy-target module specifier. */
  target: string;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only routing hints (Vite SPA fallback). Accepted for parity
   * with the other providers; the Node serve entry handles routing.
   */
  static?: { spa?: boolean; errorPage?: string } | undefined;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
  /**
   * Packages installed into the image with `npm install` instead of
   * bundling (Next.js needs `next`).
   */
  install?: string[] | undefined;
  /**
   * Ship `.next`, `public/`, and `next.config.*` from the app root instead
   * of the build's dist directory (Next.js).
   */
  skipClientAssets?: boolean | undefined;
}

export interface FrameworkSite {
  /**
   * Public site URL. Local framework URL under `alchemy dev`; the Cloud
   * Run service URL (`https://{service}-{hash}.{region}.run.app`) on
   * deploy.
   */
  url: string | Output.Output<string | undefined> | undefined;
  /** Hosting Cloud Run service. `undefined` during `alchemy dev`. */
  service: Service | undefined;
}

export class FrameworkSiteError extends Data.TaggedError("FrameworkSiteError")<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Unwrap `Redacted` values into plain container env vars. */
export const websiteEnv = (
  env: Record<string, WebsiteEnvValue> | undefined,
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
 * Cloud Run service props for a website whose image is the unbundled Node
 * program `main` plus `extraFiles`.
 */
export const websiteServiceProps = (
  props: WebsiteServiceProps & {
    env?: Record<string, WebsiteEnvValue>;
  },
  program: {
    main: string;
    extraFiles: ReadonlyArray<ExtraFile>;
    install?: string[] | undefined;
  },
): ServiceProps => ({
  main: program.main,
  // The Node serve entry is a complete program, not an Effect-native one.
  isExternal: true,
  extraFiles: program.extraFiles,
  port: WEBSITE_PORT,
  env: websiteEnv(props.env),
  labels: props.tags,
  ingress: props.ingress,
  invokerIamDisabled: props.public ?? true,
  template: {
    timeout: props.timeout,
    maxInstanceRequestConcurrency: props.maxInstanceRequestConcurrency,
    scaling: props.scaling,
    serviceAccount: props.serviceAccount,
    containers:
      props.resources !== undefined
        ? [{ resources: props.resources }]
        : undefined,
  },
  build:
    program.install !== undefined && program.install.length > 0
      ? { install: program.install }
      : undefined,
});

const runFrameworkSite = Effect.fn("GCP.Website.FrameworkSite")(function* (
  _id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const build = yield* FrameworkServer("Build", {
    framework: config.framework,
    target: config.target,
    root: props.rootDir,
    env: websiteEnv(props.env),
    options: config.options,
    memo: props.memo,
    dev: props.dev,
  });

  if (isLocal) {
    return { url: build.url, service: undefined } satisfies FrameworkSite;
  }

  // The build runs at apply time (`Website.Server` is a resource), so its
  // attributes are Outputs here — derive every deploy input lazily.
  const buildOut = Output.mapEffect(
    ([serverEntry, distDir]: [string | undefined, string | undefined]) =>
      Effect.gen(function* () {
        if (serverEntry === undefined || distDir === undefined) {
          return yield* Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no Node serve entry (serverModules[0]). The Node deploy target should write serve-node.mjs.`,
            }),
          );
        }
        const main = path.resolve(initialCwd, serverEntry);
        if (!(yield* fs.exists(main).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no server entry at ${main}`,
            }),
          );
        }
        return { distDir: path.resolve(initialCwd, distDir), main };
      }),
  )(
    Output.all(
      build.serverEntry as unknown as Output.Output<string | undefined>,
      build.distDir as unknown as Output.Output<string | undefined>,
    ) as unknown as Output.Output<[string | undefined, string | undefined]>,
  );
  const main = Output.map(buildOut, (out) => out.main);

  // Always an array: `extraFiles` selects the unbundled Node image mode.
  const extraFiles = Output.mapEffect(
    (out: { distDir: string; main: string }) =>
      packSiteExtraFiles(
        out.distDir,
        config.skipClientAssets === true ? "next" : "client",
      ).pipe(Effect.map((files) => files ?? [])),
  )(buildOut);

  const service = yield* Service(
    "Service",
    websiteServiceProps(props, {
      main: main as unknown as string,
      extraFiles: extraFiles as unknown as ExtraFile[],
      install: config.install,
    }),
  );

  return {
    url: service.uri,
    service,
  } satisfies FrameworkSite;
});

/**
 * Shared implementation behind the GCP framework website composites:
 * `Website.Server` runs the framework toolchain (dev server / production
 * build), then a live deploy bakes `serve-node.mjs` plus the build output
 * into a Node image in Artifact Registry and runs it on a Cloud Run
 * service.
 *
 * Callers pipe `Namespace.push(id)` themselves (the composites do).
 *
 * Composite-level tagged errors (`FrameworkSiteError`, filesystem) are
 * defects — `Alchemy.Stack` only admits `ConfigError` on the user effect.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);

/** Push {@link id} then run {@link makeFrameworkSite}. */
export const frameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => makeFrameworkSite(id, props, config).pipe(Namespace.push(id));

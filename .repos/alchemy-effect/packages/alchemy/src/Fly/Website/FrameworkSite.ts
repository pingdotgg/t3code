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
import { App } from "../App.ts";
import { Bucket } from "../Bucket.ts";
import { Certificate } from "../Certificate.ts";
import { IpAssignment } from "../IpAssignment.ts";
import type { Providers } from "../Providers.ts";
import { Service } from "../Service.ts";
import { AssetDeployment } from "./AssetDeployment.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/**
 * Props shared by every Fly framework website composite.
 */
export interface FrameworkSiteProps {
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
   * Parent Fly App. Accepts a `Fly.App` or an Effect that produces one.
   * When omitted, a `Fly.App` is created under this site's namespace.
   */
  app?: Ref<App>;
  /**
   * Process environment for the hosted server. Not Cloudflare Worker
   * bindings — values become Machine env vars. Accepts `Output`s
   * (e.g. `VITE_API_URL: api.url`).
   */
  env?: Record<
    string,
    string | Redacted.Redacted<string> | Output.Output<string | undefined>
  >;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`). Hashed
   * client files are uploaded to Tigris regardless of this bag.
   */
  assets?: WebsiteAssetsProps;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
  /**
   * Optional custom hostname. Requests ACME (`Fly.Certificate`) on the
   * App. `url` becomes `https://<domain>` (existing DNS only for v1).
   */
  domain?: string;
  /**
   * User-defined tags. Accepted for API parity; Fly Services do not
   * surface resource tags.
   */
  tags?: Record<string, string>;
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
   * Assets-only routing forwarded to the Node target (Vite SPA fallback).
   * `spa` also publishes client files to Tigris at `/`.
   */
  static?: { spa?: boolean; errorPage?: string } | undefined;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
  /**
   * Packages installed into the Machine image with `npm install` instead
   * of bundling (Next.js needs `next`).
   */
  install?: string[] | undefined;
  /**
   * Skip baking `clientDirectory` at `/app/dist`. Next.js serves `.next`
   * from the image root instead.
   */
  skipClientAssets?: boolean | undefined;
}

export interface FrameworkSite {
  /**
   * Public site URL. Local framework URL under `alchemy dev`;
   * `https://{app}.fly.dev` (or `https://{domain}`) on deploy.
   */
  url: string | Output.Output<string | undefined> | undefined;
  /** Parent Fly App. `undefined` during `alchemy dev`. */
  app: App | undefined;
  /** Hosted Fly Service. `undefined` during `alchemy dev`. */
  service: Service | undefined;
  /** Shared Anycast IPv4 so `{app}.fly.dev` answers. */
  ip: IpAssignment | undefined;
  /** ACME certificate when {@link FrameworkSiteProps.domain} is set. */
  certificate: Certificate | undefined;
}

export class FrameworkSiteError extends Data.TaggedError("FrameworkSiteError")<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const DEFAULT_PORT = 3000;

const resolveRef = <T>(ref: Ref<T>): Effect.Effect<T, never, Providers> =>
  Effect.isEffect(ref) ? ref : Effect.succeed(ref);

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

const runFrameworkSite = Effect.fn("Fly.Website.FrameworkSite")(function* (
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
    env: envRecord(props.env),
    options: config.options,
    memo: props.memo,
    dev: props.dev,
  });

  if (isLocal) {
    return {
      url: build.url,
      app: undefined,
      service: undefined,
      ip: undefined,
      certificate: undefined,
    } satisfies FrameworkSite;
  }

  // The build runs at APPLY time (`Website.Server` is a resource), so its
  // attributes are Outputs here — derive every deploy input lazily and let
  // the engine resolve them once the build has produced real paths. Reading
  // `build.distDir` eagerly in the composite body would observe an Output
  // proxy, not a string.
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

  const extraFiles = Output.mapEffect(
    (out: { distDir: string; main: string }) =>
      packSiteExtraFiles(
        out.distDir,
        config.skipClientAssets === true ? "next" : "client",
      ),
  )(buildOut);

  const app =
    props.app !== undefined ? yield* resolveRef(props.app) : yield* App("App");

  const ip = yield* IpAssignment("Shared", {
    app,
    type: "shared_v4",
  });

  // SPA: hashed `/assets` at Tigris. HTML and unknown paths stay on
  // origin (NodeServe `notFoundHandling: "spa"`). Intercepting `/` with
  // Tigris hangs SPA fallbacks — Fly does not rewrite `/counter/42` to
  // `index.html`.
  let statics:
    | Output.Output<
        | Array<{
            guestPath: string;
            urlPrefix: string;
            tigrisBucket?: string;
            indexDocument?: string;
          }>
        | undefined
      >
    | undefined;
  if (config.static?.spa === true) {
    const clientDir = Output.map(
      build.clientDir as unknown as Output.Output<string | undefined>,
      (dir) => {
        if (dir === undefined) {
          throw new FrameworkSiteError({
            framework: config.framework,
            message: `The ${config.name} build produced no client assets directory`,
          });
        }
        return path.resolve(initialCwd, dir);
      },
    );
    const bucket = yield* Bucket("Assets", { public: true });
    yield* AssetDeployment("Files", {
      bucket,
      sourcePath: clientDir as unknown as string,
      purge: true,
    });
    statics = Output.mapEffect(([clientDir, bucketName]: [string, string]) =>
      Effect.gen(function* () {
        const assetsDir = path.join(clientDir, "assets");
        const exists = yield* fs
          .exists(assetsDir)
          .pipe(Effect.orElseSucceed(() => false));
        return exists
          ? [
              {
                guestPath: "/assets",
                urlPrefix: "/assets",
                tigrisBucket: bucketName,
              },
            ]
          : undefined;
      }),
    )(
      Output.all(
        clientDir,
        bucket.name as unknown as Output.Output<string>,
      ) as unknown as Output.Output<[string, string]>,
    );
  }

  const service = yield* Service("Service", {
    app,
    main: main as unknown as string,
    port: DEFAULT_PORT,
    // Node + nitro SSR needs more than the Machine default 256MB.
    guest: { memoryMb: 512 },
    isExternal: true,
    env: props.env,
    extraFiles: extraFiles as unknown as Array<{
      source: string;
      dest: string;
    }>,
    statics: statics as unknown as
      | Array<{
          guestPath: string;
          urlPrefix: string;
          tigrisBucket?: string;
          indexDocument?: string;
        }>
      | undefined,
    build:
      config.install !== undefined && config.install.length > 0
        ? { install: config.install }
        : undefined,
  });

  const certificate =
    props.domain !== undefined
      ? yield* Certificate("Certificate", {
          app,
          hostname: props.domain,
          kind: "acme",
        })
      : undefined;

  const url = props.domain !== undefined ? `https://${props.domain}` : app.url;

  return { url, app, service, ip, certificate };
});

/**
 * Shared implementation behind the Fly framework website composites:
 * `Website.Server` runs the framework toolchain (dev sidecar / production
 * build), then a live deploy hosts `serve-node.mjs` on a Fly.Service.
 *
 * Callers pipe `Namespace.push(id)` themselves (the composites do).
 *
 * Composite-level tagged errors (`FrameworkSiteError`, filesystem) are
 * defects — `Alchemy.Stack` only admits `ConfigError` on the user
 * effect, same as Cloudflare/AWS Website composites.
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

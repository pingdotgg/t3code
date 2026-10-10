import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
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
import type { Providers } from "../Providers.ts";
import { RecordSet } from "../RecordSet.ts";
import { Server } from "../Server.ts";
import { Service } from "../Service.ts";
import type { Zone } from "../Zone.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Server(...)` and `Server(...)` both type-check).
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

const resolveRef = <T>(ref: Ref<T>): Effect.Effect<T, never, Providers> =>
  Effect.isEffect(ref) ? ref : Effect.succeed(ref);

/** Default listen port. Hetzner `deployUnit` curls `/health` whenever `PORT` is set. */
export const DEFAULT_WEBSITE_PORT = 3000;

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/**
 * Props shared by every Hetzner framework website composite.
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
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
  /**
   * Process environment for the hosted unit (and the local framework
   * dev server). Not Cloudflare Worker bindings. Accepts `Output`s
   * (e.g. `VITE_API_URL: api.url`).
   */
  env?: Record<
    string,
    string | Redacted.Redacted<string> | Output.Output<string | undefined>
  >;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`).
   */
  assets?: WebsiteAssetsProps;
  /**
   * Optional custom domain. Creates an A {@link RecordSet} on
   * {@link zone} pointing at the Server's public IPv4. The site `url`
   * becomes `http://{domain}:{port}` (no TLS on Service).
   */
  domain?: string;
  /**
   * Existing Hetzner DNS Zone `domain` is created in. Required when
   * {@link domain} is set — v1 does not provision a Zone.
   */
  zone?: Ref<Zone>;
  /**
   * Server the site's Service runs on. Accepts a `Hetzner.Server` or an
   * Effect that produces one. When omitted, a `cpx12` / `ubuntu-24.04`
   * Server is created in `fsn1` (public IPv4 is the Server default).
   */
  server?: Ref<Server>;
  /**
   * User-defined labels applied to auto-created Server / RecordSet.
   */
  tags?: Record<string, string>;
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** Node container deploy-target module specifier. */
  target: string;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only mode: no server modules (or every page prerendered). The
   * composite generates a static-file server as `main`.
   */
  static?:
    | {
        spa?: boolean | undefined;
        errorPage?: string | undefined;
        htmlHandling?: "none" | "drop-trailing-slash" | undefined;
      }
    | undefined;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
  /**
   * Skip baking `clientDirectory` at `dist/`. Next.js serves `.next`
   * from the unit root instead.
   */
  skipClientAssets?: boolean | undefined;
  /**
   * Native packages to `npm install` into the unit instead of bundling
   * (Next.js needs `next` / `react` / `react-dom`).
   */
  install?: string[] | undefined;
}

export interface Website {
  /**
   * Local framework URL under `alchemy dev`, or the live Service URL
   * (`http://{ipv4}:{port}` / `http://{domain}:{port}`).
   */
  readonly url: string | Output.Output<string | undefined> | undefined;
  /** Server the unit runs on. `undefined` during `alchemy dev`. */
  readonly server: Server | undefined;
  /** Hosted systemd unit. `undefined` during `alchemy dev`. */
  readonly service: Service | undefined;
}

export class FrameworkSiteError extends Data.TaggedError(
  "Hetzner.Website.FrameworkSiteError",
)<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const unwrapEnv = (
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

export const resolveWebsiteServer = Effect.fn(function* (props: {
  readonly server?: Ref<Server> | undefined;
  readonly tags?: Record<string, string> | undefined;
}) {
  if (props.server !== undefined) {
    return yield* resolveRef(props.server);
  }
  return yield* Server("Server", {
    serverType: "cpx12",
    image: "ubuntu-24.04",
    location: "fsn1",
    labels: props.tags,
  });
});

export const bindWebsiteDomain = Effect.fn(function* (props: {
  readonly domain: string;
  readonly zone: Ref<Zone>;
  readonly server: Server;
  readonly tags?: Record<string, string> | undefined;
}) {
  const zone = yield* resolveRef(props.zone);
  const name = Output.map((apex: string | undefined) => {
    const domain = props.domain;
    if (apex === undefined || domain === apex) return "@";
    const suffix = `.${apex}`;
    if (domain.endsWith(suffix)) return domain.slice(0, -suffix.length);
    throw new Error(
      `Hetzner.Website domain "${domain}" is not inside zone "${apex}"`,
    );
  })(zone.name as never);
  yield* RecordSet("Domain", {
    zone,
    name: name as never,
    type: "A",
    records: [{ value: props.server.ipv4 as never }],
    labels: props.tags,
  });
});

export const websiteUrl = (args: {
  readonly domain?: string | undefined;
  readonly service: Service;
  readonly port: number;
}) =>
  args.domain !== undefined
    ? `http://${args.domain}:${String(args.port)}`
    : args.service.url;

/**
 * Shared implementation behind the Hetzner framework website composites:
 * build through the Node deploy target, then host one Service on a
 * Hetzner Server (auto-created `cpx12` in `fsn1` when `server` is omitted).
 *
 * During `alchemy dev` the site is the framework's own dev server and no
 * cloud resources are declared; `Alchemy.remote()` opts back into the
 * live Service path.
 */
const runFrameworkSite = Effect.fn("Hetzner.Website.FrameworkSite")(function* (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const port = DEFAULT_WEBSITE_PORT;

  if (config.static?.spa && config.static.errorPage) {
    return yield* Effect.die(
      `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
    );
  }
  if (props.domain !== undefined && props.zone === undefined) {
    return yield* Effect.die(
      `Hetzner.Website "${config.name}": "domain" requires "zone" (an existing Hetzner.Zone).`,
    );
  }

  const build = yield* FrameworkServer("Build", {
    framework: config.framework,
    target: config.target,
    root: props.rootDir,
    env: unwrapEnv(props.env),
    options: config.options,
    memo: props.memo,
    dev: props.dev,
  });

  if (isLocal) {
    return {
      url: build.url,
      server: undefined,
      service: undefined,
    };
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

  const server = yield* resolveWebsiteServer(props);
  const env = {
    ...unwrapEnv(props.env),
    PORT: String(port),
  };

  const extraFiles = Output.mapEffect(
    (out: { distDir: string; main: string }) =>
      packSiteExtraFiles(
        out.distDir,
        config.skipClientAssets === true ? "next" : "client",
      ).pipe(
        Effect.map((files) =>
          files?.map((file) => ({
            source: file.source,
            destination: file.dest,
          })),
        ),
      ),
  )(buildOut);

  const service = yield* Service("Service", {
    server,
    main: main as unknown as string,
    extraFiles: extraFiles as unknown as Array<{
      source: string;
      destination: string;
    }>,
    port,
    env,
    isExternal: true,
    build:
      config.install !== undefined && config.install.length > 0
        ? { install: config.install }
        : undefined,
  });

  if (props.domain !== undefined && props.zone !== undefined) {
    yield* bindWebsiteDomain({
      domain: props.domain,
      zone: props.zone,
      server,
      tags: props.tags,
    });
  }

  return {
    url: websiteUrl({ domain: props.domain, service, port }),
    server,
    service,
  };
});

/**
 * Composite-level tagged errors (`FrameworkSiteError`, filesystem) are
 * defects — `Alchemy.Stack` only admits `ConfigError` on the user effect.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);

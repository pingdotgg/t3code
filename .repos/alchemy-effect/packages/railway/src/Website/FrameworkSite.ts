import { AlchemyContext } from "alchemy/AlchemyContext";
import type { PackageInstall } from "alchemy/Bundle/InstalledPackages";
import type { MemoOptions } from "alchemy/Command/Memo";
import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { initialCwd } from "alchemy/Util/Node";
import {
  staticConfigFromAssets,
  type WebsiteAssetsProps,
  type WebsiteNotFoundHandling,
} from "alchemy/Website/assets";
import { packSiteExtraFiles } from "alchemy/Website/packExtraFiles";
import { Server as FrameworkServer, type ServerDevProps } from "alchemy/Website/Server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { CustomDomain } from "../CustomDomain.ts";
import type { ExtraFile } from "../hosted.ts";
import { Project, type Project as ProjectResource } from "../Project.ts";
import type { Environment as EnvironmentResource } from "../ProjectEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { Service, type Service as ServiceResource } from "../Service.ts";
import { Cdn } from "./Cdn.ts";

/** Port the generated Node serve entry and Railway Service listen on. */
export const WEBSITE_PORT = 3000;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/**
 * Custom hostname of a Railway website: the hostname itself, or
 * `{ name, dns }` to also publish its DNS records.
 */
export type WebsiteDomain =
  | string
  | {
      /** Hostname, e.g. `www.example.com`. */
      name: string;
      /**
       * DNS host that publishes the records Railway requires (the routing
       * `CNAME` and the ownership `TXT` listed in the CustomDomain's
       * `dnsRecords`; see
       * [DNS Adapters](/infrastructure-as-code/dns-adapters)), e.g.
       * `Cloudflare.DNS.Adapter()`. Omitted: publish them yourself.
       */
      dns?: DNS.DnsConfig;
    };

/** The hostname of a {@link WebsiteDomain}. */
export const websiteDomainName = (domain: WebsiteDomain | undefined): string | undefined =>
  domain === undefined || typeof domain === "string" ? domain : domain.name;

/**
 * Publish the records Railway requires for a website's custom domain
 * (`DomainRecords`) through `domain.dns`. No-op for a plain hostname or an
 * object without `dns`.
 */
export const publishWebsiteDomainDns = Effect.fn("Railway.Website.publishDomainDns")(
  function* (args: {
    readonly domain: WebsiteDomain | undefined;
    readonly customDomain: CustomDomain;
  }) {
    if (typeof args.domain !== "object" || args.domain.dns === undefined) {
      return;
    }
    const dns = yield* DNS.resolve(args.domain.dns);
    yield* dns.records("DomainRecords", {
      records: Output.map(args.customDomain.dnsRecords, (records) =>
        records.map((record): DNS.DnsRecord => ({
          name: record.name,
          type: record.type,
          value: record.value,
        })),
      ) as unknown as Input<DNS.DnsRecord[]>,
    });
  },
);

/**
 * Props shared by every Railway framework website composite.
 */
export interface FrameworkSiteProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. When omitted, a `Railway.Project("Project")` is
   * created under this site's namespace.
   */
  project?: Ref<ProjectResource>;
  /**
   * Environment to deploy the Service into. Accepts a `Railway.Project`
   * (primary environment), a `Railway.Environment`, or `{ environmentId }`.
   * Defaults to the project's primary environment.
   */
  environment?: Ref<EnvironmentResource | ProjectResource | { readonly environmentId: string }>;
  /**
   * Project root directory (the directory containing `package.json`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * Forwarded to the framework integration when it honors memo options.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Process environment for the deployed Service (and, under
   * `alchemy dev`, the framework dev server). Accepts `Output`s
   * (e.g. `VITE_API_URL: api.url`).
   */
  env?: Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`). Railway
   * CDN caches hashed files by Content-Type regardless of this bag.
   */
  assets?: WebsiteAssetsProps;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
  /**
   * Optional custom hostname attached via `Railway.CustomDomain`. When
   * set, `url` is `https://{domain}` instead of the generated
   * `*.up.railway.app`.
   *
   * A string (or `{ name }`) leaves DNS to you. Set `dns` (e.g.
   * `{ name: "www.example.com", dns: Cloudflare.DNS.Adapter() }`) to
   * publish the records Railway requires through that DNS host. See
   * [DNS Adapters](/infrastructure-as-code/dns-adapters).
   */
  domain?: WebsiteDomain;
  /**
   * User-defined tags. Railway Services do not persist tags; accepted
   * for API parity with AWS/Cloudflare Website composites.
   */
  tags?: Record<string, string>;
}

/**
 * Static-asset serving options mapped from Cloudflare `AssetsConfig`
 * onto the generated Node serve entry.
 */
export interface WebsiteStaticConfig {
  /**
   * Answer misses with `index.html` (200) so client-side routes
   * deep-link. Mutually exclusive with {@link errorPage}.
   */
  spa?: boolean;
  /**
   * Serve this page (e.g. `404.html`) with status 404 when no file
   * matches. Mutually exclusive with {@link spa}.
   */
  errorPage?: string;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
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
   * Assets-only serving: used when the build produced no server modules
   * (Vite, Foldkit, Vocs, Astro `output: "static"`).
   */
  static?: WebsiteStaticConfig | undefined;
  /**
   * Native packages to `npm install` into the image instead of bundling
   * (Next.js needs `next` / `react`).
   */
  install?: PackageInstall | undefined;
  /**
   * How to bake the build into the image.
   * - `"client"` (default): `COPY dist /app/dist` from `clientDirectory`
   * - `"next"`: `COPY .next` + `public` (and `next.config.*`)
   * @default "client"
   */
  bake?: "client" | "next" | undefined;
}

export interface Website {
  /**
   * Public site URL. Under `alchemy dev` this is the framework (or
   * static) dev server (`http://localhost:<port>`). On deploy it is
   * `https://{domain}` (`*.up.railway.app`, or the custom hostname).
   */
  url: string | Output.Output<string | undefined> | undefined;
  /**
   * The Railway Service that serves the site. `undefined` under
   * `alchemy dev` (no cloud resources are declared).
   */
  service: ServiceResource | undefined;
  /**
   * The Railway Project the Service belongs to. `undefined` under
   * `alchemy dev`.
   */
  project: ProjectResource | undefined;
}

export class FrameworkServerError extends Data.TaggedError("Railway.Website.FrameworkServerError")<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const envRecord = (
  env:
    | Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>
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
 * Shared implementation behind the Railway framework website composites:
 * build the framework through its Node deploy target, then deploy one
 * `Railway.Service` whose image bakes the Node serve entry plus
 * `clientDirectory`.
 *
 * During `alchemy dev` the site is the framework's own dev server (native
 * HMR) and no cloud resources are declared; `Alchemy.remote()` opts back
 * into the live Service path.
 *
 * Callers pipe `Namespace.push(id)` themselves (the composites do).
 */
const runFrameworkSite = Effect.fn("Railway.Website.FrameworkSite")(function* (
  _id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = path.resolve(initialCwd, props.rootDir ?? ".");
  const bake = config.bake ?? "client";

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
      service: undefined,
      project: undefined,
    } satisfies Website;
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
            new FrameworkServerError({
              framework: config.framework,
              message: `The ${config.name} build produced no Node serve entry (serverModules[0]). The Node deploy target should write serve-node.mjs.`,
            }),
          );
        }
        const main = path.resolve(initialCwd, serverEntry);
        if (!(yield* fs.exists(main).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* Effect.die(
            new FrameworkServerError({
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

  // `bake === "next"` ships `.next`/`public`/`next.config.*` from the
  // project root; every other bake ships the build's dist directory. BOTH
  // must be derived from `buildOut`: the artifacts only exist once the
  // build has run at apply — probing the root here (pre-build) would miss
  // a fresh project's `.next` entirely.
  const extraFiles = Output.mapEffect((out: { distDir: string; main: string }) =>
    packSiteExtraFiles(bake === "next" ? root : out.distDir, bake),
  )(buildOut);

  const project = Effect.isEffect(props.project)
    ? yield* props.project
    : (props.project ?? (yield* Project("Project")));
  const environment = Effect.isEffect(props.environment)
    ? yield* props.environment
    : (props.environment ?? project);
  const service = yield* Service("Service", {
    project,
    environment,
    main: main as unknown as string,
    port: WEBSITE_PORT,
    healthcheck: "/health",
    isExternal: true,
    env: envRecord(props.env),
    extraFiles: extraFiles as unknown as ExtraFile[] | undefined,
    build: config.install !== undefined ? { install: config.install } : undefined,
  });
  yield* Cdn("Cdn", {
    service,
    environment,
    htmlCaching: "AUTO",
    purgeOnDeploy: "HTML",
  });

  const domainName = websiteDomainName(props.domain);
  if (domainName !== undefined && domainName.length > 0) {
    const customDomain = yield* CustomDomain("Domain", {
      service,
      environment,
      domain: domainName,
      targetPort: WEBSITE_PORT,
    });
    yield* publishWebsiteDomainDns({ domain: props.domain, customDomain });
    return {
      url: `https://${domainName}`,
      service,
      project,
    } satisfies Website;
  }

  return {
    url: service.url,
    service,
    project,
  } satisfies Website;
});

/**
 * Composite-level tagged errors (`FrameworkServerError`, filesystem)
 * are defects — `Alchemy.Stack` only admits `ConfigError` on the user
 * effect.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);

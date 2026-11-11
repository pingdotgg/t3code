import { createHash } from "node:crypto";
import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import type { Input, InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { Server, type ServerDevProps } from "alchemy/Website/Server";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Function as LambdaFunction, type FunctionProps } from "../Lambda/Function.ts";
import { WebFunction } from "../Lambda/WebFunction.ts";
import { WebFunctionEndpoint } from "../Lambda/WebFunctionEndpoint.ts";
import { asRouterDomain, registerDevRouterRoute } from "./DevRouterRoute.ts";
import {
  normalizeWebsiteDomain,
  type WebsiteAssetsConfig,
  type WebsiteDomainProps,
  type WebsiteEdgeProps,
  type WebsiteInvalidationProps,
} from "./shared.ts";
import { makeKvSite, type StaticSiteProps } from "./StaticSite.ts";

/** Props shared by every framework website, whatever runs its server. */
export interface FrameworkSiteBaseProps {
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
   * Environment variables for the SSR server (Lambda environment).
   * Values accept `Output`s (e.g. `API_URL: api.url`).
   */
  env?: Record<string, any>;
  /**
   * Maximum server request duration.
   * @default 30 seconds
   */
  timeout?: Duration.Duration;
  /**
   * Static asset upload configuration.
   */
  assets?: WebsiteAssetsConfig;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
  /**
   * Optional custom domain. A string is shorthand for `{ name }`; `null`
   * explicitly clears a previously set domain. Set `domain.router` to
   * serve the site through an existing `AWS.Website.Router` instead of a
   * standalone CloudFront distribution.
   */
  domain?: string | WebsiteDomainProps | null;
  /**
   * Serve the site at its CloudFront default domain
   * (`https://dxxxx.cloudfront.net`). `false` 301s default-domain requests
   * to `https://<domain.name>` at the edge and excludes the default domain
   * from the `urls` output. Requires `domain`; not applicable when
   * `domain.router` is set.
   * @default true
   */
  cloudfrontUrl?: boolean;
  /**
   * Additional CloudFront Function customizations.
   */
  edge?: WebsiteEdgeProps;
  /**
   * Optional deterministic S3 bucket name for the asset bucket.
   */
  bucketName?: string;
  /**
   * Whether to delete uploaded objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * CloudFront invalidation behavior.
   * @default { paths: "all", wait: false }
   */
  invalidation?: false | WebsiteInvalidationProps;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}

/** The SSR server on a Lambda Web Function (the default). */
export interface WebFunctionServerProps {
  /**
   * What runs the SSR server: a Lambda Web Function, where the
   * framework's Node server handles many requests per environment and
   * streams responses. Set `"function"` for a Lambda Function instead.
   * @default "web-function"
   */
  server?: "web-function";
  /**
   * Requests one Web Function environment serves at once (1–128).
   * @default 64
   */
  maxConcurrencyPerEnvironment?: number;
  /**
   * Maximum Web Function environments per Region (2–10,000).
   */
  maxEnvironments?: number;
  /**
   * Additional AWS Regions to serve the SSR server from. The server's Web
   * Function gets one global domain that routes each request to the
   * nearest Region, and CloudFront forwards to it. Changing it gives the
   * server a new domain; the site's URL stays the same.
   */
  regions?: string[];
}

/**
 * The SSR server on a Lambda Function behind a streaming Function URL: for
 * servers that need more than 2 GB of memory or x86_64, or Regions without
 * Web Functions.
 */
export interface FunctionServerProps {
  /** Run the SSR server on a Lambda Function behind a streaming Function URL. */
  server: "function";
  /**
   * Memory allocated to the server function, in MB.
   * @default 1024
   */
  memorySize?: number;
  /**
   * Server instruction set architecture.
   * @default "x86_64"
   */
  architecture?: "x86_64" | "arm64";
  /**
   * Lambda runtime for the server function.
   * @default "nodejs24.x"
   */
  runtime?: FunctionProps["runtime"];
}

/**
 * Props of every framework website composite (SvelteKit, Nuxt, Waku,
 * Octane, Astro, ...): the shared props, the framework's own (`Framework`,
 * kept FLAT — the composite is the framework, so its keys need no
 * namespace), and the props of the chosen `server`.
 */
export type FrameworkSiteProps<Framework = {}> = FrameworkSiteBaseProps &
  Framework &
  (WebFunctionServerProps | FunctionServerProps);

/** `regions` serves a Web Function from several Regions; a Lambda Function can't. */
export class WebsiteRegionsRequireWebFunction extends Data.TaggedError(
  "WebsiteRegionsRequireWebFunction",
)<{ site: string; message: string }> {}

/** Fail at plan when `regions` is combined with `server: "function"`. */
export const checkWebsiteRegions = (
  site: string,
  props: { server?: "web-function" | "function"; regions?: string[] },
) =>
  props.server === "function" && props.regions !== undefined && props.regions.length > 0
    ? Effect.die(
        new WebsiteRegionsRequireWebFunction({
          site,
          message: `"${site}": regions needs the Web Function server. Remove server: "function", or remove regions.`,
        }),
      )
    : Effect.void;

/**
 * The endpoint CloudFront reaches a Web Function server through. Without
 * `regions` that is the function's own endpoint. With them it is a
 * `WebFunctionEndpoint` whose name follows the Region set: an endpoint's
 * Regions can't change in place, so a new set is a new endpoint, created
 * before CloudFront moves to it and deleted only after.
 */
export const siteEndpoint = Effect.fn(function* (
  id: string,
  server: WebFunction,
  props: { regions?: string[]; maxEnvironments?: number },
) {
  if (props.regions === undefined || props.regions.length === 0) {
    return { domainName: server.domainName, url: server.url };
  }
  const key = yield* Effect.sync(() =>
    createHash("sha256")
      .update([...new Set(props.regions)].sort().join(","))
      .digest("hex")
      .slice(0, 8),
  );
  const endpoint = yield* WebFunctionEndpoint(id, {
    function: server,
    endpointName: `edge-${key}`,
    authType: "ApplicationManaged",
    regions: props.regions,
    maxEnvironments: props.maxEnvironments,
  });
  return { domainName: endpoint.domainName, url: endpoint.url };
});

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** AWS Lambda deploy-target module specifier (`server: "function"`). */
  target: string;
  /**
   * Node deploy-target module specifier (`server: "web-function"`). Its
   * serve entry listens on `AWS_LAMBDA_HTTP_ENDPOINT`. Without one the
   * site always uses a Lambda Function.
   */
  webTarget?: string;
  /**
   * Packages installed into the Web Function instead of bundled (the
   * framework's runtime when its server can't be bundled).
   */
  install?: ReadonlyArray<string>;
  /**
   * Build options for `server: "web-function"`, merged over `options`.
   */
  webOptions?: Record<string, unknown>;
  /**
   * Deploy the Node target's server directory as-is instead of bundling
   * its serve entry, for servers that read files beside themselves at
   * runtime (Octane's SSR `index.html`).
   */
  webPrebuilt?: boolean;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only mode: every page was prerendered at build time, so no
   * server function is created and misses resolve to the error page (or
   * the index page for SPAs). Set by composites whose framework supports
   * a fully static output (Astro's `output: "static"`).
   */
  static?: { spa?: boolean; errorPage?: string } | undefined;
}

/**
 * The shared implementation behind the framework website composites:
 * build the framework through its AWS deploy target, then deploy the
 * server output on a streaming Lambda Function URL with static assets in
 * S3 behind a CloudFront distribution (or attach to a shared Router).
 *
 * During `alchemy dev` the site is the framework's own dev server (native
 * HMR) and no cloud resources are declared; `Alchemy.remote()` opts back
 * into the full live deployment.
 *
 * Callers pipe `Namespace.push(id)` themselves (the composites do), so
 * resource FQNs are identical to the previous per-framework
 * implementations.
 */
export const makeFrameworkSite = Effect.fn("AWS.Website.FrameworkSite")(function* (
  id: string,
  propsIn: InputProps<FrameworkSiteProps, "server">,
  config: FrameworkSiteConfig,
) {
  // Props accept `Input<T>` throughout (matching the Cloudflare
  // composites); values flow into the resources below, which resolve
  // them at reconcile time. The plan-time reads in this function
  // (domain-shape branching, dev wiring, the build's rootDir/memo)
  // need concrete values — passing an `Output` for those specific
  // fields is unsupported, same as on the Cloudflare side.
  const props = propsIn as FrameworkSiteProps;
  yield* checkWebsiteRegions(`AWS.Website.${config.name} "${id}"`, props);
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;

  const routerDomain = asRouterDomain(normalizeWebsiteDomain(props.domain));

  // A Router-attached dev server is an ORIGIN for the emulated CloudFront
  // edge, which runs in a container and reaches the host through its
  // gateway address — it cannot open a connection to the host's loopback.
  // Frameworks bind loopback by default (Vite picks `[::1]`), so the edge
  // would get a refused connection and answer 502. Bind all interfaces
  // unless the caller asked for a specific host. Standalone dev sites, and
  // `mode: "external"` (we start nothing), keep the framework's default.
  const dev: ServerDevProps | undefined =
    isLocal && routerDomain && props.dev?.mode !== "external"
      ? { ...props.dev, host: props.dev?.host ?? "0.0.0.0" }
      : props.dev;

  const onWebFunction =
    config.webTarget !== undefined && (props.server ?? "web-function") === "web-function";
  const build = yield* Server("Build", {
    framework: config.framework,
    target: onWebFunction ? config.webTarget! : config.target,
    root: props.rootDir,
    env: props.env,
    options: onWebFunction ? { ...config.options, ...config.webOptions } : config.options,
    memo: props.memo,
    dev,
  });

  if (isLocal) {
    // Router-attached sites register with the Router in dev exactly as they
    // do live — same resource types and ids — with the framework's dev
    // server standing in for the S3 + Lambda origins.
    const kvNamespace = routerDomain
      ? yield* registerDevRouterRoute(routerDomain, build.url)
      : undefined;
    return {
      bucket: undefined,
      build,
      files: undefined,
      distribution: undefined,
      invalidation: undefined,
      kvNamespace,
      server: undefined,
      serverUrl: undefined,
      url: build.url,
      urls: [build.url],
    };
  }

  const siteProps: StaticSiteProps = {
    path: build.clientDir as unknown as string,
    assets: props.assets,
    domain: props.domain,
    cloudfrontUrl: props.cloudfrontUrl,
    edge: props.edge,
    bucketName: props.bucketName,
    forceDestroy: props.forceDestroy,
    invalidation: props.invalidation,
    tags: props.tags,
  };

  if (config.static) {
    const site = yield* makeKvSite(id, {
      ...siteProps,
      errorPage: config.static.errorPage,
      spa: config.static.spa,
    });
    return {
      ...site,
      build,
      server: undefined,
      serverUrl: undefined,
    };
  }

  if (onWebFunction) {
    // The Node deploy target writes a complete server program
    // (`serve-node.mjs`) that listens where Lambda says; bundle it like any
    // async Web Function. Assets stay in S3 behind the edge router.
    const server = yield* WebFunction("WebServer", {
      main: build.serverEntry as unknown as string,
      ...(config.webPrebuilt ? { bundle: false as const } : {}),
      authType: "ApplicationManaged",
      env: props.env,
      timeout: props.timeout ?? Duration.seconds(30),
      ...(props.server === "function"
        ? {}
        : {
            maxConcurrencyPerEnvironment: props.maxConcurrencyPerEnvironment,
            maxEnvironments: props.maxEnvironments,
          }),
      build:
        config.install !== undefined && config.install.length > 0
          ? { install: [...config.install] }
          : undefined,
    });
    const endpoint = yield* siteEndpoint(
      "ServerEndpoint",
      server,
      props.server === "function" ? {} : props,
    );
    const site = yield* makeKvSite(id, siteProps, { serverHost: endpoint.domainName });
    return {
      ...site,
      build,
      server,
      serverUrl: endpoint.url,
    };
  }

  const server = yield* LambdaFunction("Server", {
    main: build.serverEntry as unknown as string,
    handler: "handler",
    isExternal: true,
    // The AWS deploy target's finishing pass writes the server directory
    // as a complete Node deployment unit (entry + chunks) — ship it
    // as-is.
    bundle: false,
    runtime: (props.server === "function" ? props.runtime : undefined) ?? "nodejs24.x",
    architecture: props.server === "function" ? props.architecture : undefined,
    memorySize: (props.server === "function" ? props.memorySize : undefined) ?? 1024,
    timeout: props.timeout ?? Duration.seconds(30),
    env: props.env,
    functionUrl: {
      authType: "NONE",
      invokeMode: "RESPONSE_STREAM",
    },
  });

  const serverHost = Output.map((url: string | undefined) => {
    if (!url) {
      throw new Error(`The ${config.name} server function did not produce a Function URL.`);
    }
    return new URL(url).hostname;
  })(server.functionUrl as any) as Input<string>;

  const site = yield* makeKvSite(id, siteProps, { serverHost });

  return {
    ...site,
    build,
    server,
    serverUrl: server.functionUrl,
  };
});

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { Input, InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import {
  Function as LambdaFunction,
  type FunctionProps,
} from "../Lambda/Function.ts";
import { asRouterDomain, registerDevRouterRoute } from "./DevRouterRoute.ts";
import { Server, type ServerDevProps } from "../../Website/Server.ts";
import { makeKvSite, type StaticSiteProps } from "./StaticSite.ts";
import {
  normalizeWebsiteDomain,
  type WebsiteAssetsConfig,
  type WebsiteDomainProps,
  type WebsiteEdgeProps,
  type WebsiteInvalidationProps,
} from "./shared.ts";

/**
 * Props shared by every framework website composite (SvelteKit, Nuxt,
 * Waku, Octane, Astro). Each composite extends this with its
 * framework-specific configuration, kept FLAT — the composite is the
 * framework, so framework keys need no namespace.
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
   * Environment variables for the SSR server (Lambda environment).
   * Values accept `Output`s (e.g. `API_URL: api.url`).
   */
  env?: Record<string, any>;
  /**
   * Memory allocated to the server function, in MB.
   * @default 1024
   */
  memorySize?: number;
  /**
   * Maximum server request duration.
   * @default 30 seconds
   */
  timeout?: Duration.Duration;
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

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** AWS deploy-target module specifier. */
  target: string;
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
export const makeFrameworkSite = Effect.fn("AWS.Website.FrameworkSite")(
  function* (
    id: string,
    propsIn: InputProps<FrameworkSiteProps>,
    config: FrameworkSiteConfig,
  ) {
    // Props accept `Input<T>` throughout (matching the Cloudflare
    // composites); values flow into the resources below, which resolve
    // them at reconcile time. The plan-time reads in this function
    // (domain-shape branching, dev wiring, the build's rootDir/memo)
    // need concrete values — passing an `Output` for those specific
    // fields is unsupported, same as on the Cloudflare side.
    const props = propsIn as FrameworkSiteProps;
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

    const build = yield* Server("Build", {
      framework: config.framework,
      target: config.target,
      root: props.rootDir,
      env: props.env,
      options: config.options,
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

    const server = yield* LambdaFunction("Server", {
      main: build.serverEntry as unknown as string,
      handler: "handler",
      isExternal: true,
      // The AWS deploy target's finishing pass writes the server directory
      // as a complete Node deployment unit (entry + chunks) — ship it
      // as-is.
      bundle: false,
      runtime: props.runtime ?? "nodejs24.x",
      architecture: props.architecture,
      memorySize: props.memorySize ?? 1024,
      timeout: props.timeout ?? Duration.seconds(30),
      env: props.env,
      functionUrl: {
        authType: "NONE",
        invokeMode: "RESPONSE_STREAM",
      },
    });

    const serverHost = Output.map((url: string | undefined) => {
      if (!url) {
        throw new Error(
          `The ${config.name} server function did not produce a Function URL.`,
        );
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
  },
);

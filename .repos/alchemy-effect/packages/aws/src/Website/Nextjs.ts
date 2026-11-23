import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import type { InputProps } from "alchemy/Input";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { Server, type ServerDevProps } from "alchemy/Website/Server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Table } from "../DynamoDB/Table.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { EventSourceMapping } from "../Lambda/EventSourceMapping.ts";
import { Function as LambdaFunction } from "../Lambda/Function.ts";
import { WebFunction } from "../Lambda/WebFunction.ts";
import { Bucket } from "../S3/Bucket.ts";
import { Queue } from "../SQS/Queue.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import { asRouterDomain, registerDevRouterRoute } from "./DevRouterRoute.ts";
import {
  checkWebsiteRegions,
  siteEndpoint,
  type FunctionServerProps,
  type WebFunctionServerProps,
} from "./FrameworkSite.ts";
import {
  normalizeWebsiteDomain,
  type WebsiteAssetsConfig,
  type WebsiteDomainProps,
  type WebsiteEdgeProps,
  type WebsiteInvalidationProps,
} from "./shared.ts";
import { makeKvSite, type StaticSiteProps } from "./StaticSite.ts";

/**
 * The framework-integration module that drives the `@opennextjs/aws` build
 * (it is its own deploy target — the module IS the AWS pipeline).
 */
export const NEXTJS_AWS_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/nextjs/aws";

/** The S3 key prefix of the Next.js cache (both server forms). */
export const NEXTJS_CACHE_PREFIX = "_cache";

/** Props shared by both server forms of {@link Nextjs}. */
export interface NextjsBaseProps {
  /**
   * Project root directory (the directory containing `next.config.ts`).
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
   * Maximum server request duration.
   * @default 30 seconds
   */
  timeout?: Duration.Duration;
  /**
   * Environment variables for the SSR server (Lambda environment).
   * Values accept `Output`s (e.g. `API_URL: api.url`).
   */
  env?: Record<string, any>;
  /**
   * Static asset upload configuration.
   */
  assets?: WebsiteAssetsConfig;
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

/**
 * The server and the image optimizer on Lambda Functions behind Function
 * URLs: for servers that need more than 2 GB of memory or x86_64, or
 * Regions without Web Functions.
 */
export interface NextjsFunctionServerProps extends FunctionServerProps {
  /**
   * Image optimization (Lambda) configuration.
   */
  imageOptimization?: {
    /**
     * Memory allocated to the image optimization function, in MB.
     * @default 1536
     */
    memorySize?: number;
  };
}

/**
 * Props for {@link Nextjs}. By default Next runs as its standalone server on
 * a Lambda Web Function; set `server: "function"` for the OpenNext topology
 * on Lambda Functions.
 */
export type NextjsProps = NextjsBaseProps & (WebFunctionServerProps | NextjsFunctionServerProps);

/**
 * Deploy a Next.js application to AWS: Next's own standalone server on a
 * Lambda Web Function, static assets in S3 behind CloudFront's KV-manifest
 * edge router, and an S3 bucket for the cache. The server runs the way it
 * does under `next start` (SSR, middleware, ISR revalidation and
 * `/_next/image` in-process), and an S3 `cacheHandler` shares ISR pages,
 * the fetch cache and optimized images across environments.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/nextjs/aws`,
 * which must be installed in your project. It runs `next build` with
 * standalone output; your `next.config.*` is used as-is.
 *
 * With `server: "function"` the site uses the OpenNext (`@opennextjs/aws`)
 * topology instead: the server and an image optimizer on Lambda Functions
 * behind streaming Function URLs, and ISR revalidation through an SQS FIFO
 * queue, a consumer Lambda, and a DynamoDB tag table. Install
 * `@opennextjs/aws` for it; when the project has no `open-next.config.ts`,
 * a minimal streaming default is generated.
 *
 * During `alchemy dev` the site is Next's own dev server (`next dev`) and
 * no cloud resources are declared; `Alchemy.remote()` opts back into the
 * full live deployment.
 *
 * ### Creating Next.js Sites
 * **Example:** Basic Next.js App
 * ```typescript
 * const site = yield* AWS.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Tune The Server Function
 * ```typescript
 * const site = yield* AWS.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
 *   },
 * });
 * ```
 *
 * @resource
 */

export const Nextjs = Effect.fn("AWS.Website.Nextjs")(
  function* (id: string, propsIn: InputProps<NextjsProps, "server"> = {}) {
    const props = propsIn as NextjsProps;
    yield* checkWebsiteRegions(`AWS.Website.Nextjs "${id}"`, props);
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    // Mirrors the other Website composites: during `alchemy dev` the site
    // is `next dev` (native HMR) and no cloud resources are declared;
    // `Alchemy.remote()` opts back into the full live deployment.
    const isLocal = ctx.dev && remoted !== true;
    const onWebFunction = (props.server ?? "web-function") === "web-function";

    const build = yield* Server("Build", {
      framework: NEXTJS_AWS_FRAMEWORK_SPECIFIER,
      target: NEXTJS_AWS_FRAMEWORK_SPECIFIER,
      options: { server: onWebFunction ? "web-function" : "function" },
      root: props.rootDir,
      env: props.env,
      memo: props.memo,
      dev: props.dev,
    });

    if (isLocal) {
      // Router-attached sites register with the Router in dev exactly as they
      // do live — same resource types and ids — with `next dev` standing in
      // for the S3 + Lambda origins.
      const routerDomain = asRouterDomain(normalizeWebsiteDomain(props.domain));
      const kvNamespace = routerDomain
        ? yield* registerDevRouterRoute(routerDomain, build.url)
        : undefined;
      return {
        bucket: undefined,
        build,
        cacheBucket: undefined,
        cacheFiles: undefined,
        distribution: undefined,
        files: undefined,
        imageFunction: undefined,
        imageUrl: undefined,
        invalidation: undefined,
        kvNamespace,
        revalidationFunction: undefined,
        revalidationQueue: undefined,
        server: undefined,
        serverUrl: undefined,
        tagCacheTable: undefined,
        url: build.url,
        urls: [build.url],
      };
    }

    // `.open-next/<relative>` derived from the build's dist directory.
    const fromDist = (relative: string) =>
      Output.map((dir: string | undefined) => {
        if (!dir) {
          throw new Error("The Next.js build produced no .open-next directory.");
        }
        return `${dir}/${relative}`;
      })(build.distDir as any) as Input<string>;

    // The CDN-facing asset bucket (site assets + public files + originals
    // for the image optimizer).
    const bucket =
      props.assets?.bucket ??
      (yield* Bucket("Bucket", {
        bucketName: props.bucketName,
        forceDestroy: props.forceDestroy,
        tags: props.tags,
      }));

    // The ISR/fetch cache lives in its OWN bucket, deliberately separate
    // from the site bucket: the site bucket carries the CloudFront read
    // policy (bound to the distribution's ARN), so a server -> site-bucket
    // reference would close a dependency cycle
    // (server -> bucket -> distribution -> server) and force the CloudFront
    // origin to rendezvous on the Lambda's precreate stub, which has no
    // Function URL yet. A dedicated cache bucket keeps the graph acyclic.
    const cacheBucket = yield* Bucket("CacheBucket", {
      forceDestroy: props.forceDestroy,
      tags: props.tags,
    });

    // The cache handler's S3 access, on whichever server runs.
    const cachePolicy = [
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject"],
        Resource: [Output.interpolate`${cacheBucket.bucketArn}/*` as any],
      },
      {
        // A missing key answers 404 (not 403) only with ListBucket.
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [cacheBucket.bucketArn as any],
      },
    ] satisfies PolicyStatement[];

    if (props.server !== "function") {
      // Next's standalone server: SSR, middleware, ISR revalidation and
      // `/_next/image` run in-process; the S3 cache handler shares the
      // cache across environments.
      const server = yield* WebFunction("WebServer", {
        main: build.serverEntry as unknown as string,
        bundle: false,
        authType: "ApplicationManaged",
        timeout: props.timeout ?? Duration.seconds(30),
        maxConcurrencyPerEnvironment: props.maxConcurrencyPerEnvironment,
        maxEnvironments: props.maxEnvironments,
        env: {
          CACHE_BUCKET_NAME: cacheBucket.bucketName,
          CACHE_BUCKET_KEY_PREFIX: NEXTJS_CACHE_PREFIX,
          ...props.env,
        },
      });
      yield* server.bind`Allow(${server}, AWS.Website.Nextjs.Cache(${cacheBucket}))`({
        policyStatements: cachePolicy,
      });
      const endpoint = yield* siteEndpoint("ServerEndpoint", server, props);
      const site = yield* makeKvSite(
        id,
        {
          path: build.clientDir as unknown as string,
          assets: props.assets,
          domain: props.domain,
          cloudfrontUrl: props.cloudfrontUrl,
          edge: props.edge,
          bucketName: props.bucketName,
          forceDestroy: props.forceDestroy,
          invalidation: props.invalidation,
          tags: props.tags,
        },
        { serverHost: endpoint.domainName },
      );
      return {
        ...site,
        build,
        cacheBucket,
        cacheFiles: undefined,
        imageFunction: undefined,
        imageUrl: undefined,
        revalidationFunction: undefined,
        revalidationQueue: undefined,
        server,
        serverUrl: endpoint.url,
        tagCacheTable: undefined,
      };
    }
    const fnProps = props;

    // ISR revalidation queue: OpenNext's `sqs` queue override sends
    // explicitly-deduplicated messages to a FIFO queue.
    const revalidationQueue = yield* Queue("RevalidationQueue", {
      fifo: true,
      // Lambda requires the queue's visibility timeout to cover the
      // consumer function's timeout (30s) with headroom.
      visibilityTimeout: "2 minutes",
      tags: props.tags,
    });

    // Tag cache (`revalidateTag` / `revalidatePath`): the schema OpenNext's
    // `dynamodb` tag-cache override queries — `tag`/`path` primary key plus
    // the `revalidate` GSI on `path`/`revalidatedAt`.
    const tagCacheTable = yield* Table("TagCache", {
      partitionKey: "tag",
      sortKey: "path",
      attributes: { tag: "S", path: "S", revalidatedAt: "N" },
      globalSecondaryIndexes: [
        {
          indexName: "revalidate",
          partitionKey: "path",
          sortKey: "revalidatedAt",
          projection: { ProjectionType: "ALL" },
        },
      ],
      billingMode: "PAY_PER_REQUEST",
      tags: props.tags,
    });

    const server = yield* LambdaFunction("Server", {
      // The framework module derives the entry from open-next.output.json
      // (origins.default.bundle + handler), so this tracks the manifest.
      main: build.serverEntry as unknown as string,
      handler: "handler",
      isExternal: true,
      // OpenNext's server-functions/default is a complete deployment unit
      // (entry + traced .next output + its own node_modules) — ship as-is.
      bundle: false,
      runtime: fnProps?.runtime ?? "nodejs24.x",
      architecture: fnProps?.architecture,
      memorySize: fnProps?.memorySize ?? 1024,
      timeout: props.timeout ?? Duration.seconds(30),
      env: {
        // The env names OpenNext's s3/sqs/dynamodb overrides read. Regions
        // are omitted: the SDK falls back to the Lambda runtime's own
        // AWS_REGION, and every resource here is same-region.
        CACHE_BUCKET_NAME: cacheBucket.bucketName,
        CACHE_BUCKET_KEY_PREFIX: NEXTJS_CACHE_PREFIX,
        REVALIDATION_QUEUE_URL: revalidationQueue.queueUrl,
        CACHE_DYNAMO_TABLE: tagCacheTable.tableName,
        ...props.env,
      },
      functionUrl: {
        authType: "NONE",
        // The default server is built with the aws-lambda-streaming
        // wrapper (the framework module enforces it).
        invokeMode: "RESPONSE_STREAM",
      },
    });

    yield* server.bind`Allow(${server}, AWS.Website.Nextjs.Cache(${cacheBucket}))`({
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: [Output.interpolate`${cacheBucket.bucketArn}/*` as any],
        },
        {
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [cacheBucket.bucketArn as any],
        },
        {
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: [revalidationQueue.queueArn as any],
        },
        {
          Effect: "Allow",
          Action: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:BatchGetItem",
            "dynamodb:BatchWriteItem",
            "dynamodb:UpdateItem",
          ],
          Resource: [
            tagCacheTable.tableArn as any,
            Output.interpolate`${tagCacheTable.tableArn}/index/*` as any,
          ],
        },
      ] satisfies PolicyStatement[],
    });

    // ISR revalidation consumer: drains the FIFO queue and HEAD-requests
    // stale pages with the prerender revalidate header.
    const revalidationFunction = yield* LambdaFunction("Revalidation", {
      main: fromDist("revalidation-function/index.mjs"),
      handler: "handler",
      isExternal: true,
      bundle: false,
      runtime: "nodejs24.x",
      memorySize: 512,
      timeout: Duration.seconds(30),
      functionUrl: false,
    });

    yield* revalidationFunction.bind`Allow(${revalidationFunction}, AWS.SQS.Consume(${revalidationQueue}))`(
      {
        policyStatements: [
          {
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
              "sqs:GetQueueUrl",
              "sqs:ChangeMessageVisibility",
            ],
            Resource: [revalidationQueue.queueArn as any],
          },
        ] satisfies PolicyStatement[],
      },
    );

    yield* EventSourceMapping("RevalidationEventSource", {
      functionName: revalidationFunction.functionName,
      eventSourceArn: revalidationQueue.queueArn,
      batchSize: 5,
    });

    // Image optimization: OpenNext installs sharp's linux-arm64 binaries
    // into the bundle, so the function architecture is always arm64. Its
    // s3 image loader reads originals from the asset bucket.
    const imageFunction = yield* LambdaFunction("ImageOptimization", {
      main: fromDist("image-optimization-function/index.mjs"),
      handler: "handler",
      isExternal: true,
      bundle: false,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: fnProps?.imageOptimization?.memorySize ?? 1536,
      timeout: Duration.seconds(25),
      env: {
        BUCKET_NAME: bucket.bucketName,
      },
      functionUrl: {
        authType: "NONE",
        // The image optimizer is buffered (streaming: false in the
        // OpenNext output manifest).
        invokeMode: "BUFFERED",
      },
    });

    yield* imageFunction.bind`Allow(${imageFunction}, AWS.S3.GetObject(${bucket}))`({
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
        },
      ] satisfies PolicyStatement[],
    });

    const urlHost = (url: string | undefined) => {
      if (!url) {
        throw new Error("A Next.js Lambda function did not produce a Function URL.");
      }
      return new URL(url).hostname;
    };
    const serverHost = Output.map(urlHost)(server.functionUrl as any) as Input<string>;
    const imageHost = Output.map(urlHost)(imageFunction.functionUrl as any) as Input<string>;

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

    const site = yield* makeKvSite(id, siteProps, {
      serverHost,
      image: { route: "/_next/image", host: imageHost },
    });

    // Seed the ISR/fetch cache: `.open-next/cache/<buildId>/...` uploaded
    // under `_cache/` (matching CACHE_BUCKET_KEY_PREFIX). Old builds' seeds
    // are left in place so a rolling deploy never breaks in-flight ISR.
    const cacheFiles = yield* AssetDeployment("CacheFiles", {
      bucket: cacheBucket,
      sourcePath: fromDist("cache") as unknown as string,
      prefix: NEXTJS_CACHE_PREFIX,
      purge: false,
    });

    return {
      ...site,
      build,
      cacheBucket,
      cacheFiles,
      imageFunction,
      imageUrl: imageFunction.functionUrl,
      revalidationFunction,
      revalidationQueue,
      server,
      serverUrl: server.functionUrl,
      tagCacheTable,
    };
  },
  (effect, id: string, _props?: NextjsProps) => effect.pipe(Namespace.push(id)),
);

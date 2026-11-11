import { AlchemyContext } from "alchemy/AlchemyContext";
import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { Bucket } from "../S3/Bucket.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The vinext-on-AWS framework module (it is its own deploy target — not
 * OpenNext, not the Cloudflare Worker source).
 */
export const VINEXT_AWS_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vinext/aws";

/** The AWS Lambda deploy target for the vinext build. */
export const VINEXT_AWS_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/vinext/aws";

/** Env var the S3 data-cache adapter reads for the ISR/fetch cache bucket. */
export const VINEXT_CACHE_BUCKET_ENV = "CACHE_BUCKET_NAME";

export type VinextProps = FrameworkSiteProps;

/**
 * Deploy a [vinext](https://vinext.dev) App Router application to AWS: the RSC
 * server on a Lambda Web Function, static assets in S3, and a CloudFront
 * distribution whose edge router serves uploaded files from S3 and
 * forwards everything else to the server. Set `server: "function"` to run
 * it on a streaming Lambda Function URL instead, for Regions without Web
 * Functions.
 *
 * ISR / `"use cache"` persistence is an S3 bucket (not Cloudflare KV).
 * This resource provisions the bucket, sets `CACHE_BUCKET_NAME`, and
 * grants the server Get/Put/Delete/List. Alchemy injects the S3 data-cache
 * adapter during the build; no Alchemy plugin is needed in `vite.config.ts`.
 * A dedicated cache bucket keeps the graph acyclic (the asset bucket
 * is bound to CloudFront).
 *
 * Requires vinext 1.0.0-beta.10 or newer. The Lambda build uses vinext's
 * standalone packaging to include external runtime dependencies. Pages Router
 * applications require a Node deployment target instead of Lambda.
 *
 * This is **not** `AWS.Website.Nextjs` (OpenNext) and **not**
 * `Cloudflare.Website.Vinext`. During `alchemy dev` the site is
 * `vinext dev` and no cloud resources are declared.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* AWS.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** vite.config.ts (platform-agnostic)
 * ```typescript
 * import { defineConfig } from "vite";
 * import vinext from "vinext";
 *
 * export default defineConfig({
 *   plugins: [vinext({ prerender: true })],
 * });
 * ```
 *
 * @resource
 * @product Website
 * @category Frontend
 */
export const Vinext = (id: string, propsIn: InputProps<VinextProps, "server"> = {}) =>
  Effect.gen(function* () {
    const props = propsIn as VinextProps;
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;

    if (isLocal) {
      return {
        ...(yield* makeFrameworkSite(id, props, {
          name: "Vinext",
          framework: VINEXT_AWS_FRAMEWORK_SPECIFIER,
          target: VINEXT_AWS_TARGET_SPECIFIER,
        })),
        cacheBucket: undefined,
      };
    }

    const cacheBucket = yield* Bucket("CacheBucket", {
      forceDestroy: props.forceDestroy,
      tags: props.tags,
    });
    const site = yield* makeFrameworkSite(
      id,
      {
        ...props,
        env: {
          [VINEXT_CACHE_BUCKET_ENV]: cacheBucket.bucketName,
          ...props.env,
        },
      },
      {
        name: "Vinext",
        framework: VINEXT_AWS_FRAMEWORK_SPECIFIER,
        target: VINEXT_AWS_TARGET_SPECIFIER,
        // The same self-contained `dist/server` (S3 data cache included),
        // served by a Node HTTP server instead of a Lambda handler.
        webTarget: VINEXT_AWS_TARGET_SPECIFIER,
        webOptions: { server: "web-function" },
        webPrebuilt: true,
      },
    );
    if (site.server !== undefined) {
      yield* site.server.bind`Allow(${site.server}, AWS.Website.Vinext.Cache(${cacheBucket}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: [Output.interpolate`${cacheBucket.bucketArn}/*` as never],
          },
          {
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: [cacheBucket.bucketArn as never],
          },
        ] satisfies PolicyStatement[],
      });
    }
    return { ...site, cacheBucket };
  }).pipe(Namespace.push(id));

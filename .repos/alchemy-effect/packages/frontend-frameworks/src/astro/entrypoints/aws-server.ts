/**
 * `@alchemy.run/frontend-frameworks/astro/entrypoints/aws-server` — the AWS
 * Lambda server entrypoint the AWS deploy target pins as the adapter's
 * `serverEntrypoint`.
 *
 * Compiled by astro's `ssr` environment build (the `astro/app/entrypoint`
 * virtual modules only resolve there), it builds the production `App` from
 * the serialized manifest and exports the Lambda `handler`:
 *
 * - **streaming** (`awslambda.streamifyResponse`, requires a Function URL
 *   with `invokeMode: RESPONSE_STREAM`) when the `awslambda` global exists —
 *   i.e. on the AWS Lambda Node.js runtime — and streaming is enabled
 *   (the deploy target's default);
 * - **buffered** (a complete payload-v2 response object) otherwise, so the
 *   module stays importable outside the Lambda sandbox (local invocation
 *   harnesses, `streaming: false` deployments behind buffered Function URLs
 *   or API Gateway).
 */
import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
import {
  toBufferedLambdaHandler,
  toLambdaHandler,
  type FetchHandler,
} from "../../aws-lambda/index.ts";

/**
 * Replaced by the AWS deploy target's vite `define` at build time
 * (see `astro/aws.ts`). Falls back to `true` when left unreplaced.
 */
declare const __ALCHEMY_ASTRO_AWS_STREAMING__: boolean | undefined;

// astro:env `getSecret` reads process.env on the Lambda Node.js runtime.
setGetEnv((key) => process.env[key]);

const app = createApp();

const fetchHandler: FetchHandler = (request) =>
  app.render(request, {
    addCookieHeader: true,
    // The Function URL (and CloudFront in front of it) prepend the viewer
    // ip to `x-forwarded-for`; surface it as `Astro.clientAddress`.
    clientAddress:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      undefined,
  });

const streaming =
  typeof __ALCHEMY_ASTRO_AWS_STREAMING__ === "boolean"
    ? __ALCHEMY_ASTRO_AWS_STREAMING__
    : true;

export const handler =
  streaming && (globalThis as { awslambda?: unknown }).awslambda !== undefined
    ? toLambdaHandler(fetchHandler)
    : toBufferedLambdaHandler(fetchHandler);

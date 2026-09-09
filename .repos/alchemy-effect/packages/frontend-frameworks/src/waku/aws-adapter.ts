/**
 * AWS Lambda adapter for waku, forked from waku's own aws-lambda adapter
 * (upstream `packages/waku/src/adapters/aws-lambda.ts` @ waku 1.0.0-beta.7).
 *
 * Functional changes from upstream:
 *
 * - The Lambda handler wrapper is this package's own streaming adapter
 *   (`../aws-lambda/index.ts` — `awslambda.streamifyResponse` +
 *   `HttpResponseStream` for a Function URL with `invokeMode:
 *   RESPONSE_STREAM`; `toBufferedLambdaHandler` when `streaming: false`)
 *   instead of `hono/aws-lambda`'s `streamHandle`/`handle`. The wrapper is
 *   published on `globalThis.__ALCHEMY_WAKU_AWS_LAMBDA_HANDLE__` at
 *   server-entry module scope, mirroring upstream's
 *   `__WAKU_AWS_LAMBDA_HANDLE__` global trick — the serve entry that reads
 *   it stays free of bare imports, so the shipped `dist/server` directory
 *   needs no `node_modules`.
 * - `buildEnhancers` is empty: upstream's enhancer writes the
 *   `serve-aws-lambda.js` entry via a `waku/adapters/*` module resolved from
 *   the project, which is not guaranteed to exist for the pinned waku
 *   version's export map. The AWS deploy target's finishing pass
 *   (`./aws.ts`) writes the equivalent serve entry instead.
 *
 * Everything else (Hono app, rsc middleware, SSG static serving during
 * build) is behavior-identical to upstream.
 *
 * This module is bundled into the Lambda server bundle by waku's vite
 * pipeline (selected via the in-memory `Config.unstable_adapter`); it is not
 * Node service code.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono/tiny";
import * as NodePath from "node:path";
import { unstable_createServerEntryAdapter as createServerEntryAdapter } from "waku/adapter-builders";
import {
  unstable_constants as constants,
  unstable_honoMiddleware as honoMiddleware,
} from "waku/internals";
import {
  toBufferedLambdaHandler,
  toLambdaHandler,
  type FetchHandler,
} from "../aws-lambda/index.ts";

const { DIST_PUBLIC } = constants;
const { rscMiddleware, middlewareRunner } = honoMiddleware;

import { AWS_LAMBDA_HANDLE_GLOBAL } from "./aws-shared.ts";

export { AWS_LAMBDA_HANDLE_GLOBAL } from "./aws-shared.ts";

const DEFAULT_BODY_LIMIT_MAX_SIZE = 100 * 1024 * 1024;

const DO_NOT_BUNDLE = "";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/**
 * Minimal static-file middleware over `node:fs`, replacing upstream's
 * `@hono/node-server/serve-static` (a waku dependency this package cannot
 * rely on resolving from the built server bundle). Only ever active during
 * the SSG pass (`isBuild`), which runs in Node — the dynamic `node:fs`
 * import keeps the module loadable on any runtime.
 */
const makeBuildStaticMiddleware = (root: string): MiddlewareHandler => {
  return async (c: Context, next: Next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return next();
    }
    const fs = (await import(
      /* @vite-ignore */ DO_NOT_BUNDLE + "node:fs/promises"
    )) as typeof import("node:fs/promises");
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return next();
    }
    if (pathname.includes("..")) {
      return next();
    }
    if (pathname.endsWith("/")) {
      pathname += "index.html";
    }
    const filePath = NodePath.join(root, pathname);
    let data: Uint8Array;
    try {
      data = await fs.readFile(filePath);
    } catch {
      return next();
    }
    const contentType =
      MIME_TYPES[NodePath.extname(filePath).toLowerCase()] ??
      "application/octet-stream";
    return c.body(data as never, 200, { "content-type": contentType });
  };
};

/** Options accepted by the adapter (superset of upstream's). */
export interface AwsLambdaAdapterOptions {
  /**
   * Whether the emitted Lambda handler streams its response
   * (`awslambda.streamifyResponse`, requires a Function URL with
   * `invokeMode: RESPONSE_STREAM`). `false` produces the buffered
   * payload-v2 handler.
   * @default true
   */
  streaming?: boolean;
  bodyLimit?: Parameters<typeof bodyLimit>[0] | false;
  middlewareFns?: Array<(opts: { app: Hono }) => MiddlewareHandler>;
  middlewareModules?: Record<string, () => Promise<unknown>>;
}

/**
 * Annotated via an instantiation expression over the public
 * `createServerEntryAdapter` so the emitted declaration never references
 * waku's non-exported `lib/types` module (TS2883).
 */
const awsLambdaAdapter: ReturnType<
  typeof createServerEntryAdapter<AwsLambdaAdapterOptions | undefined>
> = createServerEntryAdapter(
  (
    { processRequest, processBuild, config, isBuild, notFoundHtml },
    options?: AwsLambdaAdapterOptions,
  ) => {
    const {
      bodyLimit: bodyLimitOptions,
      middlewareFns = [],
      middlewareModules = {},
    } = options || {};
    const app = new Hono();
    app.notFound((c) => {
      if (notFoundHtml) {
        return c.html(notFoundHtml, 404);
      }
      return c.text("404 Not Found", 404);
    });
    if (isBuild) {
      // SSG pass only (runs in Node during `waku build`): serve the already
      // emitted static files so prerender requests resolve assets. Never on
      // Lambda — there the CDN serves `dist/public`.
      app.use(
        makeBuildStaticMiddleware(NodePath.join(config.distDir, DIST_PUBLIC)),
      );
    }
    if (bodyLimitOptions !== false) {
      app.use(
        bodyLimit(bodyLimitOptions ?? { maxSize: DEFAULT_BODY_LIMIT_MAX_SIZE }),
      );
    }
    for (const middlewareFn of middlewareFns) {
      app.use(middlewareFn({ app }));
    }
    app.use(middlewareRunner(middlewareModules as never, { app }));
    app.use(rscMiddleware({ processRequest }));

    // The serve entry (written by the AWS target's finishing pass) passes its
    // own `{ streaming }` choice — the target config's knob — with the
    // adapter option as fallback.
    (globalThis as Record<string, unknown>)[AWS_LAMBDA_HANDLE_GLOBAL] = (
      fetchHandler: FetchHandler,
      serveOptions?: { streaming?: boolean },
    ) =>
      (serveOptions?.streaming ?? options?.streaming ?? true)
        ? toLambdaHandler(fetchHandler)
        : toBufferedLambdaHandler(fetchHandler);

    return {
      fetch: app.fetch,
      build: processBuild,
      buildOptions: { distDir: config.distDir },
      // Upstream lists `waku/adapters/aws-lambda-build-enhancer` here (the
      // serve-entry writer). Dropped: the AWS deploy target's finishing pass
      // owns the serve entry.
      buildEnhancers: [],
    };
  },
);

export default awsLambdaAdapter;

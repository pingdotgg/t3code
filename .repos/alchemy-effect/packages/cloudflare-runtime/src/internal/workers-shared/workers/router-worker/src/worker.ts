// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { WorkerEntrypoint } from "cloudflare:workers";
import { generateStaticRoutingRuleMatcher } from "../../asset-worker/src/utils/rules-engine.ts";
import { PerformanceTimer } from "../../../shared/performance.ts";
import { TemporaryRedirectResponse } from "../../../shared/responses.ts";
import { setupSentry } from "../../../shared/sentry.ts";
import { mockJaegerBinding } from "../../../shared/tracing.ts";
import {
  Analytics,
  DISPATCH_TYPE,
  STATIC_ROUTING_DECISION,
} from "./analytics.ts";
import {
  applyEyeballConfigDefaults,
  applyRouterConfigDefaults,
} from "./configuration.ts";
import { renderLimitedResponse } from "./limited-response.ts";
import type AssetWorker from "../../asset-worker/index.ts";
import type {
  EyeballRouterConfig,
  JaegerTracing,
  RouterConfig,
  UnsafePerformanceTimer,
} from "../../../shared/types.ts";
import type { ColoMetadata, Environment, ReadyAnalytics } from "./types.ts";

export interface Env {
  ASSET_WORKER: Service<AssetWorker>;
  USER_WORKER: Fetcher;
  CONFIG: RouterConfig;
  EYEBALL_CONFIG: EyeballRouterConfig;

  SENTRY_DSN: string;
  ENVIRONMENT: Environment;
  ANALYTICS: ReadyAnalytics;
  COLO_METADATA: ColoMetadata;
  UNSAFE_PERFORMANCE: UnsafePerformanceTimer;
  VERSION_METADATA: WorkerVersionMetadata;
  JAEGER: JaegerTracing;

  SENTRY_ACCESS_CLIENT_ID: string;
  SENTRY_ACCESS_CLIENT_SECRET: string;
}

type LoopbackExecutionContext = ExecutionContext & {
  exports: {
    RouterInnerEntrypoint(options: { props: Record<string, never> }): {
      fetch(request: Request): Promise<Response>;
    };
  };
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Router worker is typechecked both in this package and as a transitive
    // dependency during miniflare builds. In the miniflare type context,
    // Cloudflare.Exports may not include this worker's mainModule mapping from
    // worker-configuration.d.ts, so `ctx.exports.RouterInnerEntrypoint` does not
    // resolve structurally. Keep this narrow cast so loopback typechecks in both
    // compilation contexts without changing runtime behavior.
    const loopbackCtx = ctx as LoopbackExecutionContext;

    const analytics = new Analytics(env.ANALYTICS);
    let inner;
    try {
      if (env.COLO_METADATA && env.VERSION_METADATA && env.CONFIG) {
        const url = new URL(request.url);
        analytics.setData({
          accountId: env.CONFIG.account_id,
          scriptId: env.CONFIG.script_id,
          coloId: env.COLO_METADATA.coloId,
          metalId: env.COLO_METADATA.metalId,
          coloTier: env.COLO_METADATA.coloTier,
          coloRegion: env.COLO_METADATA.coloRegion,
          hostname: url.hostname,
          version: env.VERSION_METADATA.tag,
        });
      }
      inner = loopbackCtx.exports.RouterInnerEntrypoint({ props: {} });
    } catch (err) {
      const sentry = setupSentry(
        request,
        ctx,
        env.SENTRY_DSN,
        env.SENTRY_ACCESS_CLIENT_ID,
        env.SENTRY_ACCESS_CLIENT_SECRET,
        env.COLO_METADATA,
        env.VERSION_METADATA,
        env.CONFIG?.account_id,
        env.CONFIG?.script_id,
      );
      sentry?.captureException(err);

      if (err instanceof Error) {
        analytics.setData({ error: err.message });
      }
      analytics.write();

      throw err;
    }

    return inner.fetch(request);
  },
};

export class RouterInnerEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    let sentry: ReturnType<typeof setupSentry> | undefined;
    let userWorkerInvocation = false;
    const analytics = new Analytics(this.env.ANALYTICS);
    const performance = new PerformanceTimer(this.env.UNSAFE_PERFORMANCE);
    const startTimeMs = performance.now();

    try {
      if (!this.env.JAEGER) {
        this.env.JAEGER = mockJaegerBinding();
      }

      sentry = setupSentry(
        request,
        this.ctx,
        this.env.SENTRY_DSN,
        this.env.SENTRY_ACCESS_CLIENT_ID,
        this.env.SENTRY_ACCESS_CLIENT_SECRET,
        this.env.COLO_METADATA,
        this.env.VERSION_METADATA,
        this.env.CONFIG?.account_id,
        this.env.CONFIG?.script_id,
      );

      const hasStaticRouting = this.env.CONFIG.static_routing !== undefined;
      const config = applyRouterConfigDefaults(this.env.CONFIG);
      const eyeballConfig = applyEyeballConfigDefaults(this.env.EYEBALL_CONFIG);

      const url = new URL(request.url);

      if (
        this.env.COLO_METADATA &&
        this.env.VERSION_METADATA &&
        this.env.CONFIG
      ) {
        analytics.setData({
          accountId: this.env.CONFIG.account_id,
          scriptId: this.env.CONFIG.script_id,

          coloId: this.env.COLO_METADATA.coloId,
          metalId: this.env.COLO_METADATA.metalId,
          coloTier: this.env.COLO_METADATA.coloTier,

          coloRegion: this.env.COLO_METADATA.coloRegion,
          hostname: url.hostname,
          version: this.env.VERSION_METADATA.tag,
          userWorkerAhead: config.invoke_user_worker_ahead_of_assets,
        });
      }

      // Handle /cdn-cgi\... backslash bypass attempts
      // - in production if pathname starts with `/cdn-cgi/` then it bypassed the external
      //   routing and so must have actually started with `/cdn-cgi\`.
      // - in local dev it is possible for pathname to start with `/cdn-cgi/`
      //   even if it doesn't start with `/cdn-cgi\` so we also check the raw URL for that.
      if (
        url.pathname.startsWith("/cdn-cgi/") &&
        request.url.includes("/cdn-cgi\\")
      ) {
        analytics.setData({ cdnCgiBackslashBypassUrl: request.url });
        return new TemporaryRedirectResponse(url.href);
      }

      const routeToUserWorker = async ({
        asset,
      }: {
        asset: "static_routing" | "none";
      }) => {
        if (!config.has_user_worker) {
          throw new Error(
            "Fetch for user worker without having a user worker binding",
          );
        }
        if (eyeballConfig.limitedAssetsOnly) {
          analytics.setData({ userWorkerFreeTierLimiting: true });
          return new Response(renderLimitedResponse(request), {
            status: 429,
            headers: {
              "Content-Type": "text/html",
            },
          });
        }
        analytics.setData({ dispatchtype: DISPATCH_TYPE.WORKER });
        userWorkerInvocation = true;
        return this.env.JAEGER.enterSpan("dispatch_worker", async (span) => {
          span.setTags({
            hasUserWorker: true,
            asset: asset,
            dispatchType: DISPATCH_TYPE.WORKER,
          });

          let shouldCheckContentType = false;
          if (url.pathname.endsWith("/_next/image")) {
            // is a next image
            const queryURLParam = url.searchParams.get("url");
            if (queryURLParam && !queryURLParam.startsWith("/")) {
              // that's a remote resource
              if (
                request.method !== "GET" ||
                request.headers.get("sec-fetch-dest") !== "image"
              ) {
                // that was not loaded via a browser's <img> tag
                shouldCheckContentType = true;
                analytics.setData({ abuseMitigationURLHost: queryURLParam });
              }
              // otherwise, we're good
            }
          }

          if (url.pathname === "/_image") {
            const hrefParam = url.searchParams.get("href");
            if (
              hrefParam &&
              hrefParam.length > 2 &&
              hrefParam.startsWith("//")
            ) {
              try {
                const hrefUrl = new URL("https:" + hrefParam);
                const isImageFetchDest =
                  request.headers.get("sec-fetch-dest") == "image";

                if (hrefUrl.hostname !== url.hostname && !isImageFetchDest) {
                  analytics.setData({ xssDetectionImageHref: hrefParam });
                  return new Response("Blocked", { status: 403 });
                }
              } catch {
                console.log(`Invalid href parameter in /_image: ${hrefParam}`);
              }
            }
          }

          analytics.setData({
            timeToDispatch: performance.now() - startTimeMs,
          });

          if (shouldCheckContentType) {
            const response = await this.env.USER_WORKER.fetch(request);

            if (response.status !== 304 && shouldBlockContentType(response)) {
              analytics.setData({ abuseMitigationBlocked: true });
              return new Response("Blocked", { status: 403 });
            }
            return response;
          }
          return this.env.USER_WORKER.fetch(request);
        });
      };

      const routeToAssets = async ({
        asset,
      }: {
        asset: "static_routing" | "found" | "none";
      }) => {
        analytics.setData({ dispatchtype: DISPATCH_TYPE.ASSETS });
        return await this.env.JAEGER.enterSpan(
          "dispatch_assets",
          async (span) => {
            span.setTags({
              hasUserWorker: config.has_user_worker,
              asset: asset,
              dispatchType: DISPATCH_TYPE.ASSETS,
            });

            analytics.setData({
              timeToDispatch: performance.now() - startTimeMs,
            });
            return this.env.ASSET_WORKER.fetch(request);
          },
        );
      };

      if (config.static_routing) {
        // evaluate "exclude" rules
        const excludeRulesMatcher = generateStaticRoutingRuleMatcher(
          config.static_routing.asset_worker ?? [],
        );
        if (
          excludeRulesMatcher({
            request,
          })
        ) {
          // direct to asset worker
          analytics.setData({
            staticRoutingDecision: STATIC_ROUTING_DECISION.ROUTED,
          });
          return await routeToAssets({ asset: "static_routing" });
        }
        // evaluate "include" rules
        const includeRulesMatcher = generateStaticRoutingRuleMatcher(
          config.static_routing.user_worker ?? [],
        );
        if (
          includeRulesMatcher({
            request,
          })
        ) {
          if (!config.has_user_worker) {
            throw new Error(
              "Fetch for user worker without having a user worker binding",
            );
          }
          // direct to user worker
          analytics.setData({
            staticRoutingDecision: STATIC_ROUTING_DECISION.ROUTED,
          });
          return await routeToUserWorker({ asset: "static_routing" });
        }

        analytics.setData({
          staticRoutingDecision: hasStaticRouting
            ? STATIC_ROUTING_DECISION.NOT_ROUTED
            : STATIC_ROUTING_DECISION.NOT_PROVIDED,
        });
      }

      // User's configuration indicates they want user-Worker to run ahead of any
      // assets. Do not provide any fallback logic.
      if (config.invoke_user_worker_ahead_of_assets) {
        return await routeToUserWorker({ asset: "static_routing" });
      }

      // If we have a user-Worker, but no assets, dispatch to Worker script
      // Do not pass the original request as it would consume the body
      const assetsExist = await this.env.ASSET_WORKER.unstable_canFetch(
        new Request(request.url, {
          headers: request.headers,
          method: request.method,
        }),
      );
      if (config.has_user_worker && !assetsExist) {
        return await routeToUserWorker({ asset: "none" });
      }

      // Otherwise, we either don't have a user worker, OR we have matching assets and should fetch from the assets binding
      return await routeToAssets({ asset: assetsExist ? "found" : "none" });
    } catch (err) {
      if (userWorkerInvocation) {
        // Don't send user Worker errors to sentry; we have no way to distinguish between
        // CF errors and errors from the user's code.
        throw err;
      } else if (err instanceof Error) {
        analytics.setData({ error: err.message });
      }

      // Log to Sentry if we can
      if (sentry) {
        sentry.captureException(err);
      }
      throw err;
    } finally {
      analytics.setData({ requestTime: performance.now() - startTimeMs });
      analytics.write();
    }
  }
}

/**
 * Check if the Content Type is allowed for the the `_next/image` endpoint.
 *
 * - Content Type with multiple values should be blocked
 * - Only Image and Plain Text types are not blocked
 *
 * @param contentType The value of the Content Type header (`null` if no set)
 * @returns Whether the Content Type should be blocked
 */
function shouldBlockContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type");

  if (contentType === null) {
    return true;
  }

  // Block responses with multiple Content Types.
  // https://httpwg.org/specs/rfc9110.html#field.content-type
  if (contentType.includes(",")) {
    return true;
  }

  // Allow only
  // - images (`image/...`)
  // - plain text (`text/plain`, `text/plain;charset=UTF-8`), used by Next errors
  return !(
    contentType.startsWith("image/") ||
    contentType.split(";")[0] === "text/plain"
  );
}

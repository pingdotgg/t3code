// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { WorkerEntrypoint } from "cloudflare:workers";
import { PerformanceTimer } from "../../../shared/performance.ts";
import { setupSentry } from "../../../shared/sentry.ts";
import { mockJaegerBinding } from "../../../shared/tracing.ts";
import { Analytics, EntrypointType } from "./analytics.ts";
import { AssetsManifest } from "./assets-manifest.ts";
import { normalizeConfiguration } from "./configuration.ts";
import { ExperimentAnalytics } from "./experiment-analytics.ts";
import { canFetch, handleRequest } from "./handler.ts";
import { handleError, submitMetrics } from "./utils/final-operations.ts";
import { getAssetWithMetadataFromKV } from "./utils/kv.ts";
import type {
  AssetConfig,
  ColoMetadata,
  JaegerTracing,
  SpanContext,
  UnsafePerformanceTimer,
} from "../../../shared/types.ts";
import type { AccountCohortQuerierBinding } from "../worker-configuration.d.ts";
import type { Environment, ReadyAnalytics } from "./types.ts";

// ============================================================
// SECTION 1: SHARED TYPES & INTERFACE CONTRACT
// ============================================================

export type Env = {
  /*
   * ASSETS_MANIFEST is a pipeline binding to an ArrayBuffer containing the
   * binary-encoded site manifest
   */
  ASSETS_MANIFEST: ArrayBuffer;

  /*
   * ASSETS_KV_NAMESPACE is a pipeline binding to the KV namespace that the
   * assets are in.
   */
  ASSETS_KV_NAMESPACE: KVNamespace;

  CONFIG: AssetConfig;

  SENTRY_DSN: string;
  SENTRY_ACCESS_CLIENT_ID: string;
  SENTRY_ACCESS_CLIENT_SECRET: string;

  JAEGER: JaegerTracing;

  ENVIRONMENT: Environment;
  EXPERIMENT_ANALYTICS: ReadyAnalytics;
  ANALYTICS: ReadyAnalytics;
  COLO_METADATA: ColoMetadata;
  UNSAFE_PERFORMANCE: UnsafePerformanceTimer;
  VERSION_METADATA: WorkerVersionMetadata;
  ACCOUNT_COHORT_QUERIER?: AccountCohortQuerierBinding;
};

export type AssetWorkerEntrypointProps = {
  traceContext?: SpanContext | null;
};

type GetByETagResult = {
  readableStream: ReadableStream;
  contentType: string | undefined;
  cacheStatus: "HIT" | "MISS";
};

type ExistsFn = (pathname: string, request?: Request) => Promise<string | null>;
type GetByETagFn = (
  eTag: string,
  request?: Request,
) => Promise<GetByETagResult>;

/**
 * Interface defining the public API methods that both the outer and inner
 * entrypoints implement. The outer entrypoint (AssetWorkerOuter) routes to
 * the inner entrypoint (AssetWorkerInner) via ctx.exports.
 */
interface AssetWorkerMethods {
  fetch(request: Request): Promise<Response>;
  unstable_canFetch(request: Request): Promise<boolean>;
  unstable_getByETag(eTag: string, request?: Request): Promise<GetByETagResult>;
  unstable_getByPathname(
    pathname: string,
    request?: Request,
  ): Promise<GetByETagResult | null>;
  unstable_exists(pathname: string, request?: Request): Promise<string | null>;
}

/**
 * Context type used for communication between outer and inner entrypoints
 * via ctx.exports. AssetWorkerOuter accesses the inner factory via exports,
 * AssetWorkerInner receives props via ctx.props.
 */
type AssetWorkerContext = ExecutionContext & {
  exports?: {
    AssetWorkerInner?: (options: {
      props: AssetWorkerEntrypointProps;
      version?: { cohort?: string };
    }) => AssetWorkerMethods;
  };
  props?: AssetWorkerEntrypointProps;
};

// ============================================================
// SECTION 2: SHARED IMPLEMENTATION FUNCTIONS
// ============================================================

async function unstableExistsImpl(
  env: Env,
  pathname: string,
  _request?: Request,
): Promise<string | null> {
  const analytics = new ExperimentAnalytics(env.EXPERIMENT_ANALYTICS);
  const performance = new PerformanceTimer(env.UNSAFE_PERFORMANCE);
  const jaeger = env.JAEGER ?? mockJaegerBinding();
  return jaeger.enterSpan("unstable_exists", async (span) => {
    if (env.COLO_METADATA && env.VERSION_METADATA && env.CONFIG) {
      analytics.setData({
        accountId: env.CONFIG.account_id,
        experimentName: "manifest-read-timing",
      });
    }

    const startTimeMs = performance.now();
    try {
      const assetsManifest = new AssetsManifest(env.ASSETS_MANIFEST);
      const eTag = await assetsManifest.get(pathname);

      span.setTags({
        path: pathname,
        found: eTag !== null,
        etag: eTag ?? "",
      });

      return eTag;
    } finally {
      analytics.setData({
        manifestReadTime: performance.now() - startTimeMs,
      });
      analytics.write();
    }
  });
}

async function unstableGetByETagImpl(
  env: Env,
  eTag: string,
  _request?: Request,
): Promise<GetByETagResult> {
  const performance = new PerformanceTimer(env.UNSAFE_PERFORMANCE);
  const jaeger = env.JAEGER ?? mockJaegerBinding();
  return jaeger.enterSpan("unstable_getByETag", async (span) => {
    const startTime = performance.now();
    const asset = await getAssetWithMetadataFromKV(
      env.ASSETS_KV_NAMESPACE,
      eTag,
    );
    const endTime = performance.now();
    const assetFetchTime = endTime - startTime;

    if (!asset || !asset.value) {
      span.setTags({
        error: true,
      });
      span.addLogs({
        error: `Requested asset ${eTag} exists in the asset manifest but not in the KV namespace.`,
      });
      throw new Error(
        `Requested asset ${eTag} exists in the asset manifest but not in the KV namespace.`,
      );
    }

    // KV does not yet provide a way to check if a value was fetched from cache
    // so we assume that if the fetch time is less than 100ms, it was a cache hit.
    // This is a reasonable assumption given the data we have and how KV works.
    const cacheStatus = assetFetchTime <= 100 ? "HIT" : "MISS";

    span.setTags({
      etag: eTag,
      contentType: asset.metadata?.contentType ?? "unknown",
      cacheStatus,
    });

    return {
      readableStream: asset.value,
      contentType: asset.metadata?.contentType,
      cacheStatus,
    };
  });
}

async function unstableGetByPathnameImpl(
  env: Env,
  exists: ExistsFn,
  getByETag: GetByETagFn,
  pathname: string,
  request?: Request,
): Promise<GetByETagResult | null> {
  const jaeger = env.JAEGER ?? mockJaegerBinding();
  return jaeger.enterSpan("unstable_getByPathname", async (span) => {
    const eTag = await exists(pathname, request);

    span.setTags({
      path: pathname,
      found: eTag !== null,
    });

    if (!eTag) {
      return null;
    }

    return getByETag(eTag, request);
  });
}

export const COHORT_LOOKUP_TIMEOUT_MS = 5;

/**
 * Resolves the deployment cohort for a customer account via the
 * AccountCohortQuerier RPC binding. Returns null when the binding is
 * unavailable, the RPC fails, times out, or the cohort is undetermined
 * (cold cache). Intentionally fails open — a null cohort means the
 * request runs under default routing.
 */
export async function lookupCohort(
  env: Env,
  accountId: number | undefined,
): Promise<string | null> {
  const querier = env.ACCOUNT_COHORT_QUERIER;
  if (!querier || !accountId) {
    return null;
  }
  const ac = new AbortController();
  try {
    const rpc = querier.lookupAccountCohort(accountId.toString());
    // Prevent unhandled rejection if timeout wins but RPC later rejects.
    void rpc.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      const id = setTimeout(() => {
        reject(new Error("cohort lookup timed out"));
      }, COHORT_LOOKUP_TIMEOUT_MS);
      ac.signal.addEventListener("abort", () => clearTimeout(id));
    });
    const res = await Promise.race([rpc, timeout]);
    if (!res.ok) {
      console.error("cohort lookup failed", res.errors);
      return null;
    }
    return res.result ?? null;
  } catch (e: unknown) {
    console.error("cohort lookup failed", e);
    return null;
  } finally {
    ac.abort();
  }
}

async function runFetchRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  exists: ExistsFn,
  getByETag: GetByETagFn,
  cohort?: string,
): Promise<Response> {
  let sentry: ReturnType<typeof setupSentry> | undefined;
  const analytics = new Analytics(env.ANALYTICS);
  const performance = new PerformanceTimer(env.UNSAFE_PERFORMANCE);
  const startTimeMs = performance.now();

  try {
    // TODO: Mock this with Miniflare
    env.JAEGER ??= mockJaegerBinding();

    sentry = setupSentry(
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

    const config = normalizeConfiguration(env.CONFIG);
    sentry?.setContext("compatibilityOptions", {
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      originalCompatibilityFlags: env.CONFIG.compatibility_flags,
    });
    const userAgent = request.headers.get("user-agent") ?? "UA UNKNOWN";

    const url = new URL(request.url);
    if (env.COLO_METADATA && env.VERSION_METADATA && env.CONFIG) {
      analytics.setData({
        accountId: env.CONFIG.account_id,
        scriptId: env.CONFIG.script_id,

        coloId: env.COLO_METADATA.coloId,
        metalId: env.COLO_METADATA.metalId,
        coloTier: env.COLO_METADATA.coloTier,

        coloRegion: env.COLO_METADATA.coloRegion,
        version: env.VERSION_METADATA.tag,
        hostname: url.hostname,
        htmlHandling: config.html_handling,
        notFoundHandling: config.not_found_handling,
        compatibilityFlags: config.compatibility_flags,
        userAgent: userAgent,
        entrypoint: EntrypointType.Inner,
        cohort: cohort ?? "unknown",
      });
    }

    return await env.JAEGER.enterSpan("handleRequest", async (span) => {
      span.setTags({
        hostname: url.hostname,
        eyeballPath: url.pathname,
        env: env.ENVIRONMENT,
        version: env.VERSION_METADATA?.id,
      });

      const response = await handleRequest(
        request,
        env,
        config,
        exists,
        getByETag,
        analytics,
      );

      analytics.setData({ status: response.status });

      return response;
    });
  } catch (err) {
    return handleError(sentry, analytics, err);
  } finally {
    submitMetrics(analytics, performance, startTimeMs);
  }
}

// ============================================================
// SECTION 3: OUTER ENTRYPOINT (AssetWorkerOuter)
// ============================================================

/*
 * The Asset Worker is currently set up as a `WorkerEntrypoint` class so
 * that it is able to accept RPC calls to any of its public methods. There
 * are currently four such public methods defined on this Worker:
 * `canFetch`, `getByETag`, `getByPathname` and `exists`. While we are
 * stabilizing the implementation details of these methods, we would like
 * to prevent developers from having their Workers call these methods
 * directly. To that end, we are adopting the `unstable_<method_name>`
 * naming convention for all of the aforementioned methods, to indicate that
 * they are still in flux and that they are not an established API contract.
 *
 * AssetWorkerOuter serves as the dispatch layer. It forwards all method
 * calls to AssetWorkerInner via ctx.exports.
 */
export default class AssetWorkerOuter<TEnv extends Env = Env>
  extends WorkerEntrypoint<TEnv>
  implements AssetWorkerMethods
{
  private resolvedCohort: string | null | undefined = undefined;

  /**
   * Resolves and caches the cohort for this request. The cohort is
   * constant for the lifetime of the outer entrypoint instance, so
   * we only pay the RPC cost once even if multiple methods are called.
   */
  private async getCohort(): Promise<string | null> {
    if (this.resolvedCohort === undefined) {
      // TODO: Hardcoding temporarily for latency testing.
      // this.resolvedCohort = await lookupCohort(
      // 	this.env,
      // 	this.env.CONFIG?.account_id
      // );
      this.resolvedCohort = "ent";
    }
    return this.resolvedCohort;
  }

  /**
   * Gets the inner entrypoint from ctx.exports to forward requests to.
   * When a cohort is provided, the runtime routes the inner entrypoint
   * to the version assigned to that cohort in the current deployment.
   */
  private getInnerEntrypoint(_cohort?: string | null): AssetWorkerMethods {
    const loopbackCtx = this.ctx as AssetWorkerContext;
    const entrypoint = loopbackCtx.exports?.AssetWorkerInner;
    if (entrypoint === undefined) {
      throw new Error(
        "AssetWorkerInner not found on ctx.exports. " +
          "Ensure enable_ctx_exports compatibility flag is set and " +
          "AssetWorkerInner is exported from the worker module.",
      );
    }
    return entrypoint({
      props: { traceContext: this.env.JAEGER.getSpanContext() },
      // TODO: Hardcoding temporarily for latency testing.
      // ...(cohort ? { version: { cohort } } : {}),
    });
  }

  override async fetch(request: Request): Promise<Response> {
    this.env.JAEGER ??= mockJaegerBinding();
    let sentry: ReturnType<typeof setupSentry> | undefined;
    const analytics = new Analytics(this.env.ANALYTICS);
    const performance = new PerformanceTimer(this.env.UNSAFE_PERFORMANCE);
    const startTimeMs = performance.now();
    try {
      if (
        this.env.COLO_METADATA &&
        this.env.VERSION_METADATA &&
        this.env.CONFIG
      ) {
        const url = new URL(request.url);
        analytics.setData({
          accountId: this.env.CONFIG.account_id,
          scriptId: this.env.CONFIG.script_id,
          coloId: this.env.COLO_METADATA.coloId,
          metalId: this.env.COLO_METADATA.metalId,
          coloTier: this.env.COLO_METADATA.coloTier,
          coloRegion: this.env.COLO_METADATA.coloRegion,
          hostname: url.hostname,
          version: this.env.VERSION_METADATA.tag,
          entrypoint: EntrypointType.Outer,
        });
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

      const cohort = await this.getCohort();
      analytics.setData({ cohort: cohort ?? "unknown" });

      const response = await this.getInnerEntrypoint(cohort).fetch(request);
      analytics.setData({ status: response.status });
      if (response.status >= 500) {
        analytics.setData({ error: "inner entrypoint error" });
      }
      return response;
    } catch (err) {
      analytics.setData({ status: 500 });
      return handleError(sentry, analytics, err);
    } finally {
      submitMetrics(analytics, performance, startTimeMs);
    }
  }

  async unstable_canFetch(request: Request): Promise<boolean> {
    this.env.JAEGER ??= mockJaegerBinding();
    const cohort = await this.getCohort();
    return this.getInnerEntrypoint(cohort).unstable_canFetch(request);
  }

  async unstable_getByETag(
    eTag: string,
    request?: Request,
  ): Promise<GetByETagResult> {
    this.env.JAEGER ??= mockJaegerBinding();
    const cohort = await this.getCohort();
    return this.getInnerEntrypoint(cohort).unstable_getByETag(eTag, request);
  }

  async unstable_getByPathname(
    pathname: string,
    request?: Request,
  ): Promise<GetByETagResult | null> {
    this.env.JAEGER ??= mockJaegerBinding();
    const cohort = await this.getCohort();
    return this.getInnerEntrypoint(cohort).unstable_getByPathname(
      pathname,
      request,
    );
  }

  async unstable_exists(
    pathname: string,
    request?: Request,
  ): Promise<string | null> {
    this.env.JAEGER ??= mockJaegerBinding();
    const cohort = await this.getCohort();
    return this.getInnerEntrypoint(cohort).unstable_exists(pathname, request);
  }
}

// ============================================================
// SECTION 4: INNER ENTRYPOINT (AssetWorkerInner)
// ============================================================

/*
 * AssetWorkerInner contains the actual implementation logic for all asset
 * worker methods. In production, it is instantiated by AssetWorkerOuter via
 * ctx.exports. For local development, tools such as the Vite plugin can
 * subclass AssetWorkerInner directly to override methods like unstable_exists
 * and unstable_getByETag with dev-server-backed implementations.
 */
export class AssetWorkerInner<TEnv extends Env = Env>
  extends WorkerEntrypoint<TEnv>
  implements AssetWorkerMethods
{
  override async fetch(request: Request): Promise<Response> {
    // TODO: Mock this with Miniflare
    this.env.JAEGER ??= mockJaegerBinding();
    const loopbackCtx = this.ctx as AssetWorkerContext;
    const traceContext = loopbackCtx.props?.traceContext ?? null;
    const cohort = this.ctx.version?.cohort;

    const response = await this.env.JAEGER.runWithSpanContext(
      traceContext,
      () =>
        runFetchRequest(
          request,
          this.env,
          this.ctx,
          this.unstable_exists.bind(this),
          this.unstable_getByETag.bind(this),
          cohort,
        ),
    );

    if (response instanceof Response) {
      return response;
    }

    throw new Error("AssetWorkerInner fetch returned non-Response value.");
  }

  async unstable_canFetch(request: Request): Promise<boolean> {
    // TODO: Mock this with Miniflare
    this.env.JAEGER ??= mockJaegerBinding();

    return canFetch(
      request,
      this.env,
      normalizeConfiguration(this.env.CONFIG),
      this.unstable_exists.bind(this),
    );
  }

  async unstable_getByETag(
    eTag: string,
    request?: Request,
  ): Promise<GetByETagResult> {
    return unstableGetByETagImpl(this.env, eTag, request);
  }

  async unstable_getByPathname(
    pathname: string,
    request?: Request,
  ): Promise<GetByETagResult | null> {
    return unstableGetByPathnameImpl(
      this.env,
      this.unstable_exists.bind(this),
      this.unstable_getByETag.bind(this),
      pathname,
      request,
    );
  }

  async unstable_exists(
    pathname: string,
    request?: Request,
  ): Promise<string | null> {
    return unstableExistsImpl(this.env, pathname, request);
  }
}

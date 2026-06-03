import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Logs, Metrics, Traces } from "./Datasets.ts";
import { IngestToken } from "./IngestToken.ts";

/**
 * Public ingest relay used by both:
 *
 * 1. The alchemy CLI / services posting OTLP/JSON to `/v1/{traces,logs,metrics}`,
 *    which we forward to Axiom with the ingest bearer token attached server-side.
 * 2. The website's PostHog browser SDK, which posts to anything else
 *    (`/e`, `/s`, `/flags`, `/decide`, `/static/*`, ...). PostHog ingest needs
 *    no server secret, so we just reverse-proxy to PostHog Cloud (US region).
 *
 * Bound to two custom domains in prod:
 * - `otel.alchemy.run`     — primary OTLP entrypoint
 * - `analytics.alchemy.run` — first-party PostHog ingest (defeats ad-blockers)
 *
 * Environment (set by `stacks/otel.ts`):
 * - `AXIOM_TRACES_ENDPOINT`  — full Axiom OTLP traces URL
 * - `AXIOM_LOGS_ENDPOINT`    — full Axiom OTLP logs URL
 * - `AXIOM_METRICS_ENDPOINT` — full Axiom OTLP metrics URL
 * - `AXIOM_INGEST_TOKEN`     — Bearer token (Redacted)
 */
export default class Ingester extends Cloudflare.Worker<Ingester>()(
  "OtelWorker",
  Stack.useSync(({ stage }) => ({
    main: import.meta.filename,
    observability: { enabled: true },
    domain:
      stage === "prod"
        ? ["otel.alchemy.run", "analytics.alchemy.run"]
        : undefined,
    compatibility: {
      date: "2026-03-17",
      flags: ["nodejs_compat"],
    },
  })),
  Effect.gen(function* () {
    const tokenValue = yield* (yield* IngestToken).token;
    const traces = yield* Traces;
    const logs = yield* Logs;
    const metrics = yield* Metrics;
    const tracesEndpoint = yield* traces.otelTracesEndpoint;
    const logsEndpoint = yield* logs.otelLogsEndpoint;
    const metricsEndpoint = yield* metrics.otelMetricsEndpoint;
    const tracesDataset = yield* traces.name;
    const logsDataset = yield* logs.name;
    const metricsDataset = yield* metrics.name;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const path = url.pathname;

        // 1. OTLP → Axiom (POST /v1/{traces,logs,metrics})
        const otlp =
          request.method === "POST"
            ? path === "/v1/traces"
              ? {
                  endpoint: yield* tracesEndpoint,
                  dataset: yield* tracesDataset,
                }
              : path === "/v1/logs"
                ? { endpoint: yield* logsEndpoint, dataset: yield* logsDataset }
                : path === "/v1/metrics"
                  ? {
                      endpoint: yield* metricsEndpoint,
                      dataset: yield* metricsDataset,
                    }
                  : undefined
            : undefined;

        if (otlp) {
          const tokenRaw = yield* tokenValue.pipe(Effect.map(Redacted.value));
          const token = Redacted.isRedacted(tokenRaw)
            ? Redacted.value(tokenRaw)
            : (tokenRaw as string);

          const body = yield* request.arrayBuffer;

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(otlp.endpoint, {
                method: "POST",
                headers: {
                  "content-type":
                    request.headers["content-type"] ?? "application/json",
                  authorization: `Bearer ${token}`,
                  "x-axiom-dataset": otlp.dataset,
                },
                body,
              }),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          });

          return HttpServerResponse.fromWeb(response);
        }

        // 2. Everything else → PostHog Cloud (US region)
        // /static/* and /array/* live on the assets host; everything else on the
        // ingest host. Static assets are cacheable at the edge.
        const isAsset =
          path.startsWith("/static/") || path.startsWith("/array/");
        const upstreamHost = isAsset
          ? "https://us-assets.i.posthog.com"
          : "https://us.i.posthog.com";
        const target = `${upstreamHost}${path}${url.search}`;

        const raw = yield* HttpServerRequest.toWeb(request);

        // Drop hop-by-hop / Cloudflare-internal headers; preserve everything
        // else (content-type, accept, user-agent, x-forwarded-for, etc.).
        const headers = new Headers(raw.headers);
        headers.delete("host");
        headers.delete("cookie");
        for (const key of [...headers.keys()]) {
          if (key.startsWith("cf-")) headers.delete(key);
        }
        const cfIp =
          raw.headers.get("cf-connecting-ip") ??
          raw.headers.get("x-real-ip") ??
          undefined;
        if (cfIp) headers.set("x-forwarded-for", cfIp);

        const upstream = yield* Effect.tryPromise({
          try: () =>
            fetch(target, {
              method: raw.method,
              headers,
              body:
                raw.method === "GET" || raw.method === "HEAD" ? null : raw.body,
              redirect: "manual",
              ...(isAsset
                ? // Cache the SDK loader / array bundles at the edge for an hour.
                  ({ cf: { cacheTtl: 3600, cacheEverything: true } } as any)
                : {}),
            }),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        });

        return HttpServerResponse.fromWeb(upstream);
      }).pipe(
        Effect.catch((err) =>
          Effect.succeed(
            HttpServerResponse.text(`Relay error: ${err.message}`, {
              status: 502,
            }),
          ),
        ),
      ),
    };
  }),
) {}

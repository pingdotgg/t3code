import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliOverviewDashboard } from "./otel/Dashboard.ts";
import { Logs, Metrics, Traces } from "./otel/Datasets.ts";
import Ingester from "./otel/Ingester.ts";
import {
  ActiveUsersByCi,
  ActiveUsersByVersion,
  ActiveUsersHourly,
  CliInvocations,
  DeployDestroyLatency,
  ResourceErrorRate,
  ResourceLatency,
  ResourcesUsed,
} from "./otel/Views.ts";

/**
 * Provisions an Axiom OTEL ingestion pipeline:
 *
 * - Three datasets (`{stage}-traces`, `{stage}-logs`, `{stage}-metrics`),
 *   each with the matching `otel:*:v1` `kind`.
 * - One ingest-only API token scoped to those three datasets.
 * - Outputs the OTLP endpoints + `Authorization` header value so callers can
 *   wire them straight into a Worker / Lambda's env vars.
 * - Optionally syncs the same values to the GitHub repo's Actions secrets
 *   (set `SYNC_GITHUB_SECRETS=1` when deploying).
 */
export default Alchemy.Stack(
  "AlchemyOtel",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      GitHub.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const traces = yield* Traces;
    const logs = yield* Logs;
    const metrics = yield* Metrics;

    // Public ingest relay. Bound to `otel.alchemy.run` and
    // `analytics.alchemy.run` only in prod so dev stages exercise the same
    // code path under a `*.workers.dev` URL. The same Worker also reverse-
    // proxies PostHog Cloud for first-party browser analytics.
    const relay = yield* Ingester;

    // const posthogProjectKey = yield* Config.string("POSTHOG_PROJECT_KEY")
    //   .pipe(Config.option)
    //
    //   .pipe(Effect.orDie);

    // Saved APL queries — one per insight surfaced by the dashboard.
    yield* ActiveUsersHourly;
    yield* ActiveUsersByVersion;
    yield* ActiveUsersByCi;
    yield* ResourcesUsed;
    yield* DeployDestroyLatency;
    yield* ResourceLatency;
    yield* CliInvocations;
    yield* ResourceErrorRate;

    // Composed dashboard combining the same signals on a 12-col grid.
    yield* CliOverviewDashboard;

    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: traces.otelEndpoint,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: traces.otelTracesEndpoint,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logs.otelLogsEndpoint,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metrics.otelMetricsEndpoint,
      AXIOM_DATASET_TRACES: traces.name,
      AXIOM_DATASET_LOGS: logs.name,
      AXIOM_DATASET_METRICS: metrics.name,
      RELAY_URL: relay.url,
    };

    if (process.env.SYNC_GITHUB_SECRETS === "1") {
      yield* GitHub.Secrets({
        owner: "alchemy-run",
        repository: "alchemy-effect",
        secrets: {
          AXIOM_DATASET_TRACES: traces.name,
          AXIOM_DATASET_LOGS: logs.name,
          AXIOM_DATASET_METRICS: metrics.name,
          OTEL_EXPORTER_OTLP_ENDPOINT: traces.otelEndpoint,
        },
      });
    }

    return env;
  }),
);

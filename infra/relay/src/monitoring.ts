import * as Alchemy from "alchemy";
import * as Axiom from "@alchemy.run/axiom";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { relayResourceNameForStage } from "./deploymentConfig.ts";

const RUNBOOK_URL =
  "https://github.com/pingdotgg/t3code/blob/main/docs/operations/relay-observability.md#alerts";

const LINK_ROUTE = `"/v1/client/environment-links"`;
const TUNNEL_ROUTES = `"/v1/environments/:environmentId/tunnel", "/v1/environments/:environmentId/tunnel/recovery"`;
const CLOUDFLARE_API = `['attributes.url.full'] startswith "https://api.cloudflare.com"`;
const STATUS = `toint(['attributes.http.response.status_code'])`;
// The tunnel reaper records its counters on this span every five minutes,
// including while cleanup is off.
const SWEEP = `name == "relay.managed_endpoint_reaper.sweep"`;
const sweepCounter = (field: string) =>
  `toint(['attributes.custom']['relay.managed_endpoint_reaper.${field}'])`;

// Status codes, not span errors: a request cut off by the relay deadline ends
// as an interrupted span with no error flag, but still answers 504.
// Below `minimum` requests the rate reads 0, so a quiet window cannot page.
const serverFailurePercent = (dataset: string, routes: string, minimum: number) =>
  [
    `['${dataset}']`,
    `| where kind == "server" and ['attributes.http.request.method'] == "POST" and ['attributes.http.route'] in (${routes})`,
    `| summarize total = count(), failed = countif(${STATUS} >= 500)`,
    `| project failure_pct = iff(total >= ${minimum}, 100.0 * failed / total, 0.0)`,
  ].join("\n");

type Severity = "page" | "warn";

interface RelayMonitor {
  readonly id: string;
  readonly severity: Severity;
  readonly name: string;
  /** Why it fires and the healthy baseline. The runbook link is appended. */
  readonly description: string;
  readonly query: (dataset: string) => string;
  readonly operator: "Above" | "AboveOrEqual" | "Below";
  readonly threshold: number;
  readonly rangeMinutes: number;
  readonly intervalMinutes?: number;
  readonly triggerFromNRuns?: number;
  readonly alertOnNoData?: boolean;
}

// Thresholds come from 2026-10-16..19 prod data: the worst healthy window,
// and the outage (Cloudflare API 429s stalling every provision).
// Paging monitors need two bad runs in a row; warnings catch the slow
// degradations an outage threshold has to ignore.
const relayMonitors: ReadonlyArray<RelayMonitor> = [
  {
    id: "RelayLinkFailureRateMonitor",
    severity: "page",
    name: "T3 Connect relay: links failing",
    description:
      "Share of POST /v1/client/environment-links (turning on T3 Connect) answering 5xx over 15 min. Healthy: median 11%, worst 75%. #16810: 87-96%.",
    query: (dataset) => serverFailurePercent(dataset, LINK_ROUTE, 20),
    operator: "Above",
    threshold: 80,
    rangeMinutes: 15,
    triggerFromNRuns: 2,
  },
  {
    id: "RelayTunnelFailureRateMonitor",
    severity: "page",
    name: "T3 Connect relay: tunnel recovery failing",
    description:
      "Share of host tunnel registration and recovery answering 5xx over 15 min. Hosts whose tunnel drops cannot come back. Healthy: median 4%, worst 52%. #16810: 83-94%.",
    query: (dataset) => serverFailurePercent(dataset, TUNNEL_ROUTES, 200),
    operator: "Above",
    threshold: 60,
    rangeMinutes: 15,
    triggerFromNRuns: 2,
  },
  {
    id: "RelayConnectReachabilityMonitor",
    severity: "page",
    name: "T3 Connect relay: environments unreachable",
    description:
      "Share of environments clients tried to reach that connected at least once in 30 min. Offline hosts keep this below 100%, and retry storms against them do not move it. Healthy: 65-72%.",
    query: (dataset) =>
      [
        `['${dataset}']`,
        `| where name == "relay.environment_connector.connect"`,
        `| extend environment = tostring(['attributes.custom']['relay.environment_id'])`,
        `| summarize environments = dcount(environment), connected = dcountif(environment, error != true)`,
        `| project reachable_pct = iff(environments >= 1000, 100.0 * connected / environments, 100.0)`,
      ].join("\n"),
    operator: "Below",
    threshold: 55,
    rangeMinutes: 30,
    triggerFromNRuns: 2,
  },
  {
    id: "RelayPushFailureRateMonitor",
    severity: "page",
    name: "T3 Connect relay: push delivery failing",
    description:
      "Share of APNs and FCM delivery jobs failing over 15 min, e.g. an expired APNs key or FCM credential. Healthy: APNs under 0.3%, FCM under 4%.",
    query: (dataset) =>
      [
        `['${dataset}']`,
        `| where name in ("relay.apns_deliveries.process_signed_job", "relay.fcm.process")`,
        `| summarize total = count(), failed = countif(error == true)`,
        `| project failure_pct = iff(total >= 100, 100.0 * failed / total, 0.0)`,
      ].join("\n"),
    operator: "Above",
    threshold: 10,
    rangeMinutes: 15,
    triggerFromNRuns: 2,
  },
  {
    id: "RelayCloudflareRateLimitedMonitor",
    severity: "page",
    name: "T3 Connect relay: Cloudflare API rate limited",
    description:
      "Cloudflare API 429s, plus calls the relay refused while paused after one, per 10 min. Sustained at this level, links and recoveries stall. Peak 429s before #16810: 1,286; during it: ~11k.",
    query: (dataset) =>
      `['${dataset}']\n| where (${CLOUDFLARE_API} and ${STATUS} == 429) or name == "relay.cloudflare_api_pause.rejected"\n| summarize rate_limited = count()`,
    operator: "AboveOrEqual",
    threshold: 500,
    rangeMinutes: 10,
    triggerFromNRuns: 2,
  },
  {
    id: "RelayTrafficDroppedMonitor",
    severity: "page",
    name: "T3 Connect relay: traffic dropped",
    description:
      "Relay requests per 10 min collapsed: Worker down, broken deploy, or trace export stopped. Healthy minimum: ~69k.",
    query: (dataset) => `['${dataset}']\n| where kind == "server"\n| summarize requests = count()`,
    operator: "Below",
    threshold: 10_000,
    rangeMinutes: 10,
    triggerFromNRuns: 2,
    alertOnNoData: true,
  },
  {
    id: "RelayCloudflareRateLimitWarningMonitor",
    severity: "warn",
    name: "T3 Connect relay: Cloudflare API near its limit",
    description:
      "Any sustained Cloudflare API 429s or paused calls. 429 bursts ran for days before #16810; raise the account limit or cut call volume before they grow.",
    query: (dataset) =>
      `['${dataset}']\n| where (${CLOUDFLARE_API} and ${STATUS} == 429) or name == "relay.cloudflare_api_pause.rejected"\n| summarize rate_limited = count()`,
    operator: "AboveOrEqual",
    threshold: 20,
    rangeMinutes: 10,
    triggerFromNRuns: 2,
  },
  {
    id: "RelayLinkChronicFailureMonitor",
    severity: "warn",
    name: "T3 Connect relay: links degraded",
    description:
      "Share of links answering 5xx over 6 h, mostly 9 s deadline 504s from slow provisioning. Healthy days: 10-18%. Degraded days before #16810: 28-33%.",
    query: (dataset) => serverFailurePercent(dataset, LINK_ROUTE, 100),
    operator: "Above",
    threshold: 20,
    rangeMinutes: 360,
    intervalMinutes: 30,
  },
  {
    id: "RelayDatabaseLatencyMonitor",
    severity: "warn",
    name: "T3 Connect relay: database slow",
    description:
      "p90 Postgres query time over 15 min, in ms. Every relay request runs several queries in sequence, so this sets how close provisioning gets to the 9 s deadline. Healthy: ~200 ms.",
    query: (dataset) =>
      `['${dataset}']\n| where name == "postgres"\n| summarize p90 = percentile(duration, 90)\n| project p90_ms = p90 / 1000000`,
    operator: "Above",
    threshold: 500,
    rangeMinutes: 15,
    triggerFromNRuns: 2,
  },
  {
    id: "RelayTunnelCleanupStoppedMonitor",
    severity: "warn",
    name: "T3 Connect relay: tunnel cleanup stopped",
    description:
      "Tunnel cleanup sweeps that finished in 30 min. Healthy: 6. The cron is not running, or every sweep fails, as during the 2026-10-19 Cloudflare 429s when listing tunnels timed out. Idle tunnels pile up and are billed meanwhile.",
    query: (dataset) =>
      `['${dataset}']\n| where ${SWEEP} and error != true\n| summarize sweeps = count()`,
    operator: "Below",
    threshold: 1,
    rangeMinutes: 30,
    triggerFromNRuns: 2,
    alertOnNoData: true,
  },
  {
    id: "RelayTunnelCleanupFailingMonitor",
    severity: "warn",
    name: "T3 Connect relay: tunnel deletions failing",
    description:
      "Cloudflare tunnel deletions that failed in 30 min. Healthy: 0; the worst 30 min so far had 3. The relay logs a warning with the Cloudflare error for each.",
    query: (dataset) =>
      `['${dataset}']\n| where ${SWEEP}\n| summarize failed = sum(${sweepCounter("failed")})`,
    operator: "Above",
    threshold: 10,
    rangeMinutes: 30,
    triggerFromNRuns: 2,
  },
];

interface QueryChart {
  readonly id: string;
  readonly name: string;
  readonly type: "TimeSeries" | "Table";
  readonly query: { readonly apl: string };
}

const timeSeries = (id: string, name: string, apl: string): QueryChart => ({
  id,
  name,
  type: "TimeSeries",
  query: { apl },
});

const relayDashboardCharts = (dataset: string): ReadonlyArray<QueryChart> => {
  const source = `['${dataset}']`;
  const linkRequests = `${source}\n| where kind == "server" and ['attributes.http.request.method'] == "POST" and ['attributes.http.route'] == ${LINK_ROUTE}`;
  const tunnelRequests = `${source}\n| where kind == "server" and ['attributes.http.request.method'] == "POST" and ['attributes.http.route'] in (${TUNNEL_ROUTES})`;
  const clientConnections = `${source}\n| where name == "relay.connection.attempt" and error != true\n| extend surface = tostring(['resource.custom']['t3.client.surface'])\n| where isnotempty(surface)`;
  return [
    timeSeries(
      "links",
      "Links by outcome",
      `${linkRequests}\n| summarize succeeded = countif(${STATUS} < 400), rejected = countif(${STATUS} >= 400 and ${STATUS} < 500), failed = countif(${STATUS} >= 500) by bin_auto(_time)`,
    ),
    timeSeries(
      "link-latency",
      "Link latency (9 s deadline)",
      `${linkRequests}\n| summarize p50 = percentile(duration, 50), p90 = percentile(duration, 90) by bin_auto(_time)`,
    ),
    timeSeries(
      "reachability",
      "Environments reachable per 30 min (%)",
      `${source}\n| where name == "relay.environment_connector.connect"\n| extend environment = tostring(['attributes.custom']['relay.environment_id'])\n| summarize environments = dcount(environment), connected = dcountif(environment, error != true) by bin(_time, 30m)\n| project _time, reachable_pct = 100.0 * connected / environments`,
    ),
    timeSeries(
      "tunnel",
      "Tunnel registration and recovery by outcome",
      `${tunnelRequests}\n| summarize succeeded = countif(${STATUS} < 400), rejected = countif(${STATUS} >= 400 and ${STATUS} < 500), failed = countif(${STATUS} >= 500) by bin_auto(_time)`,
    ),
    timeSeries(
      "cloudflare-api",
      "Cloudflare API calls by status",
      // Calls refused during a rate-limit pause never reach Cloudflare, so
      // they are their own series or a storm would look like a quiet period.
      `${source}\n| where ${CLOUDFLARE_API} or name == "relay.cloudflare_api_pause.rejected"\n| summarize count() by bin_auto(_time), status = case(name == "relay.cloudflare_api_pause.rejected", "paused", isnull(${STATUS}), "no response", tostring(${STATUS}))`,
    ),
    timeSeries(
      "provision-paths",
      "Tunnel provisions by path",
      `${source}\n| where name == "relay.managed_endpoint_provider.provision"\n| summarize reused_ready_tunnel = countif(error != true and tobool(['attributes.custom']['relay.managed_endpoint.reused_ready_tunnel']) == true), full_provision = countif(error != true and isnull(['attributes.custom']['relay.managed_endpoint.reused_ready_tunnel'])), failed = countif(error == true) by bin_auto(_time)`,
    ),
    timeSeries(
      "postgres",
      "Postgres query time",
      `${source}\n| where name == "postgres"\n| summarize p50 = percentile(duration, 50), p90 = percentile(duration, 90) by bin_auto(_time)`,
    ),
    timeSeries(
      "push",
      "Push delivery jobs",
      `${source}\n| where name in ("relay.apns_deliveries.process_signed_job", "relay.fcm.process")\n| summarize delivered = countif(error != true), failed = countif(error == true) by bin_auto(_time), service = iff(name == "relay.fcm.process", "fcm", "apns")`,
    ),
    timeSeries(
      "tunnel-cleanup",
      "Tunnel cleanup per sweep",
      `${source}\n| where ${SWEEP}\n| summarize deleted = sum(${sweepCounter("deleted")}), deleted_legacy = sum(${sweepCounter("deletedLegacy")}), would_delete = sum(${sweepCounter("wouldDelete")}), would_delete_legacy = sum(${sweepCounter("wouldDeleteLegacy")}), failed = sum(${sweepCounter("failed")}), sweeps_failed = countif(error == true) by bin_auto(_time)`,
    ),
    // Cloudflare's own counts for this stage, including tunnels the reaper
    // skips, so this is the idle tunnels still billed.
    timeSeries(
      "tunnel-backlog",
      "Idle tunnels in Cloudflare",
      `${source}\n| where ${SWEEP}\n| summarize down = max(${sweepCounter("totalDown")}), never_connected = max(${sweepCounter("totalInactive")}) by bin_auto(_time)`,
    ),
    timeSeries(
      "server-errors",
      "5xx by route",
      `${source}\n| where kind == "server" and ${STATUS} >= 500\n| summarize count() by bin_auto(_time), route = tostring(['attributes.http.route']), status = ${STATUS}`,
    ),
    {
      id: "link-failures",
      name: "Link failures by reason",
      type: "Table",
      query: {
        apl: `${source}\n| where name == "relay.environment_linker.link" and error == true\n| extend message = tostring(['status.message'])\n| summarize failures = count() by reason = case(message contains "failed during '", strcat("provisioning: ", extract("failed during '([^']+)'", 1, message)), message startswith "Managed tunnel limit reached", "managed tunnel limit reached", substring(message, 0, 80))\n| top 10 by failures`,
      },
    },
    // Connecting, as users see it: web, desktop and mobile export their
    // connection spans into this dataset, in the same traces as the relay's
    // and the host's spans. An attempt lasts until initial sync finishes.
    timeSeries(
      "connect-time",
      "Connecting: time to connected by surface",
      `${clientConnections}\n| summarize p50 = percentile(duration, 50), p90 = percentile(duration, 90) by bin_auto(_time), surface`,
    ),
    timeSeries(
      "connect-outcomes",
      "Connecting: attempts by outcome",
      `${source}\n| where name == "relay.connection.attempt" and isnotempty(['resource.custom']['t3.client.surface'])\n| summarize connected = countif(error != true), failed = countif(error == true) by bin_auto(_time)`,
    ),
    {
      id: "connect-phases",
      name: "Connecting: where the time goes",
      type: "Table",
      query: {
        // Failed direct route checks stay in: waiting out an unreachable LAN
        // address before falling back to the relay is the slowest step.
        apl: [
          source,
          `| where isnotempty(['resource.custom']['t3.client.surface'])`,
          `| extend url = tostring(['attributes.url.full'])`,
          `| extend phase = case(`,
          `    name == "ConnectionDriver.checkRoute", "0. Direct route check, before any relay fallback",`,
          `    name == "relay.connection.cloudSessionToken.resolve", "1. Clerk session token",`,
          `    name == "clientRuntime.managedRelay.exchangeAccessToken", "2. Relay token exchange",`,
          `    kind == "client" and url startswith "https://relay.t3.codes/v1/environments/" and url endswith "/connect", "3. Relay connect, minting a host credential",`,
          `    name == "environment.authorization.descriptor", "4. Host descriptor",`,
          `    name == "environment.authorization.accessToken.exchange", "5. Host token exchange",`,
          `    name == "clientRuntime.connection.remote.createDpopSocketUrl", "6. Socket ticket",`,
          `    name == "environment.initialSync", "7. Initial sync",`,
          `    name == "relay.connection.attempt", "Total: time to connected",`,
          `    "")`,
          `| where phase != "" and (error != true or phase startswith "0.")`,
          `| summarize calls = count(), p50 = percentile(duration, 50), p90 = percentile(duration, 90) by phase`,
          `| order by phase asc`,
        ].join("\n"),
      },
    },
    timeSeries(
      "relay-latency-by-continent",
      "Relay token and connect latency by user continent (p50)",
      `${source}\n| where kind == "server" and ['attributes.http.request.method'] == "POST" and (['attributes.http.route'] == "/v1/client/dpop-token" or ['attributes.http.route'] == "/v1/environments/:environmentId/connect")\n| extend continent = tostring(['attributes.custom']['relay.edge.continent'])\n| where isnotempty(continent)\n| summarize p50 = percentile(duration, 50) by bin_auto(_time), continent`,
    ),
  ];
};

export const notifierConfig = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.flatMap((value) => Option.liftPredicate(value.trim(), Boolean))),
  );

/**
 * A deployment opts in by naming the notifier that pages (incident.io for
 * prod). Personal stages and forks leave it unset and get no monitors or
 * dashboard. Warnings go to their own notifier when one is set, and are only
 * visible in Axiom otherwise.
 */
export const RelayMonitoring = Effect.fn("RelayMonitoring")(function* (traces: Axiom.Dataset) {
  const { stage } = yield* Alchemy.Stack;
  const page = yield* notifierConfig("RELAY_ALERT_NOTIFIER_ID");
  if (Option.isNone(page)) return;
  const notifiers: Record<Severity, Option.Option<string>> = {
    page,
    warn: yield* notifierConfig("RELAY_WARNING_NOTIFIER_ID"),
  };

  for (const monitor of relayMonitors) {
    yield* Axiom.Monitor(monitor.id, {
      name: stage === "prod" ? monitor.name : `[${stage}] ${monitor.name}`,
      description: `${monitor.description} Runbook: ${RUNBOOK_URL}`,
      type: "Threshold",
      aplQuery: Output.map(traces.name, monitor.query),
      operator: monitor.operator,
      threshold: monitor.threshold,
      intervalMinutes: monitor.intervalMinutes ?? 5,
      rangeMinutes: monitor.rangeMinutes,
      triggerFromNRuns: monitor.triggerFromNRuns ?? 1,
      alertOnNoData: monitor.alertOnNoData ?? false,
      notifierIds: Option.toArray(notifiers[monitor.severity]),
    });
  }

  yield* Axiom.Dashboard("RelayHealthDashboard", {
    dashboard: Output.map(traces.name, (dataset) => {
      const charts = relayDashboardCharts(dataset);
      return {
        name: relayResourceNameForStage("t3-code-relay-health", stage),
        // Shared with the whole org. An empty owner only means that for API
        // tokens; deploys with a personal token would make it private.
        owner: "X-AXIOM-EVERYONE",
        description: `T3 Connect relay health. Alerts and runbook: ${RUNBOOK_URL}`,
        refreshTime: 60,
        schemaVersion: 2,
        timeWindowStart: "qr-now-24h",
        timeWindowEnd: "qr-now",
        charts: [...charts],
        // Two charts per row on Axiom's 12-column grid.
        layout: charts.map((chart, index) => ({
          i: chart.id,
          x: (index % 2) * 6,
          y: Math.floor(index / 2) * 6,
          w: 6,
          h: 6,
        })),
      };
    }),
  });
});

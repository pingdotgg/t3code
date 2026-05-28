import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import type { Chart, LayoutCell } from "alchemy/Axiom";
import * as Effect from "effect/Effect";

export const RELAY_OBSERVABILITY_SERVICE_NAME = "t3-code-relay-worker";
export const RELAY_OBSERVABILITY_EXPORT_INTERVAL = "1 second";

export const RELAY_AXIOM_DATASETS = {
  events: "t3-code-relay-events",
  metrics: "t3-code-relay-metrics",
} as const;

interface RelayAxiomDatasets {
  readonly events: string;
  readonly metrics: string;
}

export const relayEventQuery = (query: string, dataset: string = RELAY_AXIOM_DATASETS.events) =>
  `['${dataset}']\n${query}`;
export const relayLogQuery = relayEventQuery;
export const relayTraceQuery = relayEventQuery;
export const relayMetricMplQuery = (
  metric: string,
  query: string,
  dataset: string = RELAY_AXIOM_DATASETS.metrics,
) => `\`${dataset}\`:\`${metric}\`\n${query}`;

const relayLogFields =
  "| extend logBody = column_ifexists('body', '')\n" +
  "| extend logSeverity = column_ifexists('severityText', '')";

export function makeRelayDashboardCharts(
  datasets: RelayAxiomDatasets = RELAY_AXIOM_DATASETS,
): ReadonlyArray<Chart> {
  return [
    {
      id: "active-managed-tunnels",
      name: "Active managed tunnels",
      type: "Statistic",
      query: {
        apl: relayMetricMplQuery(
          "relay_managed_tunnels_active",
          "| group using sum",
          datasets.metrics,
        ),
      },
    },
    {
      id: "active-environment-links",
      name: "Active environment links",
      type: "Statistic",
      query: {
        apl: relayMetricMplQuery(
          "relay_environment_links_active",
          "| group using sum",
          datasets.metrics,
        ),
      },
    },
    {
      id: "registered-mobile-devices",
      name: "Registered mobile devices",
      type: "Statistic",
      query: {
        apl: relayMetricMplQuery(
          "relay_mobile_devices_registered",
          "| group using sum",
          datasets.metrics,
        ),
      },
    },
    {
      id: "active-agent-activities",
      name: "Active agent activities",
      type: "Statistic",
      query: {
        apl: relayMetricMplQuery(
          "relay_agent_activities_active",
          "| group using sum",
          datasets.metrics,
        ),
      },
    },
    {
      id: "product-state",
      name: "Active Live Activity targets",
      type: "TimeSeries",
      query: {
        apl: relayMetricMplQuery(
          "relay_live_activity_targets_active",
          "| align to $__interval using last\n| group using sum",
          datasets.metrics,
        ),
      },
    },
    {
      id: "managed-tunnel-provisions",
      name: "Managed tunnel provisions",
      type: "TimeSeries",
      query: {
        apl: relayMetricMplQuery(
          "relay_managed_tunnel_provisions_total",
          "| map increase\n| align to $__interval using sum\n| group by outcome, tunnelProvisionKind using sum",
          datasets.metrics,
        ),
      },
    },
    {
      id: "apns-delivery-outcomes",
      name: "APNS delivery outcomes",
      type: "TimeSeries",
      query: {
        apl: relayMetricMplQuery(
          "relay_apns_deliveries_total",
          "| map increase\n| align to $__interval using sum\n| group by operation, kind, outcome using sum",
          datasets.metrics,
        ),
      },
    },
    {
      id: "agent-activity-publishes",
      name: "Agent activity publishes",
      type: "TimeSeries",
      query: {
        apl: relayMetricMplQuery(
          "relay_agent_activity_publishes_total",
          "| map increase\n| align to $__interval using sum\n| group by operation, phase, outcome using sum",
          datasets.metrics,
        ),
      },
    },
    {
      id: "recent-failures",
      name: "Recent failures",
      type: "Table",
      query: {
        apl: relayLogQuery(
          `${relayLogFields}\n| where logSeverity in ("WARN", "WARNING", "ERROR", "FATAL") or logBody contains "failed" or logBody contains "error"\n| order by _time desc\n| limit 100`,
          datasets.events,
        ),
      },
    },
    {
      id: "recent-spans",
      name: "Recent spans",
      type: "Table",
      query: {
        apl: relayTraceQuery(
          "| where isnotnull(span_id) or isnotnull(trace_id)\n| project _time, name, trace_id, span_id, duration, ['relay.environment_id'], ['relay.endpoint']\n| order by _time desc\n| limit 100",
          datasets.events,
        ),
      },
    },
    {
      id: "recent-logs",
      name: "Recent logs",
      type: "LogStream",
      query: {
        apl: relayLogQuery("| order by _time desc\n| limit 200", datasets.events),
      },
    },
  ];
}

export function makeRelayDashboardLayout(charts: ReadonlyArray<Chart>): ReadonlyArray<LayoutCell> {
  const byId = new Map(charts.map((chart) => [chart.id, chart]));
  const cell = (id: string, x: number, y: number, w: number, h: number): LayoutCell => {
    if (!byId.has(id)) {
      throw new Error(`Unknown relay dashboard chart '${id}'.`);
    }
    return { i: id, x, y, w, h };
  };

  return [
    cell("active-managed-tunnels", 0, 0, 3, 3),
    cell("active-environment-links", 3, 0, 3, 3),
    cell("registered-mobile-devices", 6, 0, 3, 3),
    cell("active-agent-activities", 9, 0, 3, 3),
    cell("product-state", 0, 3, 12, 4),
    cell("managed-tunnel-provisions", 0, 7, 6, 4),
    cell("apns-delivery-outcomes", 6, 7, 6, 4),
    cell("agent-activity-publishes", 0, 11, 6, 4),
    cell("recent-failures", 6, 11, 6, 4),
    cell("recent-spans", 0, 15, 12, 5),
    cell("recent-logs", 0, 20, 12, 6),
  ];
}

export const relayAxiomIngestDatasetCapabilities = (
  datasets: RelayAxiomDatasets = RELAY_AXIOM_DATASETS,
) => ({
  [datasets.events]: { ingest: ["create" as const] },
  [datasets.metrics]: { ingest: ["create" as const] },
});

export const relayAxiomQueryDatasetCapabilities = (
  datasets: RelayAxiomDatasets = RELAY_AXIOM_DATASETS,
) => ({
  [datasets.events]: { query: ["read" as const] },
  [datasets.metrics]: { query: ["read" as const] },
});

export const provisionRelayObservability = Effect.gen(function* () {
  const events = yield* Axiom.Dataset("RelayEventsDataset", {
    name: RELAY_AXIOM_DATASETS.events,
    kind: "axiom:events:v1",
    description: "T3 Code relay Worker Effect logs and spans.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });
  const metrics = yield* Axiom.Dataset("RelayMetricsDataset", {
    name: RELAY_AXIOM_DATASETS.metrics,
    kind: "otel:metrics:v1",
    description: "T3 Code relay Worker Effect metrics.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });

  const ingestToken = yield* Axiom.ApiToken("RelayAxiomIngestToken", {
    name: "t3-code-relay-otel-ingest",
    description: "Owned by Alchemy. Scoped OTLP ingest token for the T3 Code relay Worker.",
    datasetCapabilities: Output.all(events.name, metrics.name).pipe(
      Output.map(([eventsName, metricsName]) =>
        relayAxiomIngestDatasetCapabilities({ events: eventsName, metrics: metricsName }),
      ),
    ),
  });
  const queryToken = yield* Axiom.ApiToken("RelayAxiomQueryToken", {
    name: "t3-code-relay-readonly-query",
    description: "Owned by Alchemy. Read-only query token for relay diagnostics.",
    datasetCapabilities: Output.all(events.name, metrics.name).pipe(
      Output.map(([eventsName, metricsName]) =>
        relayAxiomQueryDatasetCapabilities({ events: eventsName, metrics: metricsName }),
      ),
    ),
  });

  yield* Axiom.View("RelayRecentFailuresView", {
    name: "t3-code-relay-recent-failures",
    description: "Recent relay warnings, errors, and failed operations.",
    datasets: [events.name],
    aplQuery: Output.map(events.name, (dataset) =>
      relayLogQuery(
        `${relayLogFields}\n| where logSeverity in ("WARN", "WARNING", "ERROR", "FATAL") or logBody contains "failed" or logBody contains "error"\n| order by _time desc\n| limit 200`,
        dataset,
      ),
    ),
  });
  yield* Axiom.View("RelayRecentLogsView", {
    name: "t3-code-relay-recent-logs",
    description: "Last 500 relay log records.",
    datasets: [events.name],
    aplQuery: Output.map(events.name, (dataset) =>
      relayLogQuery("| order by _time desc\n| limit 500", dataset),
    ),
  });

  yield* Axiom.Monitor("RelayWarningErrorLogsMonitor", {
    name: "T3 Code relay warning/error logs",
    description: "Visible in Axiom monitors. Fires when relay warnings or errors appear.",
    type: "Threshold",
    aplQuery: Output.map(events.name, (dataset) =>
      relayLogQuery(
        `${relayLogFields}\n| where logSeverity in ("WARN", "WARNING", "ERROR", "FATAL") or logBody contains "failed" or logBody contains "error"\n| summarize count() by bin_auto(_time)`,
        dataset,
      ),
    ),
    operator: "Above",
    threshold: 0,
    intervalMinutes: 5,
    rangeMinutes: 5,
    alertOnNoData: false,
    resolvable: true,
    notifierIds: [],
  });
  yield* Axiom.Monitor("RelayApnsFailuresMonitor", {
    name: "T3 Code relay APNS delivery failures",
    description: "Fires when APNS delivery jobs report an unsuccessful result.",
    type: "Threshold",
    aplQuery: Output.map(events.name, (dataset) =>
      relayLogQuery(
        `${relayLogFields}\n| extend apnsOk = column_ifexists('ok', true)\n| extend apnsFailureReason = column_ifexists('apnsReason', '')\n| where logBody contains "apns delivery queue job processed"\n| where apnsOk == false or apnsFailureReason != ""\n| summarize count() by bin_auto(_time)`,
        dataset,
      ),
    ),
    operator: "Above",
    threshold: 0,
    intervalMinutes: 5,
    rangeMinutes: 5,
    alertOnNoData: false,
    resolvable: true,
    notifierIds: [],
  });
  yield* Axiom.Monitor("RelayManagedTunnelProvisionFailuresMonitor", {
    name: "T3 Code relay managed tunnel provisioning failures",
    description: "Fires when managed tunnel provisioning emits failed outcomes.",
    type: "Threshold",
    mplQuery: Output.map(metrics.name, (dataset) =>
      relayMetricMplQuery(
        "relay_managed_tunnel_provisions_total",
        '| where outcome == "failure"\n| map increase\n| align to 5m using sum\n| group using sum',
        dataset,
      ),
    ),
    operator: "Above",
    threshold: 0,
    intervalMinutes: 5,
    rangeMinutes: 5,
    alertOnNoData: false,
    resolvable: true,
    notifierIds: [],
  });
  yield* Axiom.Monitor("RelayApnsMetricFailuresMonitor", {
    name: "T3 Code relay APNS metric failures",
    description: "Fires when APNS send metrics report failed delivery outcomes.",
    type: "Threshold",
    mplQuery: Output.map(metrics.name, (dataset) =>
      relayMetricMplQuery(
        "relay_apns_deliveries_total",
        '| where operation == "send" and outcome == "failure"\n| map increase\n| align to 5m using sum\n| group using sum',
        dataset,
      ),
    ),
    operator: "Above",
    threshold: 0,
    intervalMinutes: 5,
    rangeMinutes: 5,
    alertOnNoData: false,
    resolvable: true,
    notifierIds: [],
  });
  yield* Axiom.Monitor("RelayLogIngestionMonitor", {
    name: "T3 Code relay log ingestion quiet",
    description: "Fires if no relay logs arrive for 15 minutes.",
    type: "Threshold",
    aplQuery: Output.map(events.name, (dataset) =>
      relayLogQuery("| summarize count() by bin_auto(_time)", dataset),
    ),
    operator: "Below",
    threshold: 1,
    intervalMinutes: 15,
    rangeMinutes: 15,
    alertOnNoData: true,
    resolvable: true,
    notifierIds: [],
  });

  const charts = Output.all(events.name, metrics.name).pipe(
    Output.map(([eventsName, metricsName]) =>
      makeRelayDashboardCharts({ events: eventsName, metrics: metricsName }),
    ),
  );
  const dashboard = yield* Axiom.Dashboard("RelayOperationsDashboard", {
    dashboard: {
      name: "T3 Code Relay Operations",
      owner: "",
      description: "Relay Worker logs, spans, metrics, and failure lookup shortcuts.",
      charts,
      layout: makeRelayDashboardLayout(makeRelayDashboardCharts()),
      refreshTime: 60,
      schemaVersion: 2,
      timeWindowStart: "qr-now-6h",
      timeWindowEnd: "qr-now",
    },
  });

  return {
    events,
    metrics,
    ingestToken,
    queryToken,
    dashboard,
  } as const;
});

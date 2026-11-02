import * as Axiom from "@alchemy.run/axiom";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { cacheName } from "./resources.ts";

// Native summaries may be observed by nested launchers and retried after a lost response.
// Deduplicate before summing; task runtime is a compute proxy, not measured CPU or critical-path time.
export const savingsQuery = (
  dataset: string,
  group?: "developer" | "host" | "ci",
  lifetime = false,
) =>
  [
    `['${dataset}']`,
    `| where name == '${lifetime ? "TaskCache.lifetime" : "TaskCache.summary"}'`,
    `| extend a = ['attributes.custom']`,
    `| extend event_id = tostring(a['cache.event_id']), developer = tostring(a['developer.id']), host = tostring(['attributes.host.name']), ci = tobool(a['ci']), recorded_at = tolong(a['cache.recorded_at']), unspecified_ms = coalesce(tolong(a['cache.unspecified_saved_ms']), 0), unspecified_hits = coalesce(tolong(a['cache.unspecified_hits']), 0), local_ms = tolong(a['cache.local_saved_ms']), remote_ms = tolong(a['cache.remote_saved_ms']), local_hits = tolong(a['cache.local_hits']), remote_hits = tolong(a['cache.remote_hits']), executed = tolong(a['cache.executed']), restore_failures = tolong(a['cache.restore_failures'])`,
    `| summarize arg_max(_time, unspecified_ms, unspecified_hits, local_ms, remote_ms, local_hits, remote_hits, executed, restore_failures${lifetime ? "" : ", developer, host, ci, recorded_at"}) by ${lifetime ? "developer, host, ci, platform = tostring(a['host.os']), arch = tostring(['attributes.host.arch'])" : "event_id"}`,
    ...(!lifetime ? ["| extend _time = unixtime_milliseconds_todatetime(recorded_at)"] : []),
    `| where local_hits + remote_hits + unspecified_hits + executed + restore_failures > 0`,
    `| summarize saved_task_hours = sum(local_ms + remote_ms + unspecified_ms) / 3600000.0, remote_saved_hours = sum(remote_ms) / 3600000.0, local_saved_hours = sum(local_ms) / 3600000.0, unspecified_saved_hours = sum(unspecified_ms) / 3600000.0, unspecified_hits = sum(unspecified_hits), local_hits = sum(local_hits), remote_hits = sum(remote_hits), executed = sum(executed), restore_failures = sum(restore_failures)${group ? ` by ${group}` : ""}`,
  ].join("\n");

const summaryRows = (dataset: string) => savingsQuery(dataset).split("\n").slice(0, -1).join("\n");

// One row per native-client install report (scripts/mobile-native-client.ts), deduplicated by report id.
const nativeInstalls = (dataset: string) =>
  [
    `['${dataset}']`,
    `| where name == 'TaskCache.task'`,
    `| extend a = ['attributes.custom']`,
    `| where tostring(a['task.package']) == '@t3tools/mobile' and tostring(a['task.name']) startswith 'native-client'`,
    `| extend event_id = tostring(a['cache.event_id']), task = tostring(a['task.name']), source = tostring(a['cache.source']), saved_ms = tolong(a['cache.saved_ms']), host = tostring(['attributes.host.name']), developer = tostring(a['developer.id'])`,
    `| summarize arg_max(_time, task, source, saved_ms, host, developer) by event_id`,
  ].join("\n");
const nativeCounts =
  "local = countif(source == 'local'), remote = countif(source == 'remote'), built = countif(source == 'executed'), failed = countif(source == 'failed')";

export const Observability = Effect.gen(function* () {
  const name = yield* cacheName;
  const traces = yield* Axiom.Dataset("CacheTraces", {
    name: `${name}-traces`,
    kind: "otel:traces:v1",
    description: "Shared task cache: service traces and unsampled native task savings reports.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });
  const token = yield* Axiom.ApiToken("CacheIngestToken", {
    name: `${name}-otel-ingest`,
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });
  const charts = [
    {
      id: "total",
      name: "⏳ Task hours given back · lifetime",
      type: "Statistic",
      x: 0,
      y: 0,
      w: 3,
      h: 3,
      query: (dataset: string) =>
        `${savingsQuery(dataset, undefined, true)}\n| project saved_task_hours`,
    },
    {
      id: "remote",
      name: "🌍 Remote hours shared · lifetime",
      type: "Statistic",
      x: 3,
      y: 0,
      w: 3,
      h: 3,
      query: (dataset: string) =>
        `${savingsQuery(dataset, undefined, true)}\n| project remote_saved_hours`,
    },
    {
      id: "hit-rate",
      name: "🎯 Cache hit rate · lifetime (%)",
      type: "Statistic",
      x: 6,
      y: 0,
      w: 3,
      h: 3,
      query: (dataset: string) =>
        `${savingsQuery(dataset, undefined, true)}\n| project hit_rate = round(100.0 * (local_hits + remote_hits + unspecified_hits) / (local_hits + remote_hits + unspecified_hits + executed), 1)`,
    },
    {
      id: "skipped",
      name: "⚡ Tasks we skipped · lifetime",
      type: "Statistic",
      x: 9,
      y: 0,
      w: 3,
      h: 3,
      query: (dataset: string) =>
        `${savingsQuery(dataset, undefined, true)}\n| project cached_tasks = local_hits + remote_hits + unspecified_hits`,
    },
    {
      id: "savings-trend",
      name: "📈 Minutes given back over time",
      type: "TimeSeries",
      x: 0,
      y: 3,
      w: 8,
      h: 5,
      query: (dataset: string) =>
        `${summaryRows(dataset)}\n| summarize local_minutes = sum(local_ms) / 60000.0, remote_minutes = sum(remote_ms) / 60000.0, unspecified_minutes = sum(unspecified_ms) / 60000.0 by bin_auto(_time)`,
    },
    {
      id: "developer",
      name: "🏆 Who is saving the most?",
      type: "Pie",
      x: 8,
      y: 3,
      w: 4,
      h: 5,
      query: (dataset: string) =>
        `${savingsQuery(dataset, "developer", true)}\n| project developer, saved_task_hours\n| order by saved_task_hours desc`,
    },
    {
      id: "tasks-trend",
      name: "🔥 Cache hits vs actual execution",
      type: "TimeSeries",
      x: 0,
      y: 8,
      w: 8,
      h: 5,
      query: (dataset: string) =>
        `${summaryRows(dataset)}\n| summarize local_hits = sum(local_hits), remote_hits = sum(remote_hits), unspecified_hits = sum(unspecified_hits), executed = sum(executed) by bin_auto(_time)`,
    },
    {
      id: "host",
      name: "🖥️ The machine leaderboard",
      type: "Pie",
      x: 8,
      y: 8,
      w: 4,
      h: 5,
      query: (dataset: string) =>
        `${savingsQuery(dataset, "host", true)}\n| project host, saved_task_hours\n| order by saved_task_hours desc`,
    },
    {
      id: "leaderboard",
      name: "🏅 Developer scorecard · lifetime",
      type: "Table",
      x: 0,
      y: 13,
      w: 8,
      h: 4,
      query: (dataset: string) =>
        `${savingsQuery(dataset, "developer", true)}\n| project developer, saved_task_hours, remote_saved_hours, cached_tasks = local_hits + remote_hits + unspecified_hits, executed\n| order by saved_task_hours desc`,
    },
    {
      id: "ci",
      name: "🤖 CI vs developer machines · hours saved",
      type: "Pie",
      x: 8,
      y: 13,
      w: 4,
      h: 4,
      query: (dataset: string) =>
        `${savingsQuery(dataset, "ci", true)}\n| summarize saved_task_hours = sum(saved_task_hours) by environment = iff(ci, "CI", "Developer machines")`,
    },
    {
      id: "native-hit-rate",
      name: "📱 Native client hit rate (%)",
      type: "Statistic",
      x: 0,
      y: 17,
      w: 3,
      h: 3,
      query: (dataset: string) =>
        `${nativeInstalls(dataset)}\n| summarize ${nativeCounts}\n| project hit_rate = round(100.0 * (local + remote) / (local + remote + built), 1)`,
    },
    {
      id: "native-saved",
      name: "📱 Native build hours saved",
      type: "Statistic",
      x: 3,
      y: 17,
      w: 3,
      h: 3,
      query: (dataset: string) =>
        `${nativeInstalls(dataset)}\n| summarize build_hours_saved = round(sum(saved_ms) / 3600000.0, 1)`,
    },
    {
      id: "native-builds",
      name: "📱 Native builds (cache misses)",
      type: "Statistic",
      x: 6,
      y: 17,
      w: 3,
      h: 3,
      query: (dataset: string) =>
        `${nativeInstalls(dataset)}\n| summarize builds = countif(source == 'executed')`,
    },
    {
      id: "native-failures",
      name: "📱 Native install failures",
      type: "Statistic",
      x: 9,
      y: 17,
      w: 3,
      h: 3,
      query: (dataset: string) =>
        `${nativeInstalls(dataset)}\n| summarize failures = countif(source == 'failed')`,
    },
    {
      id: "native-trend",
      name: "📱 Native installs: local, shared, built, failed",
      type: "TimeSeries",
      x: 0,
      y: 20,
      w: 8,
      h: 5,
      query: (dataset: string) =>
        `${nativeInstalls(dataset)}\n| summarize ${nativeCounts} by bin_auto(_time)`,
    },
    {
      id: "native-host",
      name: "📱 Native installs by machine",
      type: "Pie",
      x: 8,
      y: 20,
      w: 4,
      h: 5,
      query: (dataset: string) =>
        `${nativeInstalls(dataset)}\n| summarize installs = count() by host\n| order by installs desc`,
    },
    {
      id: "native-platforms",
      name: "📱 Native clients by platform",
      type: "Table",
      x: 0,
      y: 25,
      w: 8,
      h: 4,
      query: (dataset: string) =>
        `${nativeInstalls(dataset)}\n| summarize ${nativeCounts}, hours_saved = round(sum(saved_ms) / 3600000.0, 2) by task\n| extend hit_rate = round(100.0 * (local + remote) / (local + remote + built), 1)\n| order by local + remote + built desc`,
    },
    {
      id: "native-shared",
      name: "📱 Shared cache downloads: hit vs miss",
      type: "TimeSeries",
      x: 8,
      y: 25,
      w: 4,
      h: 4,
      query: (dataset: string) =>
        `['${dataset}']\n| where name == 'NativeClients.handle' and tostring(['attributes.custom']['native.operation']) == 'download'\n| extend result = tostring(['attributes.custom']['native.result'])\n| summarize hits = countif(result == 'hit'), misses = countif(result == 'miss') by bin_auto(_time)`,
    },
  ] as const;
  for (const chart of charts) {
    yield* Axiom.View(`CacheSavings-${chart.id}`, {
      name: `${name}-${chart.id}-savings`,
      description: chart.name,
      datasets: [traces.name],
      aplQuery: Output.map(traces.name, chart.query),
    });
  }
  const dashboard = yield* Axiom.Dashboard("CacheSavingsDashboard", {
    dashboard: {
      name: "⚡ Task Cache · Time Back",
      owner: "X-AXIOM-EVERYONE",
      schemaVersion: 2,
      refreshTime: 60,
      description:
        "Avoided task execution time, not CPU seconds or elapsed developer time. Local and remote hits; deduplicated native Vite+ summaries. Lifetime counters are retained in D1 and refreshed hourly. Raw traces have 30-day retention.",
      timeWindowStart: "qr-now-30d",
      timeWindowEnd: "qr-now",
      charts: charts.map((chart) => {
        const common = {
          id: chart.id,
          name: chart.name,
          query: { apl: Output.map(traces.name, chart.query) },
        };
        switch (chart.type) {
          case "Statistic":
            return { ...common, type: "Statistic" as const };
          case "TimeSeries":
            return {
              ...common,
              type: "TimeSeries" as const,
              query: {
                ...common.query,
                queryOptions: {
                  timeSeriesVariant: chart.id === "savings-trend" ? "area" : "bars",
                  displayNull: "zero",
                  overlayCharts: "true",
                },
              },
            };
          case "Pie":
            return { ...common, type: "Pie" as const };
          case "Table":
            return { ...common, type: "Table" as const };
        }
      }),
      layout: charts.map(({ id, x, y, w, h }) => ({ i: id, x, y, w, h })),
    },
  });
  return { traces, token, dashboard };
});

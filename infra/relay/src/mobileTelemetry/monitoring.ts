import * as Alchemy from "alchemy";
import * as Axiom from "@alchemy.run/axiom";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { relayResourceNameForStage } from "../deploymentConfig.ts";
import { notifierConfig } from "../monitoring.ts";
import { isPreviewStage } from "../previewStages.ts";

const RUNBOOK_URL =
  "https://github.com/pingdotgg/t3code/blob/main/docs/operations/relay-observability.md#mobile-crashes-and-errors";

// A new dataset has none of these fields until a report carries them, and an
// unknown field fails the whole query, so every one has a default.
const field = (name: string, fallback: string) => `column_ifexists('${name}', ${fallback})`;
const reports = (dataset: string) =>
  [
    `['${dataset}']`,
    `| extend source = tostring(${field("attributes.expo.error.source", "''")}),`,
    `    fatal = tobool(${field("attributes.expo.error.is_fatal", "false")}),`,
    `    js_fatal = tobool(${field("attributes.relay.crash.js_fatal", "false")}),`,
    `    platform = tostring(${field("resource.os.name", "''")}),`,
    `    install = tostring(${field("resource.expo.eas_client.id", "''")}),`,
    `    error_type = tostring(${field("attributes.exception.type", "''")}),`,
    `    message = substring(tostring(${field("attributes.exception.message", "''")}), 0, 140),`,
    `    version = strcat(tostring(${field("service.version", "''")}), ' (', tostring(${field("resource.expo.app.build_number", "''")}), ')')`,
    `| where isnotempty(source) and isnotempty(platform)`,
    // A fatal JS error also ends in a native abort; counting both would double every JS crash.
    `| extend kind = case(source == 'nativeCrash' and js_fatal, 'abort after JS crash', source == 'nativeCrash', 'native crash', fatal, 'JS crash', 'handled error')`,
  ].join("\n");
const crashes = (dataset: string) =>
  `${reports(dataset)}\n| where kind in ('JS crash', 'native crash')`;
const handledErrors = (dataset: string) => `${reports(dataset)}\n| where kind == 'handled error'`;
const ingest = (traces: string) =>
  `['${traces}']\n| where name == 'relay.mobile_telemetry.ingest'\n| extend signal = tostring(['attributes.custom']['relay.mobile_telemetry.signal']), outcome = tostring(['attributes.custom']['relay.mobile_telemetry.outcome'])`;

type Severity = "page" | "warn";

interface Datasets {
  readonly logs: string;
  readonly traces: string;
}

interface MobileMonitor {
  readonly id: string;
  readonly severity: Severity;
  readonly name: string;
  /** Why it fires. The runbook link is appended. */
  readonly description: string;
  readonly query: (datasets: Datasets) => string;
  readonly props: Pick<
    Axiom.MonitorProps,
    | "type"
    | "operator"
    | "threshold"
    | "rangeMinutes"
    | "intervalMinutes"
    | "compareDays"
    | "tolerance"
    | "alertOnNoData"
    | "triggerFromNRuns"
  >;
}

// No production baseline exists yet: the spike monitor learns its own, and the
// thresholds below are starting points to tune after two weeks of data.
const mobileMonitors: ReadonlyArray<MobileMonitor> = [
  {
    id: "MobileCrashSpikeMonitor",
    severity: "page",
    name: "T3 Code mobile: crash spike",
    description:
      "Crashes (JS and native, each counted once) per 15 min well above the same time over the last 7 days. Usually a bad OTA update or store build: compare app versions on the dashboard.",
    query: ({ logs }) => `${crashes(logs)}\n| summarize crashes = count() by bin_auto(_time)`,
    props: {
      type: "AnomalyDetection",
      operator: "Above",
      compareDays: 7,
      tolerance: 50,
      rangeMinutes: 15,
      intervalMinutes: 15,
    },
  },
  {
    id: "MobileCrashSpreadMonitor",
    severity: "page",
    name: "T3 Code mobile: one crash hitting many installs",
    description:
      "The most widespread crash reached this many installs in an hour. Its message and versions are at the top of the dashboard's Top crashes table.",
    query: ({ logs }) =>
      `${crashes(logs)}\n| summarize installs = dcount(install) by platform, error_type, message\n| summarize worst = max(installs)`,
    props: {
      type: "Threshold",
      operator: "AboveOrEqual",
      threshold: 25,
      rangeMinutes: 60,
      intervalMinutes: 15,
    },
  },
  {
    id: "MobileTelemetryStoppedMonitor",
    severity: "warn",
    name: "T3 Code mobile: reports stopped",
    description:
      "No startup metrics forwarded in an hour. Every launch sends some, so the relay route, the Axiom token, or the app's endpoint is broken, and crashes go unseen too.",
    query: ({ traces }) =>
      `${ingest(traces)}\n| where signal == 'metrics' and outcome == 'forwarded'\n| summarize forwarded = count()`,
    props: {
      type: "Threshold",
      operator: "Below",
      threshold: 1,
      rangeMinutes: 60,
      intervalMinutes: 15,
      alertOnNoData: true,
      triggerFromNRuns: 2,
    },
  },
  {
    id: "MobileSymbolicationFailingMonitor",
    severity: "warn",
    name: "T3 Code mobile: crash stacks not symbolicated",
    description:
      "Share of release JS exceptions over 6 h whose stack stayed minified. Map uploads are failing or the relay cannot read them; relay.symbolication.status says which.",
    query: ({ logs }) =>
      [
        `['${logs}']`,
        `| extend status = tostring(${field("attributes.relay.symbolication.status", "''")})`,
        `| where isnotempty(status) and status !in ('no_bundle_id', 'no_bundle_frames')`,
        `| summarize total = count(), minified = countif(status != 'symbolicated')`,
        `| project minified_pct = iff(total >= 20, 100.0 * minified / total, 0.0)`,
      ].join("\n"),
    props: {
      type: "Threshold",
      operator: "Above",
      threshold: 50,
      rangeMinutes: 360,
      intervalMinutes: 60,
    },
  },
];

interface QueryChart {
  readonly id: string;
  readonly name: string;
  readonly type: "TimeSeries" | "Table" | "Statistic";
  readonly query: { readonly apl: string };
  /** Grid columns out of 12. */
  readonly width: 4 | 6 | 12;
}

const chart = (
  type: QueryChart["type"],
  width: QueryChart["width"],
  id: string,
  name: string,
  apl: string,
): QueryChart => ({ id, name, type, width, query: { apl } });

const mobileDashboardCharts = ({ logs, traces }: Datasets): ReadonlyArray<QueryChart> => [
  chart("Statistic", 4, "crashes", "Crashes", `${crashes(logs)}\n| summarize count()`),
  chart(
    "Statistic",
    4,
    "crashed-installs",
    "Installs that crashed",
    `${crashes(logs)}\n| summarize dcount(install)`,
  ),
  chart(
    "Statistic",
    4,
    "handled-errors",
    "Handled errors",
    `${handledErrors(logs)}\n| summarize count()`,
  ),
  chart(
    "TimeSeries",
    6,
    "crashes-over-time",
    "Crashes by platform",
    `${crashes(logs)}\n| summarize count() by bin_auto(_time), series = strcat(platform, ' ', kind)`,
  ),
  chart(
    "TimeSeries",
    6,
    "handled-over-time",
    "Handled errors by platform",
    `${handledErrors(logs)}\n| summarize count() by bin_auto(_time), platform`,
  ),
  chart(
    "Table",
    12,
    "top-crashes",
    "Top crashes",
    `${crashes(logs)}\n| summarize installs = dcount(install), crashes = count(), first_seen = min(_time), last_seen = max(_time), versions = make_set(version, 3) by platform, kind, error_type, message\n| order by installs desc, crashes desc\n| take 15`,
  ),
  chart(
    "Table",
    12,
    "top-handled",
    "Top handled errors",
    `${handledErrors(logs)}\n| summarize installs = dcount(install), errors = count(), last_seen = max(_time), versions = make_set(version, 3) by platform, error_type, message\n| order by installs desc, errors desc\n| take 15`,
  ),
  chart(
    "Table",
    6,
    "by-version",
    "Crashes by app version",
    `${crashes(logs)}\n| summarize crashes = count(), installs = dcount(install) by platform, version\n| order by crashes desc\n| take 10`,
  ),
  chart(
    "TimeSeries",
    6,
    "symbolication",
    "JS stacks by symbolication outcome",
    `['${logs}']\n| extend status = tostring(${field("attributes.relay.symbolication.status", "''")})\n| where isnotempty(status)\n| summarize count() by bin_auto(_time), status`,
  ),
  chart(
    "TimeSeries",
    12,
    "ingest",
    "Reports reaching the relay",
    `${ingest(traces)}\n| summarize count() by bin_auto(_time), series = strcat(signal, ' ', outcome)`,
  ),
];

/** Lays charts left to right, wrapping at Axiom's 12-column grid. */
function layout(charts: ReadonlyArray<QueryChart>) {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return charts.map((chart) => {
    const h = chart.type === "Statistic" ? 3 : 6;
    if (x + chart.width > 12) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const cell = { i: chart.id, x, y, w: chart.width, h };
    x += chart.width;
    rowHeight = Math.max(rowHeight, h);
    return cell;
  });
}

/**
 * Monitors follow the relay's: a deployment opts in by naming its paging notifier. The
 * dashboard also comes up on PR previews, so a change to mobile telemetry can be checked
 * there; the preview's teardown removes it.
 */
export const MobileMonitoring = Effect.fn("MobileMonitoring")(function* (
  logs: Axiom.Dataset,
  traces: Axiom.Dataset,
) {
  const { stage } = yield* Alchemy.Stack;
  const page = yield* notifierConfig("RELAY_ALERT_NOTIFIER_ID");
  if (Option.isNone(page) && !isPreviewStage(stage)) return;
  const datasets = Output.map(Output.all(logs.name, traces.name), ([logs, traces]) => ({
    logs,
    traces,
  }));

  if (Option.isSome(page)) {
    const notifiers: Record<Severity, Option.Option<string>> = {
      page,
      warn: yield* notifierConfig("RELAY_WARNING_NOTIFIER_ID"),
    };
    for (const monitor of mobileMonitors) {
      yield* Axiom.Monitor(monitor.id, {
        ...monitor.props,
        name: stage === "prod" ? monitor.name : `[${stage}] ${monitor.name}`,
        description: `${monitor.description} Runbook: ${RUNBOOK_URL}`,
        aplQuery: Output.map(datasets, monitor.query),
        triggerFromNRuns: monitor.props.triggerFromNRuns ?? 1,
        alertOnNoData: monitor.props.alertOnNoData ?? false,
        notifierIds: Option.toArray(notifiers[monitor.severity]),
      });
    }
  }

  yield* Axiom.Dashboard("MobileHealthDashboard", {
    dashboard: Output.map(datasets, (names) => {
      const charts = mobileDashboardCharts(names);
      return {
        name: relayResourceNameForStage("t3-code-mobile-health", stage),
        owner: "X-AXIOM-EVERYONE",
        description: `T3 Code mobile app crashes and errors. Crashes count JS and native once each. Runbook: ${RUNBOOK_URL}`,
        refreshTime: 300,
        schemaVersion: 2,
        timeWindowStart: "qr-now-7d",
        timeWindowEnd: "qr-now",
        charts: charts.map(({ width: _width, ...chart }) => chart),
        layout: layout(charts),
      };
    }),
  });
});

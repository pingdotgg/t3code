import * as Axiom from "@alchemy.run/axiom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const errors = "['chat-traces'] | where error | summarize count() by bin_auto(_time)";
const chart = { id: "errors", name: "Errors", type: "TimeSeries", query: { apl: errors } } as const;
const window = {
  refreshTime: 60,
  schemaVersion: 2,
  timeWindowStart: "qr-now-1h",
  timeWindowEnd: "qr-now",
} as const;
const ingest = {
  "chat-traces": { ingest: ["create"] },
  "chat-logs": { ingest: ["create"] },
} satisfies Record<string, { ingest: "create"[] }>;

// #region show
export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const traces = yield* Axiom.Dataset("Traces", { name: "chat-traces", kind: "otel:traces:v1" });
    const logs = yield* Axiom.Dataset("Logs", { name: "chat-logs", kind: "otel:logs:v1" });
    const token = yield* Axiom.ApiToken("Ingest", {
      name: "chat-ingest",
      datasetCapabilities: ingest,
    });
    // #region dashboard

    yield* Axiom.Dashboard("Dashboard", {
      dashboard: {
        name: "Chat",
        owner: "",
        charts: [chart],
        layout: [{ i: "errors", x: 0, y: 0, w: 12, h: 6 }],
        ...window,
      },
    });
    // #endregion dashboard
    // #region monitor
    yield* Axiom.Monitor("Errors", {
      name: "Chat errors",
      type: "Threshold",
      aplQuery: errors,
      operator: "Above",
      threshold: 10,
      intervalMinutes: 5,
      rangeMinutes: 5,
    });
    // #endregion monitor

    return Axiom.Telemetry({ token, traces, logs });
  }),
);
// #endregion show

import * as Axiom from "@alchemy.run/axiom";

// #region show
export const Traces = Axiom.Dataset("Traces", { name: "chat-traces", kind: "otel:traces:v1" });
export const Logs = Axiom.Dataset("Logs", { name: "chat-logs", kind: "otel:logs:v1" });

export const Ingest = Axiom.ApiToken("Ingest", {
  name: "chat-ingest",
  datasetCapabilities: {
    "chat-traces": { ingest: ["create"] },
    "chat-logs": { ingest: ["create"] },
  },
});
// #endregion show

import { describe, expect, it } from "vitest";

import {
  RELAY_AXIOM_DATASETS,
  makeRelayDashboardCharts,
  makeRelayDashboardLayout,
  relayAxiomIngestDatasetCapabilities,
  relayAxiomQueryDatasetCapabilities,
} from "./RelayObservability.ts";

describe("RelayObservability", () => {
  it("scopes the ingest token to create-only ingest across relay datasets", () => {
    expect(relayAxiomIngestDatasetCapabilities()).toEqual({
      [RELAY_AXIOM_DATASETS.events]: { ingest: ["create"] },
      [RELAY_AXIOM_DATASETS.metrics]: { ingest: ["create"] },
    });
  });

  it("scopes the diagnostics query token to read-only query across relay datasets", () => {
    expect(relayAxiomQueryDatasetCapabilities()).toEqual({
      [RELAY_AXIOM_DATASETS.events]: { query: ["read"] },
      [RELAY_AXIOM_DATASETS.metrics]: { query: ["read"] },
    });
  });

  it("keeps dashboard layout cells in sync with declared charts", () => {
    const charts = makeRelayDashboardCharts();
    const chartIds = new Set(charts.map((chart) => chart.id));
    const layout = makeRelayDashboardLayout(charts);

    expect(layout).toHaveLength(charts.length);
    for (const cell of layout) {
      expect(chartIds.has(cell.i)).toBe(true);
    }
  });

  it("builds log APL and metrics MPL dashboard queries", () => {
    const charts = makeRelayDashboardCharts({
      events: "relay-events-test",
      metrics: "relay-metrics-test",
    });
    const recentFailures = charts.find((chart) => chart.id === "recent-failures");
    const activeTunnels = charts.find((chart) => chart.id === "active-managed-tunnels");
    if (
      !recentFailures ||
      !("query" in recentFailures) ||
      !activeTunnels ||
      !("query" in activeTunnels)
    ) {
      throw new Error("Expected query-backed relay charts.");
    }

    expect(recentFailures.query.apl).toContain("['relay-events-test']");
    expect(recentFailures.query.apl).toContain("column_ifexists('severityText', '')");
    expect(recentFailures.query.apl).not.toContain("severity_text");
    expect(activeTunnels.query.apl).toContain(
      "`relay-metrics-test`:`relay_managed_tunnels_active`",
    );
    expect(activeTunnels.query.apl).toContain("| group using sum");
    expect(activeTunnels.query.apl).not.toContain("['relay-metrics-test']");
  });
});

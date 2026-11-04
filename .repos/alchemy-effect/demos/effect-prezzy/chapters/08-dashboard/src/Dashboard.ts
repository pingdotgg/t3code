import * as Axiom from "@alchemy.run/axiom";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/** Shorty's service dashboard, declared next to the code it observes. */
export const Dashboard = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const dataset = `['shorty-${stage}-traces']`;

  const charts: Axiom.DashboardProps["dashboard"]["charts"] = [
    {
      id: "requests",
      name: "Requests by route",
      type: "TimeSeries",
      query: {
        apl: `${dataset} | where kind == 'server' | summarize count() by bin_auto(_time), ['attributes.http.route']`,
      },
    },
    {
      id: "latency",
      name: "p95 latency (ms)",
      type: "Statistic",
      query: {
        apl: `${dataset} | where kind == 'server' | summarize percentile(duration / 1ms, 95)`,
      },
    },
    {
      id: "clicks",
      name: "Clicks by link",
      type: "Table",
      query: {
        apl: `${dataset} | where name == 'clicks.record' | summarize clicks = sum(toint(['attributes.custom']['n'])) by link = tostring(['attributes.custom']['code']) | order by clicks desc`,
      },
    },
    {
      id: "errors",
      name: "Errors",
      type: "TimeSeries",
      query: {
        apl: `${dataset} | where ['status.code'] == 'ERROR' | summarize count() by bin_auto(_time), name`,
      },
    },
  ];

  return yield* Axiom.Dashboard("Dashboard", {
    dashboard: {
      name: `Shorty (${stage})`,
      owner: "",
      description: "Requests, latency, clicks and errors for the Shorty API",
      refreshTime: 15,
      schemaVersion: 2,
      timeWindowStart: "qr-now-30m",
      timeWindowEnd: "qr-now",
      charts,
      layout: [
        { i: "requests", x: 0, y: 0, w: 8, h: 6 },
        { i: "latency", x: 8, y: 0, w: 4, h: 6 },
        { i: "clicks", x: 0, y: 6, w: 6, h: 6 },
        { i: "errors", x: 6, y: 6, w: 6, h: 6 },
      ],
    },
  });
});

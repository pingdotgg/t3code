---
title: Observability
description: Effect emits OpenTelemetry — ship traces, metrics, and logs to Axiom, Datadog, CloudWatch, or any OTLP endpoint. Declare dashboards and alarms in code.
sidebar:
  order: 13
---

Effect already emits traces, metrics, and logs. Alchemy declares the
exporter as a Layer — point it at Axiom, Datadog, CloudWatch, or any
OTLP endpoint. Then declare your dashboards and alarms next to the
code that emits the metrics.

## OTel everywhere

Every Effect spans a trace. Every `Metric` increments a counter.
Every `logInfo` ships a log line. The exporter is a Layer — swap one
line, ship to a different vendor.

```typescript
// Effect emits OpenTelemetry by default.
// Pick an exporter Layer; the Worker code never changes.
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    yield* Effect.logInfo("request received");
    yield* Metric.increment(requestsTotal);
    return { fetch: handler };
  }).pipe(
    Effect.provide(AxiomExporter), // or CloudWatch, Datadog, OTLP …
  ),
) {}
```

Supported destinations include Axiom, Datadog, CloudWatch, and any
OTLP-compatible collector.

## Dashboards and alarms in code

Declare CloudWatch (or Grafana, or Datadog) dashboards and alarms
next to the resources they observe. Threshold change? It's a diff in
the PR — reviewable, revertable, audited.

```typescript
// alchemy.run.ts — same program. same diff. operations included.
export const Dashboard = AWS.CloudWatch.Dashboard("ApiHealth", {
  widgets: [
    Widget.line({ title: "p99 latency", metric: api.metrics.p99 }),
    Widget.line({ title: "requests / sec", metric: api.metrics.rps }),
    Widget.number({ title: "5xx ratio", metric: api.metrics.errorRate }),
  ],
});

export const P99Alarm = AWS.CloudWatch.Alarm("p99Latency", {
  metric: api.metrics.p99,
  threshold: 500,
  comparisonOperator: ">",
  evaluationPeriods: 5,
  alarmActions: [pagerDuty, slackWebhook],
});
```

- Widgets reference typed `.metrics` outputs from your resources.
- Alarms compose. Same alarm wired to PagerDuty, Slack, SQS — typed
  actions.
- Per-stage dashboards: `prod`, `staging`, `pr-42` all separate.

## Alerts wired to anything

Alarm actions are typed resources too. Wire your alarms to PagerDuty,
Slack, an SQS queue, an SNS topic — reuse the same notification
channel across every alarm in the stack.

- **Threshold + window** — Configure evaluation periods, statistic,
  comparison operator — all typed, autocompleted in your editor.
- **Composite alarms** — AND/OR multiple alarm states into a
  higher-level alert — declared as values, not console rules.
- **Audit trail in git** — Every threshold and channel lives in
  source. Who changed it, when, and why — answered by `git blame`.

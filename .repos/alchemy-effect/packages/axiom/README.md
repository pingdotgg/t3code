# @alchemy.run/axiom

[Axiom](https://axiom.co) for [Alchemy](https://alchemy.run). Declare OpenTelemetry datasets, ingest tokens, monitors, and dashboards next to the code that emits the data.

```sh
npm install alchemy @alchemy.run/axiom effect
```

Datasets for traces and logs, an ingest-only token, and a monitor:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Axiom from "@alchemy.run/axiom";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Observability",
  {
    providers: Axiom.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const traces = yield* Axiom.Dataset("traces", { name: "app-traces", kind: "otel:traces:v1" });
    const logs = yield* Axiom.Dataset("logs", { name: "app-logs", kind: "otel:logs:v1" });

    // Can write to the two datasets and nothing else.
    const ingest = yield* Axiom.ApiToken("ingest", {
      name: "app-ingest",
      datasetCapabilities: {
        "app-traces": { ingest: ["create"] },
        "app-logs": { ingest: ["create"] },
      },
    });

    yield* Axiom.Monitor("panics", {
      name: "Service panic",
      type: "MatchEvent",
      aplQuery: `['app-logs'] | where message contains "panic:"`,
      intervalMinutes: 1,
      rangeMinutes: 1,
    });

    return {
      tracesEndpoint: traces.otelTracesEndpoint,
      logsEndpoint: logs.otelLogsEndpoint,
      token: ingest.token,
    };
  }),
);
```

Pass the endpoints and token to a Worker or Lambda as environment variables and its OpenTelemetry exporter ships straight to Axiom.

## Learn more

- [Axiom on alchemy.run](https://alchemy.run/axiom)
- [Setup](https://alchemy.run/axiom/setup)
- [Telemetry](https://alchemy.run/infrastructure-as-effects/telemetry)

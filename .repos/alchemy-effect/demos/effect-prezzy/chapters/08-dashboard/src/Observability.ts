import * as Axiom from "@alchemy.run/axiom";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Where traces and logs go. Names carry the stage, so dev, test and prod never mix. */
export const Observability = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const traces = yield* Axiom.Dataset("Traces", {
    name: `shorty-${stage}-traces`,
    kind: "otel:traces:v1",
  });
  const logs = yield* Axiom.Dataset("Logs", {
    name: `shorty-${stage}-logs`,
    kind: "otel:logs:v1",
  });
  const ingest = yield* Axiom.ApiToken("Ingest", {
    name: `shorty-${stage}-ingest`,
    // This token can write to these two datasets and nothing else.
    datasetCapabilities: {
      [`shorty-${stage}-traces`]: { ingest: ["create"] },
      [`shorty-${stage}-logs`]: { ingest: ["create"] },
    },
  });
  return { traces, logs, ingest };
});

/** Export the Worker's spans and logs to Axiom. */
export const Telemetry = Layer.unwrap(
  Effect.gen(function* () {
    const { traces, logs, ingest } = yield* Observability;
    return Axiom.Telemetry({ token: ingest, traces, logs });
  }),
);

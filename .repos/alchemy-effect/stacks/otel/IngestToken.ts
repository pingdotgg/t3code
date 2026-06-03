import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import { Effect } from "effect";
import { Logs, Metrics, Traces } from "./Datasets.ts";

export const IngestToken = Axiom.ApiToken(
  "IngestToken",
  Effect.all([Alchemy.Stack, Traces, Logs, Metrics]).pipe(
    Effect.map(([stack, traces, logs, metrics]) => ({
      name: `${stack.stage}-otel-ingest`,
      description: `Ingest-only token for ${stack.stage} OTEL datasets`,
      // Reference dataset Outputs (rather than literal strings) so Alchemy
      // sequences the token after the datasets exist.
      datasetCapabilities: Output.all(
        traces.name,
        logs.name,
        metrics.name,
      ).pipe(
        Output.map(([t, l, m]) => ({
          [t]: { ingest: ["create"] as const },
          [l]: { ingest: ["create"] as const },
          [m]: { ingest: ["create"] as const },
        })),
      ),
    })),
  ),
);

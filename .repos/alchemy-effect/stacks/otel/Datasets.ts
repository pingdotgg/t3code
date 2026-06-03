import * as Axiom from "alchemy/Axiom";
import { Stack } from "alchemy/Stack";

export const Traces = Axiom.Dataset(
  "Traces",
  Stack.useSync(({ stage }) => ({
    name: `${stage}-traces`,
    kind: "otel:traces:v1" as const,
    description: `OTEL traces for stage '${stage}'`,
    retentionDays: 30,
    useRetentionPeriod: true,
  })),
);

export const Logs = Axiom.Dataset(
  "Logs",
  Stack.useSync(({ stage }) => ({
    name: `${stage}-logs`,
    kind: "otel:logs:v1" as const,
    description: `OTEL logs for stage '${stage}'`,
    retentionDays: 30,
    useRetentionPeriod: true,
  })),
);

export const Metrics = Axiom.Dataset(
  "Metrics",
  Stack.useSync(({ stage }) => ({
    name: `${stage}-metrics`,
    kind: "otel:metrics:v1" as const,
    description: `OTEL metrics for stage '${stage}'`,
    retentionDays: 30,
    useRetentionPeriod: true,
  })),
);

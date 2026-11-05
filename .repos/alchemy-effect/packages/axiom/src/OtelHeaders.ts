/**
 * Axiom routes OTLP ingest by a dataset header. Traces and logs use
 * `X-Axiom-Dataset`; the metrics endpoint requires `X-Axiom-Metrics-Dataset`
 * instead (https://axiom.co/docs/send-data/opentelemetry).
 *
 * @internal
 */
export const otelDatasetHeader = (metrics: boolean): string =>
  metrics ? "X-Axiom-Metrics-Dataset" : "X-Axiom-Dataset";

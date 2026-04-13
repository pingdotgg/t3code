import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface PerfLatencySample {
  readonly name: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface PerfLatencySummary {
  readonly count: number;
  readonly minMs: number | null;
  readonly avgMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

export function percentile(values: ReadonlyArray<number>, target: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const clampedTarget = Math.min(Math.max(target, 0), 1);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * clampedTarget) - 1),
  );
  return sorted[index] ?? null;
}

export function summarizeLatencyValues(values: ReadonlyArray<number>): PerfLatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: null,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    };
  }

  const minMs = values.reduce((currentMin, value) => Math.min(currentMin, value), values[0]!);
  const maxMs = values.reduce((currentMax, value) => Math.max(currentMax, value), values[0]!);
  const avgMs = values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    count: values.length,
    minMs,
    avgMs,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs,
  };
}

export function summarizeLatencySamples(
  samples: ReadonlyArray<PerfLatencySample>,
): PerfLatencySummary {
  return summarizeLatencyValues(samples.map((sample) => sample.durationMs));
}

export async function writeJsonArtifact<TArtifact extends object>(
  outputPath: string,
  artifact: TArtifact,
): Promise<void> {
  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(`${resolvedOutputPath}`, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

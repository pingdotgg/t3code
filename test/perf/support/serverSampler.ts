import type { PerfServerMetricSample } from "./artifact.ts";

export interface PerfServerSampler {
  readonly start: (input: { readonly pid: number }) => Promise<void>;
  readonly stop: () => Promise<ReadonlyArray<PerfServerMetricSample> | null>;
}

export class NoopServerSampler implements PerfServerSampler {
  async start(_input: { readonly pid: number }): Promise<void> {}

  async stop(): Promise<null> {
    return null;
  }
}

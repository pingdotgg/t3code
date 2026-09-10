interface Env {
  dataset: string;
}

class LocalAnalyticsEngineDataset implements AnalyticsEngineDataset {
  constructor(private env: Env) {}
  writeDataPoint(_event?: AnalyticsEngineDataPoint): void {
    // no-op in local dev, matching Miniflare's behavior
  }
}

export default function makeBinding(env: Env): AnalyticsEngineDataset {
  return new LocalAnalyticsEngineDataset(env);
}

import * as Cloudflare from "@/Cloudflare/index.ts";

export const Dataset = Cloudflare.AnalyticsEngineDataset("Events", {
  dataset: "alchemy_test_analytics_events",
});

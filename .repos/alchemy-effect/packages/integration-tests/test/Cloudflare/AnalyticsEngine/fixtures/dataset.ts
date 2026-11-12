import * as Cloudflare from "@alchemy.run/cloudflare";

export const Dataset = Cloudflare.AnalyticsEngine.Dataset("Events", {
  dataset: "alchemy_test_analytics_events",
});

import * as Cloudflare from "@/Cloudflare/index.ts";

export const Dataset = Cloudflare.AnalyticsEngine.Dataset("Events", {
  dataset: "alchemy_test_analytics_events",
});

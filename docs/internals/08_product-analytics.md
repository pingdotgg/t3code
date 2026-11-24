# Product analytics

The server supplies a non-exporting [analytics service](../../apps/server/src/telemetry/AnalyticsService.ts)
for callers that use its delivery result, including locally saved agent feedback. The layer does
not resolve analytics identity or use an HTTP client.

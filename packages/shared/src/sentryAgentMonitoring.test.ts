import { describe, expect, it } from "vite-plus/test";

import { parseSentryDsn } from "./sentryAgentMonitoring.ts";

describe("parseSentryDsn", () => {
  it("derives the hosted Sentry OTLP traces endpoint", () => {
    expect(parseSentryDsn("https://public-key@o123.ingest.sentry.io/456")).toEqual({
      tracesUrl: "https://o123.ingest.sentry.io/api/456/integration/otlp/v1/traces",
      authHeader: "sentry sentry_key=public-key",
    });
  });

  it("preserves a self-hosted path prefix", () => {
    expect(parseSentryDsn("https://public@example.test/sentry/42")?.tracesUrl).toBe(
      "https://example.test/sentry/api/42/integration/otlp/v1/traces",
    );
  });

  it.each(["", "not a url", "https://example.test/42", "ftp://key@example.test/42"])(
    "rejects an invalid DSN: %s",
    (dsn) => expect(parseSentryDsn(dsn)).toBeNull(),
  );
});

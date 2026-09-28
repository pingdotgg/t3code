import { describe, expect, it } from "vitest";

import {
  aggregateUsage,
  classifyGhOutcome,
  parseGhDebugTelemetry,
  stripGhDebugLines,
  summarizeGhArgs,
} from "./ghDebugTelemetry.ts";
import type { GitHubApiUsageEvent } from "./ghDebugTelemetry.ts";

const NOW = 1_791_000_000_000;

function event(partial: Partial<GitHubApiUsageEvent> & { at: number }): GitHubApiUsageEvent {
  return {
    operation: "pr list",
    feature: "list",
    host: "github.com",
    repository: null,
    prNumber: null,
    httpRequests: 1,
    outcome: "success",
    latencyMs: 400,
    servedFromCache: false,
    ...partial,
  };
}

describe("parseGhDebugTelemetry", () => {
  it("counts one HTTP request per `* Request to` line, not timestamps or durations", () => {
    const stderr = [
      "* Request at 2026-09-28 15:01:11.110634 -0700 PDT m=+0.037498668",
      "* Request to https://api.github.com/user",
      "> GET /user HTTP/1.1",
      "< HTTP/2.0 200 OK",
      "< X-Ratelimit-Limit: 5000",
      "< X-Ratelimit-Remaining: 2472",
      "< X-Ratelimit-Reset: 1790633756",
      "< X-Ratelimit-Resource: core",
      "< X-Ratelimit-Used: 2528",
      "* Request took 380.045083ms",
    ].join("\n");
    const parsed = parseGhDebugTelemetry(stderr);
    expect(parsed.httpRequestCount).toBe(1);
    expect(parsed.rateLimits).toStrictEqual([
      { resource: "core", limit: 5000, remaining: 2472, used: 2528, resetAtMs: 1790633756_000 },
    ]);
  });

  it("counts paginated invocations as multiple HTTP requests with latest-wins quota", () => {
    const stderr = [
      "* Request to https://api.github.com/graphql",
      "< HTTP/2.0 200 OK",
      "< X-Ratelimit-Remaining: 100",
      "< X-Ratelimit-Reset: 1790633756",
      "< X-Ratelimit-Resource: graphql",
      "< X-Ratelimit-Limit: 5000",
      "< X-Ratelimit-Used: 4900",
      "* Request to https://api.github.com/graphql",
      "< HTTP/2.0 200 OK",
      "< X-Ratelimit-Remaining: 99",
      "< X-Ratelimit-Reset: 1790633756",
      "< X-Ratelimit-Resource: graphql",
      "< X-Ratelimit-Limit: 5000",
      "< X-Ratelimit-Used: 4901",
    ].join("\n");
    const parsed = parseGhDebugTelemetry(stderr);
    expect(parsed.httpRequestCount).toBe(2);
    expect(parsed.rateLimits).toStrictEqual([
      { resource: "graphql", limit: 5000, remaining: 99, used: 4901, resetAtMs: 1790633756_000 },
    ]);
  });

  it("ignores invalid reset values instead of recording NaN dates", () => {
    const stderr = [
      "* Request to https://api.github.com/user",
      "< HTTP/2.0 200 OK",
      "< X-Ratelimit-Remaining: 10",
      "< X-Ratelimit-Reset: soon",
      "< X-Ratelimit-Resource: core",
    ].join("\n");
    const parsed = parseGhDebugTelemetry(stderr);
    expect(parsed.httpRequestCount).toBe(1);
    expect(parsed.rateLimits).toStrictEqual([
      { resource: "core", limit: null, remaining: 10, used: null, resetAtMs: null },
    ]);
  });

  it("reports unknown request count when GH_DEBUG output is absent", () => {
    const parsed = parseGhDebugTelemetry("gh: something failed\n");
    expect(parsed.httpRequestCount).toBeNull();
    expect(parsed.rateLimits).toStrictEqual([]);
  });
});

describe("stripGhDebugLines", () => {
  it("removes diagnostic lines but keeps the real error text", () => {
    const stderr = [
      "* Request to https://api.github.com/user",
      "> GET /user HTTP/1.1",
      "> Authorization: token ████████████████████",
      "GraphQL query:",
      "query { viewer { login } }",
      'GraphQL variables: {"limit":1}',
      "< HTTP/2.0 403 Forbidden",
      "HTTP 403: API rate limit exceeded for authenticated user.",
    ].join("\n");
    expect(stripGhDebugLines(stderr)).toBe(
      "HTTP 403: API rate limit exceeded for authenticated user.",
    );
  });

  it("returns empty string when every line is diagnostic", () => {
    expect(stripGhDebugLines("* Request took 1ms\n> GET /x HTTP/1.1")).toBe("");
  });
});

describe("summarizeGhArgs", () => {
  it("keeps the subcommand shape without free text, flags, or bodies", () => {
    expect(
      summarizeGhArgs(["pr", "list", "--search", "is:pr sort:updated-desc", "--limit", "100"]),
    ).toBe("pr list");
    expect(
      summarizeGhArgs(["api", "graphql", "--hostname", "ghe.example.com", "--input", "-"]),
    ).toBe("api graphql");
    expect(summarizeGhArgs(["pr", "comment", "12", "--body-file", "-"])).toBe("pr comment");
  });

  it("names api endpoints without flags or dynamic segments", () => {
    expect(summarizeGhArgs(["api", "--hostname", "github.com", "user", "--jq", ".login"])).toBe(
      "api user",
    );
    expect(summarizeGhArgs(["api", "--hostname", "github.com", "rate_limit"])).toBe(
      "api rate_limit",
    );
    expect(
      summarizeGhArgs(["api", "--hostname", "h", "repos/o/r/issues/1/comments?per_page=30&page=2"]),
    ).toBe("api repos");
    expect(summarizeGhArgs(["api"])).toBe("api");
  });

  it("falls back to the bare command for unknown shapes", () => {
    expect(summarizeGhArgs([])).toBe("gh");
    expect(summarizeGhArgs(["--version"])).toBe("gh");
  });
});

describe("classifyGhOutcome", () => {
  it("marks rate-limited failures from cleaned stderr", () => {
    expect(
      classifyGhOutcome({
        code: 1,
        timedOut: false,
        stderr: "* Request to https://x\nHTTP 403: API rate limit exceeded",
      }),
    ).toBe("rate-limited");
  });

  it("marks generic non-zero exits as failures and zero exits as success", () => {
    expect(classifyGhOutcome({ code: 1, timedOut: false, stderr: "boom" })).toBe("failure");
    expect(classifyGhOutcome({ code: 0, timedOut: false, stderr: "" })).toBe("success");
    expect(classifyGhOutcome({ code: null, timedOut: true, stderr: "" })).toBe("failure");
  });
});

describe("aggregateUsage", () => {
  it("applies the time window and retention bound", () => {
    const events = [
      event({ at: NOW - 60_000, feature: "list", httpRequests: 2 }),
      event({ at: NOW - 90 * 60_000, feature: "monitor", httpRequests: 4 }),
      event({ at: NOW - 20 * 3_600_000, feature: "detail", httpRequests: 8 }),
    ];
    const hourly = aggregateUsage(events, { nowMs: NOW, windowMs: 3_600_000 });
    expect(hourly.totals.invocations).toBe(1);
    expect(hourly.totals.httpRequests).toBe(2);
    expect(hourly.totals.httpRequestsUnknown).toBe(false);
    const daily = aggregateUsage(events, { nowMs: NOW, windowMs: 24 * 3_600_000 });
    expect(daily.totals.invocations).toBe(3);
    expect(daily.totals.httpRequests).toBe(14);
    expect(daily.byFeature).toStrictEqual([
      { key: "detail", invocations: 1, httpRequests: 8, errors: 0, rateLimited: 0 },
      { key: "monitor", invocations: 1, httpRequests: 4, errors: 0, rateLimited: 0 },
      { key: "list", invocations: 1, httpRequests: 2, errors: 0, rateLimited: 0 },
    ]);
  });

  it("flags unknown request counts instead of inventing exactness", () => {
    const events = [
      event({ at: NOW - 10_000, httpRequests: 1 }),
      event({ at: NOW - 20_000, httpRequests: null }),
    ];
    const report = aggregateUsage(events, { nowMs: NOW, windowMs: 3_600_000 });
    expect(report.totals.httpRequests).toBe(1);
    expect(report.totals.httpRequestsUnknown).toBe(true);
  });

  it("separates cache-served reads from outbound traffic", () => {
    const events = [
      event({ at: NOW - 10_000, servedFromCache: true, httpRequests: 0 }),
      event({ at: NOW - 20_000, servedFromCache: false, httpRequests: 3, outcome: "rate-limited" }),
      event({ at: NOW - 30_000, servedFromCache: false, httpRequests: 1, outcome: "failure" }),
    ];
    const report = aggregateUsage(events, { nowMs: NOW, windowMs: 3_600_000 });
    expect(report.totals.servedFromCache).toBe(1);
    expect(report.totals.errors).toBe(1);
    expect(report.totals.rateLimited).toBe(1);
  });

  it("buckets a trend over time without exceeding the bucket cap", () => {
    const events = Array.from({ length: 50 }, (_, index) =>
      event({ at: NOW - index * 60_000, httpRequests: 1 }),
    );
    const report = aggregateUsage(events, { nowMs: NOW, windowMs: 3_600_000, trendBuckets: 12 });
    expect(report.trend.length).toBeLessThanOrEqual(12);
    expect(report.trend.reduce((sum, bucket) => sum + bucket.invocations, 0)).toBe(50);
  });
});

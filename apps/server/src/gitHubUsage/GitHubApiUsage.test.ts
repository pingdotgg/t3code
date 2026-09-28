import { describe, expect, it } from "vitest";

import {
  GitHubApiUsageStore,
  MAX_RETAINED_EVENTS,
  parseRateLimitPayload,
  QUOTA_REFRESH_MIN_INTERVAL_MS,
  RETENTION_MS,
} from "./GitHubApiUsage.ts";

const NOW = 1_791_000_000_000;

describe("GitHubApiUsageStore counting and attribution", () => {
  it("attributes invocations by feature, operation, repository, and PR", () => {
    const store = new GitHubApiUsageStore();
    store.record(
      {
        operation: "pr list",
        feature: "monitor",
        host: "github.com",
        repository: "acme/app",
        prNumber: 7,
        httpRequests: 3,
        outcome: "success",
        latencyMs: 900,
      },
      NOW,
    );
    const report = store.report({ window: "1h" }, NOW);
    expect(report.totals).toMatchObject({ invocations: 1, httpRequests: 3 });
    expect(report.byFeature[0]).toMatchObject({ key: "monitor", invocations: 1 });
    expect(report.byRepository[0]).toMatchObject({ key: "github.com/acme/app" });
    expect(report.recent[0]).toMatchObject({ repository: "acme/app", prNumber: 7 });
  });

  it("keeps concurrent records without loss", async () => {
    const store = new GitHubApiUsageStore();
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        Promise.resolve().then(() =>
          store.record(
            {
              operation: "api graphql",
              feature: "detail",
              host: "github.com",
              httpRequests: 1,
              outcome: "success",
              latencyMs: index,
            },
            NOW + index,
          ),
        ),
      ),
    );
    expect(store.report({ window: "24h" }, NOW + 1_000).totals.invocations).toBe(200);
  });

  it("bounds memory with a cap and a retention window", () => {
    const store = new GitHubApiUsageStore();
    for (let index = 0; index < MAX_RETAINED_EVENTS + 50; index += 1) {
      store.record(
        {
          operation: "pr view",
          feature: "detail",
          host: "github.com",
          httpRequests: 1,
          outcome: "success",
          latencyMs: 10,
        },
        NOW + index,
      );
    }
    expect(store.retainedEvents).toBeLessThanOrEqual(MAX_RETAINED_EVENTS);
    store.prune(NOW + RETENTION_MS + 3_600_000);
    expect(store.retainedEvents).toBe(0);
  });

  it("filters by host, feature, and query without touching other traffic", () => {
    const store = new GitHubApiUsageStore();
    store.record(
      {
        operation: "pr list",
        feature: "list",
        host: "github.com",
        repository: "acme/app",
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
      },
      NOW,
    );
    store.record(
      {
        operation: "pr view",
        feature: "detail",
        host: "ghe.example.com",
        repository: "acme/other",
        httpRequests: 2,
        outcome: "failure",
        latencyMs: 5,
      },
      NOW,
    );
    expect(store.report({ window: "1h", host: "ghe.example.com" }, NOW).totals.invocations).toBe(1);
    expect(store.report({ window: "1h", feature: "list" }, NOW).totals.httpRequests).toBe(1);
    expect(store.report({ window: "1h", query: "acme/other" }, NOW).totals.invocations).toBe(1);
  });
});

describe("GitHubApiUsageStore redaction", () => {
  it("drops unaddressable repositories and truncates over-long labels", () => {
    const store = new GitHubApiUsageStore();
    store.record(
      {
        operation: "x".repeat(500),
        feature: "list",
        host: "github.com",
        repository: "not a repo at all; is:pr sort:updated-desc",
        prNumber: Number.NaN,
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
      },
      NOW,
    );
    const recent = store.report({ window: "1h" }, NOW).recent[0]!;
    expect(recent.repository).toBeNull();
    expect(recent.prNumber).toBeNull();
    expect(recent.operation.length).toBeLessThanOrEqual(65);
  });

  it("never stores argv, bodies, or subprocess output — only the safe shape", () => {
    const store = new GitHubApiUsageStore();
    store.record(
      {
        operation: "pr comment",
        feature: "comment",
        host: "github.com",
        repository: "acme/app",
        prNumber: 3,
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
      },
      NOW,
    );
    const serialized = JSON.stringify(store.report({ window: "1h" }, NOW));
    expect(serialized).not.toContain("--body-file");
    expect(serialized).toContain("pr comment");
  });
});

describe("GitHubApiUsageStore quota", () => {
  it("keeps the latest observation per resource with reset and identity", () => {
    const store = new GitHubApiUsageStore();
    store.record(
      {
        operation: "api graphql",
        feature: "detail",
        host: "github.com",
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
        login: "octocat",
        rateLimits: [
          { resource: "graphql", limit: 5000, remaining: 100, used: 4900, resetAtMs: 1_000 },
        ],
      },
      NOW - 60_000,
    );
    store.observeRateLimit(
      "github.com",
      { resource: "graphql", limit: 5000, remaining: 99, used: 4901, resetAtMs: 2_000 },
      NOW,
    );
    const quota = store.report({ window: "1h" }, NOW).quota;
    expect(quota).toHaveLength(1);
    expect(quota[0]).toMatchObject({
      host: "github.com",
      resource: "graphql",
      login: "octocat",
      remaining: 99,
      resetAt: new Date(2_000).toISOString(),
      lastObservedAt: new Date(NOW).toISOString(),
    });
  });

  it("orders core budgets before the rest of the payload", () => {
    const store = new GitHubApiUsageStore();
    for (const resource of ["search", "code_search", "graphql", "core"]) {
      store.observeRateLimit(
        "github.com",
        { resource, limit: 10, remaining: 9, used: 1, resetAtMs: null },
        NOW,
      );
    }
    const resources = store.report({ window: "1h" }, NOW).quota.map((bucket) => bucket.resource);
    expect(resources).toStrictEqual(["core", "graphql", "search", "code_search"]);
  });

  it("reports unknown quota for hosts with traffic but no observations", () => {
    const store = new GitHubApiUsageStore();
    store.record(
      {
        operation: "pr list",
        feature: "list",
        host: "ghe.example.com",
        httpRequests: null,
        outcome: "success",
        latencyMs: 5,
      },
      NOW,
    );
    const quota = store.report({ window: "1h" }, NOW).quota;
    expect(quota).toHaveLength(1);
    expect(quota[0]).toMatchObject({ host: "ghe.example.com", resource: "unknown" });
    expect(quota[0]?.limit).toBeNull();
    expect(quota[0]?.remaining).toBeNull();
  });

  it("records cooldowns and clears them once elapsed", () => {
    const store = new GitHubApiUsageStore();
    store.observeCooldown("github.com", NOW + 60_000);
    store.record(
      {
        operation: "pr view",
        feature: "monitor",
        host: "github.com",
        httpRequests: 1,
        outcome: "rate-limited",
        latencyMs: 5,
      },
      NOW,
    );
    const cooling = store.report({ window: "1h" }, NOW).quota[0]?.coolingDownUntil;
    expect(cooling).toBe(new Date(NOW + 60_000).toISOString());
    expect(store.report({ window: "1h" }, NOW + 120_000).quota[0]?.coolingDownUntil).toBeNull();
  });

  it("throttles explicit refresh decisions", () => {
    const store = new GitHubApiUsageStore();
    expect(store.shouldRefresh("github.com", NOW)).toBe(true);
    store.markRefreshed("github.com", NOW);
    expect(store.shouldRefresh("github.com", NOW + QUOTA_REFRESH_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(store.shouldRefresh("github.com", NOW + QUOTA_REFRESH_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe("parseRateLimitPayload", () => {
  it("reads resource buckets and drops malformed entries", () => {
    const observations = parseRateLimitPayload(
      JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: 4999, used: 1, reset: 1_790_634_756 },
          graphql: { limit: 5000, remaining: -1, used: 0, reset: "soon" },
          search: "unavailable",
        },
        rate: { limit: 60, remaining: 59, used: 1, reset: 1_790_634_756 },
      }),
      NOW,
    );
    expect(observations).toStrictEqual([
      { resource: "core", limit: 5000, remaining: 4999, used: 1, resetAtMs: 1_790_634_756_000 },
      { resource: "graphql", limit: 5000, remaining: null, used: 0, resetAtMs: null },
    ]);
  });

  it("returns nothing for invalid payloads", () => {
    expect(parseRateLimitPayload("not json", NOW)).toStrictEqual([]);
    expect(parseRateLimitPayload(JSON.stringify({ rate: {} }), NOW)).toStrictEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

import { GitHubCliError } from "@t3tools/contracts";

import { GitHubCli } from "../git/Services/GitHubCli.ts";
import {
  GitHubApiUsage,
  GitHubApiUsageLive,
  GitHubApiUsageStore,
  loadUsageSnapshot,
  MAX_RETAINED_EVENTS,
  parseRateLimitPayload,
  QUOTA_REFRESH_MIN_INTERVAL_MS,
  RETENTION_MS,
  saveUsageSnapshot,
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

  it("throttles explicit refresh attempts per account", () => {
    const store = new GitHubApiUsageStore();
    expect(store.shouldRefresh("github.com", NOW)).toBe(true);
    store.markRefreshAttempt("github.com", NOW);
    expect(store.shouldRefresh("github.com", NOW + QUOTA_REFRESH_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(store.shouldRefresh("github.com", NOW + QUOTA_REFRESH_MIN_INTERVAL_MS)).toBe(true);
  });

  it("does not merge refresh throttles across accounts on one host", () => {
    const store = new GitHubApiUsageStore();
    store.markRefreshAttempt("github.com", NOW, "account-a");
    expect(store.shouldRefresh("github.com", NOW, "account-a")).toBe(false);
    expect(store.shouldRefresh("github.com", NOW, "account-b")).toBe(true);
    expect(store.shouldRefresh("github.com", NOW)).toBe(true);
  });

  it("partitions quota by identity instead of relabeling on switch", () => {
    const store = new GitHubApiUsageStore();
    store.setIdentity("github.com", "account-a");
    store.record(
      {
        operation: "api graphql",
        feature: "list",
        host: "github.com",
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
        rateLimits: [
          { resource: "graphql", limit: 5000, remaining: 0, used: 5000, resetAtMs: 2_000 },
        ],
      },
      NOW,
    );
    store.setIdentity("github.com", "account-b");
    const quota = store
      .report({ window: "1h" }, NOW)
      .quota.filter((bucket) => bucket.host === "github.com");
    const exhausted = quota.find((bucket) => bucket.login === "account-a");
    expect(exhausted).toMatchObject({ resource: "graphql", remaining: 0 });
    // B inherits nothing: no bucket carries B with A's exhausted numbers.
    expect(
      quota.filter((bucket) => bucket.login === "account-b" && bucket.remaining !== null),
    ).toStrictEqual([]);
  });

  it("lets the first known identity claim unattributed observations", () => {
    const store = new GitHubApiUsageStore();
    store.record(
      {
        operation: "api user",
        feature: "viewer",
        host: "github.com",
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
        rateLimits: [{ resource: "core", limit: 5000, remaining: 4999, used: 1, resetAtMs: null }],
      },
      NOW,
    );
    store.setIdentity("github.com", "account-a");
    expect(store.report({ window: "1h" }, NOW).quota).toMatchObject([
      { host: "github.com", resource: "core", login: "account-a" },
    ]);
  });

  it("never stores the unattributed sentinel as an account identity", () => {
    const store = new GitHubApiUsageStore();
    store.record(
      {
        operation: "api user",
        feature: "viewer",
        host: "github.com",
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
        rateLimits: [{ resource: "core", limit: 5000, remaining: 4999, used: 1, resetAtMs: null }],
      },
      NOW,
    );
    store.setIdentity("github.com", "account-a");
    // A later switch must not redisplay the earlier observation under B: the
    // first claim moved it to A instead of leaving an "unknown" bucket that
    // borrows whichever identity is current.
    store.setIdentity("github.com", "account-b");
    const quota = store.report({ window: "1h" }, NOW).quota;
    expect(quota).toHaveLength(1);
    expect(quota[0]).toMatchObject({
      host: "github.com",
      resource: "core",
      login: "account-a",
      remaining: 4999,
    });
  });

  it("attributes delayed observations to the identity current at receipt", () => {
    const store = new GitHubApiUsageStore();
    store.setIdentity("github.com", "account-a");
    store.setIdentity("github.com", "account-b");
    // No login carried: lands under the current identity, never merged into A.
    store.observeRateLimit(
      "github.com",
      { resource: "core", limit: 5000, remaining: 10, used: 4990, resetAtMs: null },
      NOW,
    );
    // An explicit login still reaches the previous owner.
    store.observeRateLimit(
      "github.com",
      { resource: "search", limit: 30, remaining: 29, used: 1, resetAtMs: null },
      NOW,
      "account-a",
    );
    const quota = store.report({ window: "1h" }, NOW).quota;
    expect(quota.find((bucket) => bucket.resource === "core")).toMatchObject({
      login: "account-b",
      remaining: 10,
    });
    expect(quota.find((bucket) => bucket.resource === "search")).toMatchObject({
      login: "account-a",
      remaining: 29,
    });
  });

  it("scopes cooldowns to observed resources with primary and secondary kinds", () => {
    const store = new GitHubApiUsageStore();
    store.setIdentity("github.com", "octocat");
    store.record(
      {
        operation: "api graphql",
        feature: "detail",
        host: "github.com",
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
        rateLimits: [
          { resource: "graphql", limit: 5000, remaining: 100, used: 4900, resetAtMs: null },
        ],
      },
      NOW,
    );
    store.record(
      {
        operation: "api user",
        feature: "viewer",
        host: "github.com",
        httpRequests: 1,
        outcome: "rate-limited",
        latencyMs: 5,
        rateLimits: [{ resource: "core", limit: 5000, remaining: 0, used: 5000, resetAtMs: null }],
        retryAfterAtMs: NOW + 120_000,
      },
      NOW,
    );
    const quota = store.report({ window: "1h" }, NOW).quota;
    expect(quota.find((bucket) => bucket.resource === "core")).toMatchObject({
      coolingDownUntil: new Date(NOW + 120_000).toISOString(),
      coolingDownKind: "primary",
    });
    expect(quota.find((bucket) => bucket.resource === "graphql")).toMatchObject({
      coolingDownUntil: null,
      coolingDownKind: null,
    });
  });

  it("marks trace-named secondary limits as secondary cooldowns", () => {
    const store = new GitHubApiUsageStore();
    store.setIdentity("github.com", "octocat");
    store.record(
      {
        operation: "api graphql",
        feature: "monitor",
        host: "github.com",
        repository: "acme/app",
        prNumber: 7,
        httpRequests: 1,
        outcome: "rate-limited",
        latencyMs: 5,
        rateLimits: [
          { resource: "graphql", limit: 5000, remaining: 4999, used: 1, resetAtMs: null },
        ],
        retryAfterAtMs: NOW + 60_000,
        secondaryRateLimit: true,
      },
      NOW,
    );
    expect(store.report({ window: "1h" }, NOW).quota).toMatchObject([
      {
        host: "github.com",
        resource: "graphql",
        coolingDownUntil: new Date(NOW + 60_000).toISOString(),
        coolingDownKind: "secondary",
      },
    ]);
  });
});

describe("GitHubApiUsage refreshQuota service", () => {
  const stdoutWithCore = JSON.stringify({
    resources: { core: { limit: 5000, remaining: 4999, used: 1, reset: 1_790_634_756 } },
  });

  function liveWithExecute(
    execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
    }) => Effect.Effect<{ readonly stdout: string }, GitHubCliError>,
  ) {
    return Layer.mergeAll(
      GitHubApiUsageLive,
      Layer.succeed(GitHubCli, { execute } as unknown as GitHubCli["Service"]),
    );
  }

  effectIt("fails closed with a typed error when the CLI is missing", () =>
    Effect.gen(function* () {
      const usage = yield* GitHubApiUsage;
      const error = yield* usage.refreshQuota("github.com").pipe(Effect.flip);
      expect(error._tag).toBe("GitHubApiUsageError");
      expect(error.message).toMatch(/unavailable|CLI/i);
    }).pipe(Effect.provide(GitHubApiUsageLive)),
  );

  effectIt("fails actionably on probe failure and throttles the attempt", () =>
    Effect.gen(function* () {
      let calls = 0;
      const live = liveWithExecute(() => {
        calls += 1;
        return Effect.fail(
          new GitHubCliError({ operation: "execute", detail: "boom: connection reset" }),
        );
      });
      const program = Effect.gen(function* () {
        const usage = yield* GitHubApiUsage;
        const first = yield* usage.refreshQuota("github.com").pipe(Effect.flip);
        const second = yield* usage.refreshQuota("github.com");
        return { first, second };
      }).pipe(Effect.provide(live));
      const { first, second } = yield* program;
      expect(first._tag).toBe("GitHubApiUsageError");
      expect(first.message).toContain("boom: connection reset");
      // The failed attempt counts against the throttle: no second probe.
      expect(second).toMatchObject({ host: "github.com", refreshed: false });
      expect(calls).toBe(1);
    }),
  );

  effectIt("rejects empty observations without reporting success", () =>
    Effect.gen(function* () {
      let calls = 0;
      const live = liveWithExecute(() => {
        calls += 1;
        return Effect.succeed({ stdout: JSON.stringify({ rate: {} }) });
      });
      const program = Effect.gen(function* () {
        const usage = yield* GitHubApiUsage;
        const first = yield* usage.refreshQuota("github.com").pipe(Effect.flip);
        const second = yield* usage.refreshQuota("github.com");
        return { first, second };
      }).pipe(Effect.provide(live));
      const { first, second } = yield* program;
      expect(first._tag).toBe("GitHubApiUsageError");
      expect(first.message).toMatch(/no usable quota observations/i);
      expect(second).toMatchObject({ refreshed: false });
      expect(calls).toBe(1);
    }),
  );

  effectIt("single-flights concurrent refreshes", () =>
    Effect.gen(function* () {
      let calls = 0;
      const latch = yield* Deferred.make<void>();
      const live = liveWithExecute(() =>
        Effect.gen(function* () {
          calls += 1;
          yield* Deferred.await(latch);
          return { stdout: stdoutWithCore };
        }),
      );
      const program = Effect.gen(function* () {
        const usage = yield* GitHubApiUsage;
        const first = yield* Effect.forkChild(usage.refreshQuota("github.com"));
        for (let i = 0; i < 10_000; i += 1) {
          yield* Effect.yieldNow;
          if (calls >= 1) break;
        }
        expect(calls).toBe(1);
        const second = yield* Effect.forkChild(usage.refreshQuota("github.com"));
        for (let i = 0; i < 1000; i += 1) yield* Effect.yieldNow;
        // Still one probe: the second caller shares the in-flight refresh.
        expect(calls).toBe(1);
        yield* Deferred.succeed(latch, undefined);
        const r1 = yield* Fiber.join(first);
        const r2 = yield* Fiber.join(second);
        return { r1, r2 };
      }).pipe(Effect.provide(live));
      const { r1, r2 } = yield* program;
      expect(r1).toMatchObject({ refreshed: true });
      expect(r2).toMatchObject({ refreshed: true });
      expect(calls).toBe(1);
    }),
  );
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

describe("GitHubApiUsageStore durable buckets", () => {
  function recordOutbound(
    store: GitHubApiUsageStore,
    at: number,
    extra: { feature?: string; prNumber?: number | null; repository?: string | null } = {},
  ): void {
    store.record(
      {
        operation: "api graphql",
        feature: extra.feature ?? "monitor",
        host: "github.com",
        repository: extra.repository === undefined ? "acme/app" : extra.repository,
        prNumber: extra.prNumber === undefined ? 7 : extra.prNumber,
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
      },
      at,
    );
  }

  it("retains exact window totals past the event cap", () => {
    const store = new GitHubApiUsageStore(NOW - 2 * 3_600_000);
    for (let index = 0; index < 1100; index += 1) {
      recordOutbound(store, NOW - 3_500_000 + index * 1000);
    }
    const report = store.report({ window: "1h" }, NOW);
    expect(report.totals.httpRequests).toBe(1100);
    expect(report.totals.invocations).toBe(1100);
    expect(report.totals.httpRequestsUnknown).toBe(false);
    expect(report.coverage).toMatchObject({ complete: true });
    expect(report.byPullRequest).toMatchObject([
      { key: "github.com/acme/app#7", invocations: 1100, httpRequests: 1100 },
    ]);
  });

  it("stops cache hits from evicting outbound evidence", () => {
    const store = new GitHubApiUsageStore(NOW - 2 * 3_600_000);
    for (let index = 0; index < 1000; index += 1) {
      store.recordCacheHit({ feature: "list", host: "github.com" }, NOW - 3_000_000 + index);
    }
    for (let index = 0; index < 50; index += 1) {
      recordOutbound(store, NOW - 60_000 + index);
    }
    const report = store.report({ window: "1h" }, NOW);
    expect(report.totals.httpRequests).toBe(50);
    expect(report.totals.invocations).toBe(50);
    expect(report.totals.servedFromCache).toBe(1000);
  });

  it("survives restarts via snapshot round-trip", () => {
    const store = new GitHubApiUsageStore(NOW - 7_200_000);
    store.setIdentity("github.com", "octocat");
    for (let index = 0; index < 1050; index += 1) {
      recordOutbound(store, NOW - 3_500_000 + index * 1000);
    }
    store.record(
      {
        operation: "api user",
        feature: "viewer",
        host: "github.com",
        httpRequests: 1,
        outcome: "rate-limited",
        latencyMs: 5,
        rateLimits: [{ resource: "core", limit: 5000, remaining: 0, used: 5000, resetAtMs: null }],
        retryAfterAtMs: NOW + 120_000,
      },
      NOW - 1000,
    );
    const before = store.report({ window: "24h" }, NOW);
    const revived = new GitHubApiUsageStore();
    expect(revived.restore(store.snapshot(), NOW)).toBe(true);
    const after = revived.report({ window: "24h" }, NOW);
    expect(after.totals).toStrictEqual(before.totals);
    expect(after.byPullRequest).toStrictEqual(before.byPullRequest);
    expect(after.quota).toStrictEqual(before.quota);
    expect(after.coverage).toStrictEqual(before.coverage);
    // The bounded recent ring is session detail and restarts empty.
    expect(after.recent).toStrictEqual([]);
  });

  it("rejects corrupt snapshots and starts fresh", () => {
    const store = new GitHubApiUsageStore();
    expect(store.restore(null, NOW)).toBe(false);
    expect(store.restore({ version: 999 }, NOW)).toBe(false);
    expect(store.restore("nope", NOW)).toBe(false);
    const report = store.report({ window: "1h" }, NOW);
    expect(report.totals.invocations).toBe(0);
    expect(report.coverage.complete).toBe(true);
  });

  effectIt("round-trips snapshots through the key-value store", () =>
    Effect.gen(function* () {
      const store = new GitHubApiUsageStore(NOW - 7_200_000);
      store.setIdentity("github.com", "octocat");
      store.record(
        {
          operation: "api graphql",
          feature: "monitor",
          host: "github.com",
          repository: "acme/app",
          prNumber: 7,
          httpRequests: 2,
          outcome: "success",
          latencyMs: 5,
          rateLimits: [
            { resource: "graphql", limit: 5000, remaining: 100, used: 4900, resetAtMs: null },
          ],
        },
        NOW - 60_000,
      );
      yield* saveUsageSnapshot(store);
      const revived = new GitHubApiUsageStore();
      yield* loadUsageSnapshot(revived, NOW);
      const before = store.report({ window: "24h" }, NOW);
      const after = revived.report({ window: "24h" }, NOW);
      expect(after.totals).toStrictEqual(before.totals);
      expect(after.byPullRequest).toStrictEqual(before.byPullRequest);
      expect(after.quota).toStrictEqual(before.quota);
      expect(after.coverage).toStrictEqual(before.coverage);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it("rolls buckets over minute boundaries", () => {
    const store = new GitHubApiUsageStore(NOW - 3_600_000);
    recordOutbound(store, NOW + 1000);
    recordOutbound(store, NOW + 61_000);
    expect(store.snapshot().buckets).toHaveLength(2);
  });

  it("exposes incomplete coverage with start time", () => {
    const store = new GitHubApiUsageStore(NOW);
    store.record(
      {
        operation: "pr list",
        feature: "list",
        host: "github.com",
        httpRequests: 1,
        outcome: "success",
        latencyMs: 5,
      },
      NOW + 1000,
    );
    const wide = store.report({ window: "24h" }, NOW + 2000);
    expect(wide.coverage.complete).toBe(false);
    expect(wide.coverage.startAt).toBe(new Date(NOW).toISOString());
    // A window fully inside coverage is complete.
    expect(store.report({ window: "5m" }, NOW + 600_000).coverage.complete).toBe(true);
  });

  it("marks filtered drilldowns incomplete past ring eviction", () => {
    const store = new GitHubApiUsageStore(NOW - 2 * 3_600_000);
    for (let index = 0; index < 1100; index += 1) {
      recordOutbound(store, NOW - 3_500_000 + index * 1000, { feature: "monitor" });
    }
    const unfiltered = store.report({ window: "1h" }, NOW);
    expect(unfiltered.coverage.complete).toBe(true);
    expect(unfiltered.totals.httpRequests).toBe(1100);
    const filtered = store.report({ window: "1h", feature: "monitor" }, NOW);
    expect(filtered.coverage.complete).toBe(false);
    expect(filtered.totals.httpRequests).toBeLessThan(1100);
  });

  it("bounds dimension cardinality with overflow", () => {
    const store = new GitHubApiUsageStore(NOW - 3_600_000);
    for (let index = 0; index < 40; index += 1) {
      recordOutbound(store, NOW + 1000, { repository: `acme/app-${index}`, prNumber: null });
    }
    const bucket = store.snapshot().buckets[0];
    expect(bucket).toBeDefined();
    const keys = (bucket?.byRepo ?? []).map(([key]) => key);
    expect(keys.length).toBeLessThanOrEqual(33);
    expect(keys).toContain("~other");
    expect(store.report({ window: "1h" }, NOW + 2000).totals.invocations).toBe(40);
  });
});

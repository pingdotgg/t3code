import type { PullRequestCheck, PullRequestDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePullRequestDetailChecks } from "./pullRequestChecks.ts";

const detail = (overrides: Partial<PullRequestDetail> = {}): PullRequestDetail =>
  ({ title: "Cache the title", state: "open", checks: [], ...overrides }) as PullRequestDetail;

describe("resolvePullRequestDetailChecks", () => {
  it("uses fresh checks for detail counts without replacing other PR fields", () => {
    const pending = (name: string): PullRequestCheck => ({
      name,
      status: "pending",
      url: null,
      description: null,
    });
    const original = detail({ checks: [pending("build"), pending("test")] });
    const checks = [pending("build"), { ...pending("test"), status: "success" as const }];
    expect(resolvePullRequestDetailChecks(original, { state: "closed", checks }, true)).toEqual({
      ...original,
      state: "closed",
      checks,
    });
    expect(resolvePullRequestDetailChecks(original, { state: "closed", checks }, false)).toBe(
      original,
    );
    expect(resolvePullRequestDetailChecks(original, null, true)).toBe(original);
    expect(resolvePullRequestDetailChecks(null, { state: "closed", checks }, true)).toBeNull();
  });

  it("keeps newer checks when an older cached detail arrives later", () => {
    const pending: PullRequestCheck = {
      name: "build",
      status: "pending",
      url: null,
      description: null,
    };
    const cached = detail({ observedAt: 1_000, checks: [pending] });
    const checks = {
      state: "open" as const,
      checks: [{ ...pending, status: "success" as const }],
      observedAt: 2_000,
    };
    const resolved = resolvePullRequestDetailChecks(cached, checks, false);
    expect(resolved?.checks).toEqual(checks.checks);
    expect(resolved?.observedAt).toBe(1_000);
    expect(
      resolvePullRequestDetailChecks(cached, { state: checks.state, checks: checks.checks }, true)
        ?.checks,
    ).toEqual(checks.checks);
    const refreshed = detail({ observedAt: 3_000, checks: [pending] });
    expect(resolvePullRequestDetailChecks(refreshed, checks, true)).toBe(refreshed);
  });

  it("keeps merged details settled while applying newer checks", () => {
    const merged = detail({ state: "merged", observedAt: 1_000 });
    const checks = [{ name: "build", status: "success" as const, url: null, description: null }];
    expect(
      resolvePullRequestDetailChecks(merged, { state: "open", observedAt: 2_000, checks }, true),
    ).toEqual({ ...merged, checks });
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  buildGitHubApiBaseUrl,
  COPILOT_USAGE_CACHE_TTL_MS,
  createCopilotUsageReader,
  fetchCopilotUsageSummary,
} from "./copilotUsage";

describe("buildGitHubApiBaseUrl", () => {
  it("uses the public GitHub API host by default", () => {
    expect(buildGitHubApiBaseUrl(null)).toBe("https://api.github.com");
    expect(buildGitHubApiBaseUrl("github.com")).toBe("https://api.github.com");
  });

  it("derives enterprise API hosts from the configured Copilot host", () => {
    expect(buildGitHubApiBaseUrl("https://example.ghe.com")).toBe(
      "https://api.example.ghe.com",
    );
    expect(buildGitHubApiBaseUrl("https://example.ghe.com:8443")).toBe(
      "https://api.example.ghe.com:8443",
    );
  });
});

describe("fetchCopilotUsageSummary", () => {
  it("parses Copilot premium request quota from the private user endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          login: "octocat",
          copilot_plan: "pro_plus",
          quota_reset_date_utc: "2026-03-31T00:00:00.000Z",
          quota_snapshots: {
            premium_interactions: {
              entitlement: 1500,
              remaining: 1321,
              percent_remaining: 88.1,
              overage_count: 0,
              overage_permitted: true,
              unlimited: false,
            },
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const result = await fetchCopilotUsageSummary({
      fetchImpl,
      now: () => new Date("2026-03-07T12:00:00.000Z"),
      readCliConfig: async () => ({ host: "https://github.com", login: "octocat" }),
      resolveGitHubToken: async () => "ghu_test_token",
    });

    expect(result).toEqual({
      status: "available",
      source: "copilot_internal_user",
      fetchedAt: "2026-03-07T12:00:00.000Z",
      login: "octocat",
      plan: "pro_plus",
      entitlement: 1500,
      remaining: 1321,
      used: 179,
      percentRemaining: 88.1,
      overagePermitted: true,
      overageCount: 0,
      unlimited: false,
      resetAt: "2026-03-31T00:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "token ghu_test_token",
          "X-GitHub-Api-Version": "2025-04-01",
        }),
      }),
    );
  });

  it("returns a requires-auth status when no GitHub token is available", async () => {
    const result = await fetchCopilotUsageSummary({
      now: () => new Date("2026-03-07T12:00:00.000Z"),
      readCliConfig: async () => ({ host: "https://github.com", login: "octocat" }),
      resolveGitHubToken: async () => null,
    });

    expect(result).toEqual({
      status: "requires-auth",
      fetchedAt: "2026-03-07T12:00:00.000Z",
      message:
        "GitHub Copilot quota is unavailable because no reusable GitHub token was found. Run `gh auth login` or set GH_TOKEN / COPILOT_GITHUB_TOKEN.",
    });
  });
});

describe("createCopilotUsageReader", () => {
  it("caches responses for a short period", async () => {
    let nowMs = Date.parse("2026-03-07T12:00:00.000Z");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          login: "octocat",
          quota_reset_date_utc: "2026-03-31T00:00:00.000Z",
          quota_snapshots: {
            premium_interactions: {
              entitlement: 300,
              remaining: 200,
              overage_count: 0,
              overage_permitted: true,
              unlimited: false,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const readUsage = createCopilotUsageReader({
      fetchImpl,
      now: () => new Date(nowMs),
      readCliConfig: async () => ({ host: "https://github.com", login: "octocat" }),
      resolveGitHubToken: async () => "ghu_test_token",
    });

    await expect(readUsage()).resolves.toMatchObject({ status: "available", remaining: 200 });
    await expect(readUsage()).resolves.toMatchObject({ status: "available", remaining: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowMs += COPILOT_USAGE_CACHE_TTL_MS + 1;

    await expect(readUsage()).resolves.toMatchObject({ status: "available", remaining: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

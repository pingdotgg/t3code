import { describe, expect, it } from "vite-plus/test";

import {
  fetchGrokUsageLimits,
  grokAuthFilePath,
  grokBillingResponseToLimits,
  GROK_BILLING_URL,
  readGrokAuthToken,
} from "./grokUsageLimits.ts";

const checkedAt = "2026-09-16T10:00:00.000Z";
const periodEnd = "2026-09-17T00:00:00Z";
const periodStart = "2026-09-10T00:00:00Z";

const weeklyWindow = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 37.5,
  windowDurationMins: 10_080,
  resetsAt: "2026-09-17T00:00:00.000Z",
} as const;

const modernBody = {
  config: {
    creditUsagePercent: 37.5,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: periodStart,
      end: periodEnd,
    },
    billingPeriodStart: periodStart,
    billingPeriodEnd: periodEnd,
    isUnifiedBillingUser: true,
    onDemandCap: { val: 20 },
    onDemandUsed: { val: 4 },
    prepaidBalance: { val: 12.5 },
  },
};

describe("readGrokAuthToken", () => {
  it("reads the single object value that carries a string key", () => {
    expect(readGrokAuthToken({ "acct-1": { key: "xai-secret", email: "a@x.ai" } })).toBe(
      "xai-secret",
    );
    expect(readGrokAuthToken({ "acct-1": { email: "a@x.ai" } })).toBeUndefined();
    expect(
      readGrokAuthToken({
        a: { key: "one" },
        b: { key: "two" },
      }),
    ).toBeUndefined();
  });
});

describe("grokBillingResponseToLimits", () => {
  it("maps a modern weekly billing response onto one window", () => {
    expect(grokBillingResponseToLimits(modernBody, checkedAt)).toEqual({
      checkedAt,
      windows: [weeklyWindow],
    });
  });

  it("treats an omitted zero creditUsagePercent as 0 % when the period is present", () => {
    expect(
      grokBillingResponseToLimits(
        {
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: periodStart,
              end: periodEnd,
            },
          },
        },
        checkedAt,
      ),
    ).toEqual({
      checkedAt,
      windows: [{ ...weeklyWindow, usedPercent: 0 }],
    });
  });

  it("is unsupported when the current period is missing", () => {
    expect(grokBillingResponseToLimits({ config: { creditUsagePercent: 12 } }, checkedAt)).toEqual({
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
  });
});

describe("fetchGrokUsageLimits", () => {
  const homeDir = "/tmp/grok-usage-limits-home";
  const token = "xai-test-token";
  const authJson = JSON.stringify({ default: { key: token } });

  const readFile = async (path: string) => {
    expect(path).toBe(grokAuthFilePath(homeDir));
    return authJson;
  };

  it("maps a modern HTTP billing response", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const limits = await fetchGrokUsageLimits({
      checkedAt,
      cliVersion: "1.2.3",
      homeDir,
      readFile,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify(modernBody), { status: 200 });
      },
    });
    expect(limits).toEqual({ checkedAt, windows: [weeklyWindow] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(GROK_BILLING_URL);
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("User-Agent")).toBe("grok/1.2.3");
  });

  it("maps a proto3 zero-omitted HTTP response as 0 %", async () => {
    const limits = await fetchGrokUsageLimits({
      checkedAt,
      cliVersion: "1.2.3",
      homeDir,
      readFile,
      fetch: async () =>
        new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                start: periodStart,
                end: periodEnd,
              },
            },
          }),
          { status: 200 },
        ),
    });
    expect(limits.windows).toEqual([{ ...weeklyWindow, usedPercent: 0 }]);
  });

  it("is unsupported when the HTTP body has no current period", async () => {
    const limits = await fetchGrokUsageLimits({
      checkedAt,
      cliVersion: "1.2.3",
      homeDir,
      readFile,
      fetch: async () => new Response(JSON.stringify({ config: {} }), { status: 200 }),
    });
    expect(limits).toEqual({
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
  });

  it("is probeFailed on malformed JSON and does not throw", async () => {
    const limits = await fetchGrokUsageLimits({
      checkedAt,
      cliVersion: "1.2.3",
      homeDir,
      readFile,
      fetch: async () => new Response("not-json{", { status: 200 }),
    });
    expect(limits).toEqual({
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
  });

  it("is probeFailed on an HTTP error and does not throw", async () => {
    const limits = await fetchGrokUsageLimits({
      checkedAt,
      cliVersion: "1.2.3",
      homeDir,
      readFile,
      fetch: async () => new Response("nope", { status: 401 }),
    });
    expect(limits).toEqual({
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
  });
});

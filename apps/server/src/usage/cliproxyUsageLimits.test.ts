import { describe, expect, it } from "vite-plus/test";

import { accountEmailFromAuthFile, cliproxyStatusToAccounts } from "./cliproxyUsageLimits.ts";

const checkedAt = "2026-09-03T22:00:00.000Z";

describe("cliproxyStatusToAccounts", () => {
  // Trimmed from a live `quota-scheduler/status`: one Claude account with a
  // hard-limited Fable bucket, one Codex account whose 5h window is unknown.
  it("maps each pooled account onto the windows the provider drivers use", () => {
    const accounts = cliproxyStatusToAccounts(
      {
        accounts: {
          "claude-jmarminge@gmail.com.json": {
            provider: "claude",
            fetched_at: "2026-09-03T15:06:07-07:00",
            five_hour: { hard_limited: false, known: true, used_percent: 0 },
            seven_day: {
              hard_limited: false,
              known: true,
              reset_at: "2026-09-07T07:59:59Z",
              used_percent: 51,
            },
            fable: {
              hard_limited: true,
              known: true,
              reset_at: "2026-09-07T07:59:59Z",
              used_percent: 100,
            },
          },
          "codex-7f42123a-jmarminge@gmail.com-pro.json": {
            provider: "codex",
            plan: "pro",
            fetched_at: "2026-09-03T15:07:07-07:00",
            five_hour: { hard_limited: false, known: false, used_percent: 0 },
            weekly: {
              hard_limited: false,
              known: true,
              reset_at: "2026-09-06T19:52:53-07:00",
              used_percent: 12,
            },
          },
          "xai-someone@example.com.json": { provider: "xai" },
        },
      },
      checkedAt,
    );

    expect(accounts).toEqual([
      {
        id: "claude-jmarminge@gmail.com.json",
        driver: "claudeAgent",
        email: "jmarminge@gmail.com",
        plan: "Claude Subscription",
        usageLimits: {
          checkedAt: "2026-09-03T22:06:07.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 0,
              windowDurationMins: 300,
            },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 51,
              windowDurationMins: 10080,
              resetsAt: "2026-09-07T07:59:59.000Z",
            },
            {
              id: "seven_day_fable",
              kind: "weekly",
              label: "Weekly · Fable",
              usedPercent: 100,
              windowDurationMins: 10080,
              resetsAt: "2026-09-07T07:59:59.000Z",
            },
          ],
        },
      },
      {
        id: "codex-7f42123a-jmarminge@gmail.com-pro.json",
        driver: "codex",
        email: "jmarminge@gmail.com",
        plan: "ChatGPT Pro 20x Subscription",
        usageLimits: {
          checkedAt: "2026-09-03T22:07:07.000Z",
          windows: [
            {
              id: "secondary",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 12,
              windowDurationMins: 10080,
              resetsAt: "2026-09-07T02:52:53.000Z",
            },
          ],
        },
      },
    ]);
  });
});

describe("accountEmailFromAuthFile", () => {
  it("pulls the email out of the hub's auth file names", () => {
    expect(accountEmailFromAuthFile("claude-julius@ping.gg.json")).toBe("julius@ping.gg");
    expect(accountEmailFromAuthFile("codex-e413dce6-julius@ping.gg-pro.json")).toBe(
      "julius@ping.gg",
    );
    expect(accountEmailFromAuthFile("claude-first-last@example.com.json")).toBe(
      "first-last@example.com",
    );
    expect(accountEmailFromAuthFile("mystery.json")).toBeUndefined();
  });
});

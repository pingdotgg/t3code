import { describe, expect, it } from "vite-plus/test";

import { detectClaudeUsageLimit, detectCodexUsageLimit } from "./UsageLimit.ts";

describe("UsageLimit", () => {
  it("detects Claude result usage-limit messages with reset timestamps", () => {
    const detail = detectClaudeUsageLimit({
      message: "Claude AI usage limit reached|1783549200",
      source: "result",
    });

    expect(detail?.kind).toBe("usage-limit");
    expect(detail?.provider).toBe("claudeAgent");
    expect(detail?.resetsAtEpochSeconds).toBe(1783549200);
  });

  it("ignores Claude allowed warning rate-limit telemetry", () => {
    const detail = detectClaudeUsageLimit({
      source: "rate_limit_event",
      raw: {
        status: "allowed_warning",
        primary: { usedPercent: 90, resetsAt: 1783549200 },
      },
    });

    expect(detail).toBeUndefined();
  });

  it("detects Claude rejected rate-limit telemetry with reset timestamps", () => {
    const detail = detectClaudeUsageLimit({
      source: "rate_limit_event",
      raw: {
        status: "rejected",
        primary: { usedPercent: 100, resetsAt: 1783549200 },
      },
    });

    expect(detail?.kind).toBe("usage-limit");
    expect(detail?.resetsAtEpochSeconds).toBe(1783549200);
  });

  it("detects Codex structured turn usage-limit errors", () => {
    const detail = detectCodexUsageLimit({
      source: "turn/completed",
      message: "Usage limit exceeded",
      codexErrorInfo: "usageLimitExceeded",
    });

    expect(detail?.kind).toBe("usage-limit");
    expect(detail?.provider).toBe("codex");
  });

  it("detects Codex 429 rate-limit errors when the message confirms rate limiting", () => {
    const detail = detectCodexUsageLimit({
      source: "error",
      message: "429 Too Many Requests",
      codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } },
    });

    expect(detail?.kind).toBe("usage-limit");
    expect(detail?.provider).toBe("codex");
  });

  it("extracts Codex reset timestamps from reached rate-limit snapshots", () => {
    const detail = detectCodexUsageLimit({
      source: "account/rateLimits/updated",
      raw: {
        rateLimits: {
          rateLimitReachedType: "workspace_owner_usage_limit_reached",
          primary: { usedPercent: 100, resetsAt: 1783549200 },
          secondary: { usedPercent: 12, resetsAt: 1783722000 },
        },
      },
    });

    expect(detail?.kind).toBe("usage-limit");
    expect(detail?.resetsAtEpochSeconds).toBe(1783549200);
  });

  it("extracts ISO reset timestamps from Codex rate-limit snapshots", () => {
    const detail = detectCodexUsageLimit({
      source: "account/rateLimits/updated",
      raw: {
        rateLimits: {
          rateLimitReachedType: "workspace_member_usage_limit_reached",
          primary: { usedPercent: 100, resetsAt: "2026-07-08T18:00:00.000Z" },
        },
      },
    });

    expect(detail?.resetsAt).toBe("2026-07-08T18:00:00.000Z");
  });
});

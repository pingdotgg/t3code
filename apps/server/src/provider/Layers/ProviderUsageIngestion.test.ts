import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeRuntimeUsageEvent } from "./ProviderUsageIngestion.ts";

const UPDATED_AT = "2026-08-09T12:00:00.000Z";

/**
 * Build the event exactly as an adapter emits it. This is the seam the
 * normalizers are actually called across, and it is where a mismatch between
 * "what the SDK sends" and "what the normalizer reads" hides — testing the
 * normalizers alone with hand-written payloads cannot catch it.
 */
const usageEvent = (
  provider: string,
  rateLimits: unknown,
): Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }> =>
  ({
    type: "account.rate-limits.updated",
    eventId: EventId.make("11111111-1111-4111-8111-111111111111"),
    provider: ProviderDriverKind.make(provider),
    threadId: ThreadId.make("11111111-1111-4111-8111-111111111112"),
    createdAt: UPDATED_AT,
    payload: { rateLimits },
  }) as Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }>;

describe("normalizeRuntimeUsageEvent", () => {
  it("reads the Claude adapter's verbatim SDK rate_limit_event", () => {
    // ClaudeAdapter forwards the whole SDKRateLimitEvent as `rateLimits`.
    const usage = normalizeRuntimeUsageEvent(
      usageEvent("claudeAgent", {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 76,
          resetsAt: 1_786_000_000,
        },
        uuid: "11111111-1111-4111-8111-111111111113",
        session_id: "session-1",
      }),
      UPDATED_AT,
    );

    expect(usage).not.toBeNull();
    expect(usage?.windows).toEqual([
      {
        id: "session",
        label: "Session",
        usedPercent: 76,
        resetsAt: "2026-08-06T07:06:40.000Z",
      },
    ]);
  });

  it("reads the Codex adapter's verbatim rateLimits notification", () => {
    const usage = normalizeRuntimeUsageEvent(
      usageEvent("codex", {
        rateLimits: {
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_786_000_000 },
          secondary: { usedPercent: 70, windowDurationMins: 10_080 },
        },
      }),
      UPDATED_AT,
    );

    expect(usage?.windows.map((window) => window.id)).toEqual(["codex-primary", "codex-secondary"]);
  });

  it("drops events from drivers that report no usage", () => {
    expect(
      normalizeRuntimeUsageEvent(usageEvent("cursor", { anything: true }), UPDATED_AT),
    ).toBeNull();
  });

  it("drops a Claude event whose bucket type has no meter", () => {
    expect(
      normalizeRuntimeUsageEvent(
        usageEvent("claudeAgent", {
          rate_limit_info: { status: "allowed", rateLimitType: "overage", utilization: 12 },
        }),
        UPDATED_AT,
      ),
    ).toBeNull();
  });
});

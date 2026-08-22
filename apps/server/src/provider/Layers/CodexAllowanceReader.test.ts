import { describe, expect, it } from "@effect/vitest";
import * as CodexSchema from "effect-codex-app-server/schema";

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { mapCodexRateLimits, mapCodexRateLimitsUpdate } from "./CodexAllowanceReader.ts";

const instanceId = ProviderInstanceId.make("codex");

describe("mapCodexRateLimits", () => {
  it("preserves native windows, percentages, reset timestamps, credits, and spend controls", () => {
    const allowance = mapCodexRateLimits({
      instanceId,
      response: {
        rateLimits: {
          primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_786_463_400 },
          secondary: { usedPercent: 4, windowDurationMins: null, resetsAt: null },
          credits: { balance: "12.50", hasCredits: true, unlimited: false },
          individualLimit: {
            limit: "100",
            remainingPercent: 90,
            resetsAt: 1_786_463_400,
            used: "10",
          },
          limitId: "codex",
          limitName: "Codex",
          planType: "plus",
          spendControlReached: true,
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      } satisfies CodexSchema.V2GetAccountRateLimitsResponse,
    });

    expect(allowance).toEqual({
      provider: "codex",
      instanceId,
      status: "available",
      windows: [
        {
          scope: "primary",
          usedPercent: 23,
          windowDurationMins: 300,
          resetsAt: "2026-08-11T15:50:00.000Z",
        },
        {
          scope: "secondary",
          usedPercent: 4,
          windowDurationMins: null,
          resetsAt: null,
        },
      ],
      credits: { balance: "12.50", hasCredits: true, unlimited: false },
      spendingControl: {
        reached: true,
        limit: "100",
        remainingPercent: 90,
        resetsAt: "2026-08-11T15:50:00.000Z",
        used: "10",
      },
    });
    expect(allowance).not.toHaveProperty("planType");
    expect(allowance).not.toHaveProperty("limitName");
  });

  it("preserves a native spend-control state when detail fields are absent", () => {
    const allowance = mapCodexRateLimits({
      instanceId,
      response: {
        rateLimits: { spendControlReached: false },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      } satisfies CodexSchema.V2GetAccountRateLimitsResponse,
    });

    expect(allowance).toEqual({
      provider: "codex",
      instanceId,
      status: "available",
      windows: [],
      spendingControl: { reached: false },
    });
  });

  it("does not invent an available allowance when Codex reports no fields", () => {
    const allowance = mapCodexRateLimits({
      instanceId,
      response: {
        rateLimits: {},
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      } satisfies CodexSchema.V2GetAccountRateLimitsResponse,
    });

    expect(allowance).toEqual({
      provider: "codex",
      instanceId,
      status: "unavailable",
      windows: [],
      message: "Codex did not provide subscription usage limits.",
    });
  });

  it("maps sparse native rate-limit events for server-side folding", () => {
    const event = {
      type: "account.rate-limits.updated",
      eventId: EventId.make("codex-rate-limit-event"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      threadId: ThreadId.make("thread-rate-limit"),
      createdAt: "2026-08-11T12:00:00.000Z",
      payload: {
        rateLimits: {
          primary: { usedPercent: 37 },
        },
      },
    } satisfies Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }>;

    expect(mapCodexRateLimitsUpdate({ instanceId, event })).toEqual({
      provider: "codex",
      instanceId,
      status: "available",
      windows: [{ scope: "primary", usedPercent: 37 }],
    });
  });

  it("does not treat unavailable nullable rolling fields as clears", () => {
    const event = {
      type: "account.rate-limits.updated",
      eventId: EventId.make("codex-nullable-rate-limit-event"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      threadId: ThreadId.make("thread-nullable-rate-limit"),
      createdAt: "2026-08-11T12:00:00.000Z",
      payload: {
        rateLimits: {
          primary: { usedPercent: 37, windowDurationMins: null, resetsAt: null },
          credits: { balance: null, hasCredits: true, unlimited: false },
        },
      },
    } satisfies Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }>;

    expect(mapCodexRateLimitsUpdate({ instanceId, event })).toEqual({
      provider: "codex",
      instanceId,
      status: "available",
      windows: [{ scope: "primary", usedPercent: 37 }],
      credits: { hasCredits: true, unlimited: false },
    });
  });
});

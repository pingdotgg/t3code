import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import {
  deriveKnownContextWindowSnapshot,
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("uses the selected Devin model catalog limit before ACP usage arrives", () => {
    const instanceId = ProviderInstanceId.make("devin");
    const snapshot = deriveKnownContextWindowSnapshot({
      selection: { instanceId, model: "glm-5-2" },
      providers: [
        {
          instanceId,
          driver: ProviderDriverKind.make("devin"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-03-23T00:00:00.000Z",
          models: [
            {
              slug: "glm-5-2",
              name: "GLM-5.2",
              isCustom: false,
              capabilities: { optionDescriptors: [] },
              contextWindowTokens: 200_000,
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ],
      updatedAt: "2026-03-23T00:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 200_000,
      remainingTokens: 200_000,
      usedPercentage: 0,
      model: "glm-5-2",
    });
  });

  it("uses the selected context-window option instead of the catalog maximum", () => {
    const instanceId = ProviderInstanceId.make("devin");
    const snapshot = deriveKnownContextWindowSnapshot({
      selection: {
        instanceId,
        model: "glm-5-2",
        options: [{ id: "contextWindow", value: "200k" }],
      },
      providers: [
        {
          instanceId,
          driver: ProviderDriverKind.make("devin"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-03-23T00:00:00.000Z",
          models: [
            {
              slug: "glm-5-2",
              name: "GLM-5.2",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "contextWindow",
                    label: "Context window",
                    type: "select",
                    options: [
                      { id: "200k", label: "200K" },
                      { id: "1m", label: "1M" },
                    ],
                  },
                ],
              },
              contextWindowTokens: 1_000_000,
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ],
      updatedAt: "2026-03-23T00:00:00.000Z",
    });

    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(200_000);
  });

  it("does not invent a context meter when the catalog has no limit", () => {
    const instanceId = ProviderInstanceId.make("devin");
    expect(
      deriveKnownContextWindowSnapshot({
        selection: { instanceId, model: "custom" },
        providers: [],
        updatedAt: "2026-03-23T00:00:00.000Z",
      }),
    ).toBeNull();
  });
});

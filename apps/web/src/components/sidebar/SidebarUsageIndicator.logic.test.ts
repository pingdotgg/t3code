import { describe, expect, it } from "vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import {
  deriveSidebarUsageProviderRows,
  getSidebarUsageSummaryRow,
} from "./SidebarUsageIndicator.logic";

function makeActivity(
  id: string,
  payload: Record<string, unknown>,
  createdAt: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt,
  };
}

describe("SidebarUsageIndicator.logic", () => {
  it("groups latest context usage by Codex and Claude driver", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [
        {
          instanceId: ProviderInstanceId.make("codex_work"),
          driverKind: ProviderDriverKind.make("codex"),
        },
        {
          instanceId: ProviderInstanceId.make("claude_personal"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      ],
      threads: [
        {
          id: "thread-codex-old",
          title: "Old Codex",
          modelSelectionInstanceId: ProviderInstanceId.make("codex_work"),
          activities: [
            makeActivity(
              "activity-codex-old",
              { usedTokens: 10_000, maxTokens: 100_000 },
              "2026-05-01T00:00:00.000Z",
            ),
          ],
        },
        {
          id: "thread-codex-new",
          title: "New Codex",
          modelSelectionInstanceId: ProviderInstanceId.make("codex_work"),
          activities: [
            makeActivity(
              "activity-codex-new",
              { usedTokens: 20_000, maxTokens: 100_000 },
              "2026-05-02T00:00:00.000Z",
            ),
          ],
        },
        {
          id: "thread-claude",
          title: "Claude",
          modelSelectionInstanceId: ProviderInstanceId.make("claude_personal"),
          activities: [
            makeActivity(
              "activity-claude",
              { usedTokens: 50_000, maxTokens: 200_000 },
              "2026-05-03T00:00:00.000Z",
            ),
          ],
        },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.label).toBe("Codex");
    expect(rows[0]?.threadId).toBe("thread-codex-new");
    expect(rows[0]?.usage?.usedTokens).toBe(20_000);
    expect(rows[1]?.label).toBe("Claude");
    expect(rows[1]?.threadId).toBe("thread-claude");
    expect(rows[1]?.usage?.usedTokens).toBe(50_000);
    expect(getSidebarUsageSummaryRow(rows)?.label).toBe("Claude");
  });

  it("falls back to default driver instance ids when provider snapshots are unavailable", () => {
    const rows = deriveSidebarUsageProviderRows({
      providerInstances: [],
      threads: [
        {
          id: "thread-codex",
          title: "Codex",
          modelSelectionInstanceId: ProviderInstanceId.make("codex"),
          activities: [
            makeActivity("activity-codex", { usedTokens: 12_000 }, "2026-05-01T00:00:00.000Z"),
          ],
        },
      ],
    });

    expect(rows[0]?.usage?.usedTokens).toBe(12_000);
    expect(rows[1]?.usage).toBeNull();
  });
});

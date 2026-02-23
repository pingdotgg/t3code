import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  derivePendingApprovals,
  deriveTurnDiffFilesFromUnifiedDiff,
  deriveWorkLogEntries,
} from "./session-logic";

function makeActivity(
  overrides: Partial<OrchestrationThreadActivity>,
): OrchestrationThreadActivity {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    label: overrides.label ?? "Tool call",
    tone: overrides.tone ?? "tool",
    ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
    ...(overrides.turnId !== undefined ? { turnId: overrides.turnId } : {}),
    ...(overrides.requestId !== undefined ? { requestId: overrides.requestId } : {}),
    ...(overrides.requestKind !== undefined ? { requestKind: overrides.requestKind } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Command approval requested",
        detail: "bun run lint",
        tone: "tool",
        requestId: "req-1",
        requestKind: "command",
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "Approval resolved",
        tone: "info",
        requestId: "req-2",
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        label: "File-change approval requested",
        tone: "tool",
        requestId: "req-2",
        requestKind: "file-change",
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });
});

describe("deriveWorkLogEntries", () => {
  it("returns entries in chronological order", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        label: "Tool call complete",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "Tool call",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-start", "tool-complete"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", label: "Tool call" }),
      makeActivity({ id: "turn-2", turnId: "turn-2", label: "Tool call complete" }),
      makeActivity({ id: "no-turn", label: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, "turn-2");
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "Command run complete",
        tone: "tool",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });
});

describe("deriveTurnDiffFilesFromUnifiedDiff", () => {
  it("extracts per-file +/- counts from unified diff", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+extra",
      "diff --git a/b.txt b/b.txt",
      "index 333..444 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -2,2 +2 @@",
      "-x",
      "-y",
      "+z",
    ].join("\n");

    expect(deriveTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "b.txt", additions: 1, deletions: 2 },
    ]);
  });
});

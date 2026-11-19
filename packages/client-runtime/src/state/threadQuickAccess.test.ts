import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import { selectThreadQuickAccess } from "./threadQuickAccess.ts";

function shell(
  id: string,
  updatedAt: string,
  status: EnvironmentThreadShell["runtime"] extends infer Runtime
    ? Runtime extends { status: infer Status }
      ? Status
      : never
    : never = "idle",
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-a",
    title: id,
    updatedAt,
    createdAt: updatedAt,
    archivedAt: null,
    deletedAt: null,
    runtime:
      status === "idle"
        ? null
        : {
            status,
            activeRunId: null,
            providerInstanceId: "provider",
            providerName: null,
            lastError: null,
            updatedAt,
          },
    latestRun: null,
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    hasActionableProposedPlan: false,
    interactionMode: "default",
  } as EnvironmentThreadShell;
}

describe("selectThreadQuickAccess", () => {
  it("places working threads before newer idle threads", () => {
    const selected = selectThreadQuickAccess([
      shell("newest-idle", "2026-11-19T12:00:00Z"),
      shell("working", "2026-11-19T10:00:00Z", "running"),
      shell("older-idle", "2026-11-19T09:00:00Z"),
    ]);

    expect(selected.map(({ thread, working }) => [thread.id, working])).toEqual([
      ["working", true],
      ["newest-idle", false],
      ["older-idle", false],
    ]);
  });

  it("excludes archived and deleted threads and respects the limit", () => {
    const archived = { ...shell("archived", "2026-11-19T13:00:00Z"), archivedAt: "now" };
    const deleted = { ...shell("deleted", "2026-11-19T14:00:00Z"), deletedAt: "now" };
    const selected = selectThreadQuickAccess(
      [archived, deleted, shell("b", "2026-11-19T12:00:00Z"), shell("a", "2026-11-19T11:00:00Z")],
      1,
    );

    expect(selected.map(({ thread }) => thread.id)).toEqual(["b"]);
  });
});

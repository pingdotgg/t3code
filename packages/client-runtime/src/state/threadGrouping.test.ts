import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  crewMemberSurfaces,
  foldedCrewSummary,
  groupThreads,
  type GroupableThread,
  visibleCrew,
} from "./threadGrouping.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(
  id: string,
  options: {
    readonly under?: string;
    readonly working?: boolean;
    readonly needsInput?: boolean;
    readonly mutedBot?: boolean;
    readonly environment?: string;
    readonly settled?: boolean;
  } = {},
): GroupableThread {
  return {
    id: ThreadId.make(id),
    environmentId:
      options.environment === undefined ? environmentId : EnvironmentId.make(options.environment),
    groupedUnderThreadId: options.under === undefined ? null : ThreadId.make(options.under),
    botConfig:
      options.mutedBot === undefined ? null : { enabled: true, muteChildren: options.mutedBot },
    settledOverride: options.settled === true ? "settled" : null,
    hasPendingApprovals: false,
    hasPendingUserInput: options.needsInput === true,
    pendingSubagentRequest: null,
    runtime:
      options.working === true
        ? {
            status: "running",
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: null,
            lastError: null,
            updatedAt: "2026-11-20T00:00:00.000Z",
          }
        : null,
  };
}

const ids = (threads: ReadonlyArray<GroupableThread>) => threads.map((thread) => thread.id);

describe("groupThreads", () => {
  it("nests crew under a listed leader and keeps orphans, released and other environments listed", () => {
    const grouped = groupThreads([
      thread("bot"),
      thread("a", { under: "bot" }),
      thread("orphan", { under: "archived-leader" }),
      thread("elsewhere", { under: "bot", environment: "environment-2" }),
      thread("nested", { under: "a" }),
      thread("settled-bot", { settled: true }),
      thread("released", { under: "settled-bot" }),
    ]);
    expect(ids(grouped.listed)).toEqual([
      "bot",
      "orphan",
      "elsewhere",
      "nested",
      "settled-bot",
      "released",
    ]);
    expect(ids(grouped.groupByLeaderKey.get("environment-1:bot")!.crew)).toEqual(["a"]);
  });

  it("marks a group live when crew works, so a settled leader is lifted into Active", () => {
    const grouped = groupThreads([thread("bot"), thread("a", { under: "bot", working: true })]);
    expect(grouped.groupByLeaderKey.get("environment-1:bot")!.live).toBe(true);
    const idle = groupThreads([thread("bot"), thread("a", { under: "bot" })]);
    expect(idle.groupByLeaderKey.get("environment-1:bot")!.live).toBe(false);
  });
});

describe("folded crew", () => {
  const grouped = groupThreads([
    thread("bot", { mutedBot: true }),
    thread("idle", { under: "bot" }),
    thread("working", { under: "bot", working: true }),
    thread("asking", { under: "bot", needsInput: true }),
  ]);
  const group = grouped.groupByLeaderKey.get("environment-1:bot")!;

  it("summarizes the crew and keeps a member needing input visible", () => {
    expect(foldedCrewSummary(group)).toEqual({
      count: 3,
      statuses: ["needs-input", "working", "idle"],
      alwaysVisible: [group.crew[2]],
    });
    expect(ids(visibleCrew(group, true))).toEqual(["asking"]);
    expect(ids(visibleCrew(group, false))).toEqual(["idle", "working", "asking"]);
  });

  it("mutes crew noise except members that need input", () => {
    expect(group.muted).toBe(true);
    expect(group.crew.map((member) => crewMemberSurfaces(member, group))).toEqual([
      false,
      false,
      true,
    ]);
  });
});

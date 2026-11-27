import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  workerSurfaces,
  foldedWorkersSummary,
  groupBots,
  groupThreads,
  type GroupableThread,
  visibleWorkers,
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
  it("nests workers under a listed leader and keeps orphans, released and other environments listed", () => {
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
    expect(ids(grouped.groupByLeaderKey.get("environment-1:bot")!.workers)).toEqual(["a"]);
  });

  it("marks a group live when a worker works, so a settled leader is lifted into Active", () => {
    const grouped = groupThreads([thread("bot"), thread("a", { under: "bot", working: true })]);
    expect(grouped.groupByLeaderKey.get("environment-1:bot")!.live).toBe(true);
    const idle = groupThreads([thread("bot"), thread("a", { under: "bot" })]);
    expect(idle.groupByLeaderKey.get("environment-1:bot")!.live).toBe(false);
  });
});

describe("folded workers", () => {
  const grouped = groupThreads([
    thread("bot", { mutedBot: true }),
    thread("idle", { under: "bot" }),
    thread("working", { under: "bot", working: true }),
    thread("asking", { under: "bot", needsInput: true }),
  ]);
  const group = grouped.groupByLeaderKey.get("environment-1:bot")!;

  it("summarizes the workers and keeps a worker needing input visible", () => {
    expect(foldedWorkersSummary(group)).toEqual({
      count: 3,
      statuses: ["needs-input", "working", "idle"],
      alwaysVisible: [group.workers[2]],
    });
    expect(ids(visibleWorkers(group, true))).toEqual(["asking"]);
    expect(ids(visibleWorkers(group, false))).toEqual(["idle", "working", "asking"]);
  });

  it("mutes worker updates except workers that need input", () => {
    expect(group.muted).toBe(true);
    expect(group.workers.map((member) => workerSurfaces(member, group))).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe("groupBots", () => {
  it("lists unarchived Bots oldest first and sorts their workers, settled or not, onto the board", () => {
    const at = (
      base: GroupableThread,
      createdAt: string,
      archived = false,
    ): GroupableThread & { readonly createdAt: string; readonly archivedAt: string | null } => ({
      ...base,
      createdAt,
      archivedAt: archived ? createdAt : null,
    });
    const groups = groupBots([
      at(thread("newer-bot", { mutedBot: false }), "2026-11-02T00:00:00.000Z"),
      at(thread("bot", { mutedBot: false, settled: true }), "2026-11-01T00:00:00.000Z"),
      at(thread("archived-bot", { mutedBot: false }), "2026-11-01T00:00:00.000Z", true),
      at(thread("asking", { under: "bot", needsInput: true }), "2026-11-03T00:00:00.000Z"),
      at(thread("busy", { under: "bot", working: true }), "2026-11-03T00:00:00.000Z"),
      at(thread("finished", { under: "bot", settled: true }), "2026-11-03T00:00:00.000Z"),
      at(thread("gone", { under: "bot" }), "2026-11-03T00:00:00.000Z", true),
      at(thread("freed", { under: "archived-bot" }), "2026-11-03T00:00:00.000Z"),
      at(thread("plain"), "2026-11-03T00:00:00.000Z"),
    ]);
    expect(ids(groups.bots)).toEqual(["bot", "newer-bot"]);
    const board = groups.boardByBotKey.get("environment-1:bot")!;
    expect([ids(board.needsYou), ids(board.working), ids(board.done)]).toEqual([
      ["asking"],
      ["busy"],
      ["finished"],
    ]);
    expect([...groups.botAndWorkerKeys].toSorted()).toEqual(
      ["bot", "newer-bot", "asking", "busy", "finished", "gone"]
        .map((id) => `environment-1:${id}`)
        .toSorted(),
    );
  });
});

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarDndBoardEntries,
  findSidebarDndBoardThreadSection,
  findSortedSidebarDndDropTarget,
  moveSidebarDndBoardThread,
  type SidebarDndBoardEntry,
} from "./Sidebar.dnd.board";
import {
  resolveSidebarDndAction,
  resolveSidebarDndPreviewVariant,
  sidebarThreadKey,
  type SidebarDndAction,
  type SidebarDndPreviewVariant,
  type SidebarDndSection,
} from "./Sidebar.dnd.logic";

describe("resolveSidebarDndAction", () => {
  it.each([
    ["pinned", "pinned", "reorder-pinned"],
    ["pinned", "regular", "unpin"],
    ["pinned", "snoozed", "snooze"],
    ["pinned", "settled", "settle"],
    ["regular", "pinned", "pin"],
    ["regular", "regular", "noop"],
    ["regular", "snoozed", "snooze"],
    ["regular", "settled", "settle"],
    ["snoozed", "pinned", "pin"],
    ["snoozed", "regular", "unsnooze"],
    ["snoozed", "snoozed", "noop"],
    ["snoozed", "settled", "settle"],
    ["settled", "pinned", "pin"],
    ["settled", "regular", "unsettle"],
    ["settled", "snoozed", "snooze"],
    ["settled", "settled", "noop"],
  ] satisfies ReadonlyArray<readonly [SidebarDndSection, SidebarDndSection, SidebarDndAction]>)(
    "%s -> %s resolves to %s",
    (source, destination, expected) => {
      expect(resolveSidebarDndAction({ source, destination })).toBe(expected);
    },
  );
});

describe("resolveSidebarDndPreviewVariant", () => {
  it.each([
    ["settled", "pinned", "card"],
    ["settled", "regular", "card"],
    ["pinned", "snoozed", "slim"],
    ["pinned", "settled", "slim"],
    ["pinned", null, "card"],
    ["regular", null, "card"],
    ["snoozed", null, "slim"],
    ["settled", null, "slim"],
  ] satisfies ReadonlyArray<
    readonly [SidebarDndSection, SidebarDndSection | null, SidebarDndPreviewVariant]
  >)("%s -> %s uses %s", (source, destination, expected) => {
    expect(resolveSidebarDndPreviewVariant({ source, destination })).toBe(expected);
  });
});

describe("sidebar DnD board placement", () => {
  const pinned = makeThread("pinned");
  const regular = makeThread("regular");
  const snoozed = makeThread("snoozed");
  const settled = makeThread("settled");
  const entries = buildSidebarDndBoardEntries({
    pinnedThreads: [pinned],
    regularThreads: [regular],
    snoozedThreads: [snoozed],
    settledThreads: [settled],
  });

  it("moves a row to the requested thread edge", () => {
    const moved = moveSidebarDndBoardThread({
      entries,
      threadKey: sidebarThreadKey(regular),
      target: {
        section: "pinned",
        threadKey: sidebarThreadKey(pinned),
        edge: "after",
      },
    });

    expect(findSidebarDndBoardThreadSection(moved, sidebarThreadKey(regular))).toBe("pinned");
    expect(threadKeys(moved)).toEqual([
      sidebarThreadKey(pinned),
      sidebarThreadKey(regular),
      sidebarThreadKey(snoozed),
      sidebarThreadKey(settled),
    ]);
  });

  it("moves a row immediately after an empty section boundary", () => {
    const emptySettledEntries = buildSidebarDndBoardEntries({
      pinnedThreads: [pinned],
      regularThreads: [regular],
      snoozedThreads: [snoozed],
      settledThreads: [],
    });
    const moved = moveSidebarDndBoardThread({
      entries: emptySettledEntries,
      threadKey: sidebarThreadKey(regular),
      target: { section: "settled", threadKey: null, edge: null },
    });

    expect(findSidebarDndBoardThreadSection(moved, sidebarThreadKey(regular))).toBe("settled");
    expect(threadKeys(moved)).toEqual([
      sidebarThreadKey(pinned),
      sidebarThreadKey(snoozed),
      sidebarThreadKey(regular),
    ]);
  });
});

describe("findSortedSidebarDndDropTarget", () => {
  const first = makeThread("first");
  const source = makeThread("source");
  const last = makeThread("last");

  it("targets the next sorted row when one follows the source", () => {
    expect(
      findSortedSidebarDndDropTarget({
        section: "regular",
        sourceThreadKey: sidebarThreadKey(source),
        threads: [first, source, last],
      }),
    ).toEqual({ section: "regular", threadKey: sidebarThreadKey(last), edge: "before" });
  });

  it("targets after the previous row when the source sorts last", () => {
    expect(
      findSortedSidebarDndDropTarget({
        section: "snoozed",
        sourceThreadKey: sidebarThreadKey(source),
        threads: [first, source],
      }),
    ).toEqual({ section: "snoozed", threadKey: sidebarThreadKey(first), edge: "after" });
  });

  it("targets the section boundary when the source is alone or missing", () => {
    expect(
      findSortedSidebarDndDropTarget({
        section: "settled",
        sourceThreadKey: sidebarThreadKey(source),
        threads: [source],
      }),
    ).toEqual({ section: "settled", threadKey: null, edge: null });
    expect(
      findSortedSidebarDndDropTarget({
        section: "settled",
        sourceThreadKey: sidebarThreadKey(source),
        threads: [first],
      }),
    ).toEqual({ section: "settled", threadKey: null, edge: null });
  });
});

function threadKeys(entries: readonly SidebarDndBoardEntry[]): string[] {
  return entries.flatMap((entry) => (entry.kind === "thread" ? [entry.id] : []));
}

function makeThread(id: string): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return {
    environmentId: EnvironmentId.make("environment-local"),
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

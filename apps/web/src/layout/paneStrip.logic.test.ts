import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";
import type { LayoutTab } from "./layoutModel";
import {
  arrangePaneStrip,
  drawnPaneTabIds,
  isDrawnInWorkingGroup,
  paneDropIndex,
  paneDropMarker,
  resolvePaneStripThreadState,
  resolvePaneStripThreadStates,
  splitPaneStrip,
  workingTabGroup,
  type PaneStripDropItem,
  type PaneStripItem,
  type PaneStripSegment,
  type PaneStripThread,
  type PaneStripThreadState,
  type PaneTabGroupDefinition,
} from "./paneStrip.logic";

const environmentId = EnvironmentId.make("local");

function chatTab(label: string): LayoutTab {
  const [id = "", groupId] = label.split("@");
  return {
    id,
    content: {
      kind: "chat",
      target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(id)) },
    },
    ...(groupId ? { groupId } : {}),
  };
}

const draftTab: LayoutTab = {
  id: "draft",
  content: { kind: "chat", target: { kind: "draft", draftId: "draft-1" as DraftId } },
};
const terminalTab: LayoutTab = {
  id: "terminal",
  content: {
    kind: "surface",
    threadRef: scopeThreadRef(environmentId, ThreadId.make("a")),
    surfaceId: "thread-terminal",
  },
};

const ready: PaneStripThread = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  interactionMode: "default",
  latestRun: null,
  runtime: null,
  settledOverride: null,
};
const running: PaneStripThread = {
  ...ready,
  runtime: {
    status: "running",
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("resolvePaneStripThreadState", () => {
  it.each<readonly [string, PaneStripThread, PaneStripThreadState]>([
    ["a ready thread is in the inbox", ready, "inbox"],
    ["a running thread is working", running, "working"],
    [
      "a monitoring (idle runtime) thread is working",
      { ...running, runtime: { ...running.runtime!, status: "idle" } },
      "working",
    ],
    ["a thread awaiting approval needs you", { ...running, hasPendingApprovals: true }, "inbox"],
    ["a thread awaiting input needs you", { ...running, hasPendingUserInput: true }, "inbox"],
    ["a settled thread is settled", { ...ready, settledOverride: "settled" }, "settled"],
    [
      "a settled thread is settled even while working",
      { ...running, settledOverride: "settled" },
      "settled",
    ],
    ["an unsettled thread is in the inbox", { ...ready, settledOverride: "active" }, "inbox"],
    [
      "a snoozed thread is settled",
      {
        ...running,
        snoozedAt: "2026-01-01T00:00:00.000Z",
        snoozedUntil: "2026-01-02T00:00:00.000Z",
      },
      "settled",
    ],
    [
      "a thread whose snooze ended is back",
      { ...ready, snoozedAt: "2025-12-30T00:00:00.000Z", snoozedUntil: "2025-12-31T00:00:00.000Z" },
      "inbox",
    ],
  ])("%s", (_name, thread, expected) => {
    expect(resolvePaneStripThreadState(thread, "2026-01-01T12:00:00.000Z")).toBe(expected);
  });

  it("names when the earliest snooze ends, and wakes the thread then", () => {
    const snoozed = (until: string) => ({
      ...ready,
      snoozedAt: "2026-01-01T00:00:00.000Z",
      snoozedUntil: until,
    });
    const threads = [
      ready,
      snoozed("2026-01-03T00:00:00.000Z"),
      snoozed("2026-01-02T00:00:00.000Z"),
      null,
    ];
    const wake = Date.parse("2026-01-02T00:00:00.000Z");
    expect(resolvePaneStripThreadStates(threads, wake - 1)).toEqual({
      states: ["inbox", "settled", "settled", null],
      wakeAt: wake,
    });
    expect(resolvePaneStripThreadStates(threads, wake)).toEqual({
      states: ["inbox", "settled", "inbox", null],
      wakeAt: Date.parse("2026-01-03T00:00:00.000Z"),
    });
  });
});

const group = (id: string, options: { collapsed?: boolean } = {}): PaneTabGroupDefinition => ({
  id,
  title: id,
  color: "grey",
  collapsed: options.collapsed ?? false,
  rule: null,
});

/** A tab as its id; a group as `title(count)[drawn tab ids]`. */
function drawn(segments: readonly PaneStripSegment[]): string[] {
  return segments.map((segment) =>
    segment.kind === "tab"
      ? segment.tab.id
      : `${segment.group.title}(${segment.count})[${segment.tabs.map((tab) => tab.id).join(" ")}]`,
  );
}

describe("arrangePaneStrip", () => {
  const states: Record<string, PaneStripThreadState> = {
    i: "inbox",
    i2: "inbox",
    w: "working",
    w2: "working",
    s: "settled",
  };
  it.each<{
    case: string;
    tabs: readonly LayoutTab[];
    active: string;
    groups?: readonly PaneTabGroupDefinition[];
    hideSettled?: boolean;
    expected: string[];
  }>([
    {
      case: "without groups every tab stands alone, in order",
      tabs: ["i", "w", "s"].map(chatTab),
      active: "i",
      expected: ["i", "w", "s"],
    },
    {
      case: "working chats gather in Working at the strip's start",
      tabs: ["w", "i", "w2", "i2"].map(chatTab),
      active: "i",
      groups: [workingTabGroup(false)],
      expected: ["Working(2)[w w2]", "i", "i2"],
    },
    {
      case: "a collapsed Working group draws only its chip",
      tabs: ["w", "i", "w2"].map(chatTab),
      active: "i",
      groups: [workingTabGroup(true)],
      expected: ["Working(2)[]", "i"],
    },
    {
      case: "the shown chat stays in its place while working",
      tabs: ["w", "i", "w2"].map(chatTab),
      active: "w",
      groups: [workingTabGroup(true)],
      expected: ["Working(1)[]", "w", "i"],
    },
    {
      case: "the shown chat joins an open Working group",
      tabs: ["w", "i", "w2"].map(chatTab),
      active: "w",
      groups: [workingTabGroup(false)],
      expected: ["Working(2)[w w2]", "i"],
    },
    {
      case: "Working forms only around chats that are not shown",
      tabs: ["i", "w"].map(chatTab),
      active: "w",
      groups: [workingTabGroup(true)],
      expected: ["i", "w"],
    },
    {
      case: "a settled chat leaves the strip while settled tabs hide",
      tabs: ["i", "s", "i2"].map(chatTab),
      active: "i",
      hideSettled: true,
      expected: ["i", "i2"],
    },
    {
      case: "the shown chat stays even when settled",
      tabs: ["i", "s"].map(chatTab),
      active: "s",
      hideSettled: true,
      expected: ["i", "s"],
    },
    {
      case: "a chat whose shell has not loaded, a draft and a surface stand alone",
      tabs: [chatTab("unknown"), draftTab, terminalTab],
      active: "draft",
      groups: [workingTabGroup(false)],
      hideSettled: true,
      expected: ["unknown", "draft", "terminal"],
    },
    {
      case: "a stored group sits at its first tab",
      tabs: ["i", "i2@g", "w@g", "s"].map(chatTab),
      active: "i",
      groups: [group("g")],
      expected: ["i", "g(2)[i2 w]", "s"],
    },
    {
      case: "a working chat in a stored group stays there",
      tabs: ["i", "w@g", "w2"].map(chatTab),
      active: "i",
      groups: [group("g"), workingTabGroup(false)],
      expected: ["Working(1)[w2]", "i", "g(1)[w]"],
    },
    {
      case: "a collapsed group draws only its chip",
      tabs: ["i", "i2@g", "w@g"].map(chatTab),
      active: "i",
      groups: [group("g", { collapsed: true })],
      expected: ["i", "g(2)[]"],
    },
    {
      case: "a collapsed group still draws the shown tab",
      tabs: ["i", "i2@g", "w@g"].map(chatTab),
      active: "w",
      groups: [group("g", { collapsed: true })],
      expected: ["i", "g(2)[w]"],
    },
    {
      case: "a group counts only the tabs the strip would draw",
      tabs: ["i", "s@g", "i2@g"].map(chatTab),
      active: "i",
      groups: [group("g")],
      hideSettled: true,
      expected: ["i", "g(1)[i2]"],
    },
    {
      case: "a group whose tabs all left the strip draws nothing",
      tabs: ["i", "s@g"].map(chatTab),
      active: "i",
      groups: [group("g")],
      hideSettled: true,
      expected: ["i"],
    },
    {
      case: "a tab naming a group the pane lacks stands alone",
      tabs: ["i", "i2@gone"].map(chatTab),
      active: "i",
      expected: ["i", "i2"],
    },
  ])("$case", ({ tabs, active, groups = [], hideSettled = false, expected }) => {
    expect(
      drawn(
        arrangePaneStrip({
          tabs,
          activeTabId: active,
          groups,
          threadStateOf: (ref) => states[ref.threadId] ?? null,
          hideSettled,
        }),
      ),
    ).toEqual(expected);
  });
});

describe("splitPaneStrip", () => {
  it("puts chips and their tabs around the shown tab, colored by group", () => {
    const label = (item: PaneStripItem) =>
      item.kind === "chip" ? `[${item.group.title}]` : `${item.tab.id}:${item.group?.color ?? "-"}`;
    const segments = arrangePaneStrip({
      tabs: ["a", "b@g", "c@g", "d", "w"].map(chatTab),
      activeTabId: "b",
      groups: [group("g"), workingTabGroup(false)],
      threadStateOf: (ref) => (ref.threadId === "w" ? "working" : "inbox"),
      hideSettled: false,
    });
    const { before, after, activeColor, activeGroupId } = splitPaneStrip(segments, "b");
    expect({
      before: before.map(label),
      after: after.map(label),
      activeColor,
      activeGroupId,
    }).toEqual({
      before: ["[Working]", "w:blue", "a:-", "[g]"],
      after: ["c:grey", "d:-"],
      activeColor: "grey",
      activeGroupId: "g",
    });
  });
});

describe("drawnPaneTabIds", () => {
  it("leaves out hidden, collapsed and closed Working tabs, but keeps the shown one", () => {
    const segments = arrangePaneStrip({
      tabs: ["a", "s", "b@g", "c@g", "w", "d@h", "e@h"].map(chatTab),
      activeTabId: "c",
      groups: [group("g", { collapsed: true }), group("h"), workingTabGroup(true)],
      threadStateOf: (ref) =>
        ref.threadId === "w" ? "working" : ref.threadId === "s" ? "settled" : "inbox",
      hideSettled: true,
    });
    expect(drawnPaneTabIds(segments)).toEqual(["a", "c", "d", "e"]);
  });

  it("steps through an open Working group with the shown chat in it", () => {
    const segments = arrangePaneStrip({
      tabs: ["w", "i", "w2"].map(chatTab),
      activeTabId: "w",
      groups: [workingTabGroup(false)],
      threadStateOf: (ref) => (ref.threadId === "i" ? "inbox" : "working"),
      hideSettled: false,
    });
    expect(drawnPaneTabIds(segments)).toEqual(["w", "w2", "i"]);
  });
});

describe("paneDropIndex", () => {
  // Pane order a w s b@g c@g d; the strip draws [Working] w a [g] d, g collapsed, s hidden.
  const tabs = ["a", "w", "s", "b@g", "c@g", "d"].map(chatTab);
  const groups = [group("g", { collapsed: true })];
  const strip: PaneStripDropItem[] = [
    { id: "working", chip: true },
    { id: "w", group: "working" },
    { id: "a" },
    { id: "g", chip: true },
    { id: "d" },
  ];
  it.each<{
    case: string;
    drawn: readonly PaneStripDropItem[];
    before: number;
    index: number;
    marker: number;
    pane?: { tabs: LayoutTab[]; groups: PaneTabGroupDefinition[] };
  }>([
    {
      case: "on the Working chip, before the first tab past Working",
      drawn: strip,
      before: 0,
      index: 0,
      marker: 2,
    },
    {
      case: "on a Working member, before the first tab past Working",
      drawn: strip,
      before: 1,
      index: 0,
      marker: 2,
    },
    {
      case: "right after Working, before the first tab past it",
      drawn: strip,
      before: 2,
      index: 0,
      marker: 2,
    },
    {
      case: "left of a collapsed chip, right after the tab before it",
      drawn: strip,
      before: 3,
      index: 1,
      marker: 3,
    },
    {
      case: "right of a collapsed chip, past its last member",
      drawn: strip,
      before: 4,
      index: 5,
      marker: 4,
    },
    { case: "past the strip's end", drawn: strip, before: -1, index: 6, marker: 5 },
    {
      case: "right of a collapsed chip with its shown tab, past its last member",
      drawn: [{ id: "a" }, { id: "g", chip: true }, { id: "c" }, { id: "d" }],
      before: 2,
      index: 5,
      marker: 3,
    },
    {
      case: "past a collapsed group that ends the strip",
      drawn: [{ id: "a" }, { id: "g", chip: true }],
      before: -1,
      index: 6,
      marker: 2,
    },
    {
      // Pane b@g w c with a dragged and w in an open Working group.
      case: "right after a group's last tab, past the group",
      drawn: [
        { id: "working", chip: true },
        { id: "w", group: "working" },
        { id: "g", chip: true },
        { id: "b" },
        { id: "c" },
      ],
      before: 4,
      index: 1,
      marker: 4,
      pane: { tabs: ["b@g", "w", "c"].map(chatTab), groups: [group("g")] },
    },
    {
      case: "past an open group's last drawn tab, past its hidden ones",
      drawn: [{ id: "x" }, { id: "g", chip: true }, { id: "a" }, { id: "b" }, { id: "y" }],
      before: 4,
      index: 4,
      marker: 4,
      pane: { tabs: ["x", "a@g", "b@g", "s@g", "y"].map(chatTab), groups: [group("g")] },
    },
    {
      case: "between an open group's drawn tabs, inside it",
      drawn: [{ id: "x" }, { id: "g", chip: true }, { id: "a" }, { id: "b" }, { id: "y" }],
      before: 3,
      index: 2,
      marker: 3,
      pane: { tabs: ["x", "a@g", "b@g", "s@g", "y"].map(chatTab), groups: [group("g")] },
    },
    {
      case: "a group's lone tab dropped on its own chip stays put",
      drawn: [{ id: "x" }, { id: "h", chip: true }, { id: "y" }],
      before: 2,
      index: 1,
      marker: 1,
      pane: { tabs: ["x", "y"].map(chatTab), groups: [group("h")] },
    },
    {
      case: "a group's lone tab dropped on its own chip at the strip's start stays put",
      drawn: [{ id: "h", chip: true }, { id: "y" }],
      before: 0,
      index: 0,
      marker: 0,
      pane: { tabs: ["y"].map(chatTab), groups: [group("h")] },
    },
  ])("lands $case", ({ drawn, before, index, marker, pane = { tabs, groups } }) => {
    expect(paneDropIndex({ ...pane, drawn, before })).toBe(index);
    expect(paneDropMarker({ ...pane, drawn, index })).toBe(marker);
  });
  it.each([
    ["w", true],
    ["a", false],
    ["d", false],
  ])("a drag of %s from inside Working is not a reorder: %s", (id, expected) => {
    expect(isDrawnInWorkingGroup(strip, id)).toBe(expected);
  });
  it("matches the drawn index when every tab is drawn", () => {
    const plain = ["a", "b", "c"].map(chatTab);
    const drawn = plain.map((tab) => ({ id: tab.id }));
    for (const before of [0, 1, 2, -1]) {
      expect(paneDropIndex({ tabs: plain, groups: [], drawn, before })).toBe(
        before === -1 ? 3 : before,
      );
    }
  });
});

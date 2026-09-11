import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { useChatPaneDragStore } from "./chatPaneDragStore";
import { collectLeaves } from "./chatPanes.logic";
import { commitChatPaneDrop, openInSplit, useChatPanesStore } from "./chatPanesStore";
import type { RightPanelSurface } from "./rightPanelStore";

const thread = (id: string) => scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(id));
const threadIds = (index: number) =>
  collectLeaves(useChatPanesStore.getState().groups[index]!).map((leaf) => leaf.threadRef.threadId);

beforeEach(() => {
  useChatPanesStore.setState({ groups: [], focusedPaneId: null });
  useChatPaneDragStore.getState().end();
});

it("starts a second group when a thread is dropped on a thread outside the first", () => {
  openInSplit(thread("a"), { threadRef: thread("b") });
  const first = useChatPanesStore.getState().groups[0]!;
  useChatPaneDragStore.getState().start({ content: { threadRef: thread("d") }, title: "D" });
  useChatPaneDragStore.setState({ target: { paneId: "route", zone: "right" } });
  expect(commitChatPaneDrop(thread("c"))).toEqual(thread("d"));
  expect(useChatPanesStore.getState().groups[0]).toBe(first);
  expect(threadIds(1)).toEqual(["c", "d"]);
});

it("moves a pane into another group and drops the group it emptied", () => {
  openInSplit(thread("a"), { threadRef: thread("b") });
  openInSplit(thread("c"), { threadRef: thread("d") });
  const [first, second] = useChatPanesStore.getState().groups;
  const b = collectLeaves(first!)[1]!;
  const d = collectLeaves(second!)[1]!;
  useChatPanesStore.getState().movePane(b.id, d.id, "bottom");
  expect(useChatPanesStore.getState().groups).toHaveLength(1);
  expect(threadIds(0)).toEqual(["c", "d", "b"]);
});

it("returns the remaining thread when the focused member closes", () => {
  openInSplit(thread("a"), { threadRef: thread("b") });
  const root = useChatPanesStore.getState().groups[0]!;
  const focused = collectLeaves(root).find(
    (leaf) => leaf.id === useChatPanesStore.getState().focusedPaneId,
  )!;
  expect(useChatPanesStore.getState().closePane(focused.id)).toEqual(thread("a"));
  expect(useChatPanesStore.getState().groups).toEqual([]);
});

it("drops a pane on the layout edge to span the whole group", () => {
  openInSplit(thread("a"), { threadRef: thread("b") });
  const root = useChatPanesStore.getState().groups[0]!;
  useChatPanesStore.getState().dropContent(root.id, "bottom", { threadRef: thread("c") });
  const next = useChatPanesStore.getState().groups[0]!;
  expect(next.kind === "split" && next.direction).toBe("vertical");
  expect(next.kind === "split" && next.first).toBe(root);
  expect(threadIds(0)).toEqual(["a", "b", "c"]);
});

it("opens a panel pane beside the thread and closes it by surface", () => {
  const diff = { id: "diff", kind: "diff" } as const;
  expect(openInSplit(thread("a"), { threadRef: thread("a"), surface: diff })).toBe(true);
  expect(openInSplit(thread("a"), { threadRef: thread("a"), surface: diff })).toBe(false);
  expect(threadIds(0)).toEqual(["a", "a"]);
  useChatPanesStore.getState().closeSurface(thread("a"), "diff");
  expect(useChatPanesStore.getState().groups).toEqual([]);
});

it("rewrites a panel pane's surface and follows the survivor when it closes", () => {
  const terminal: RightPanelSurface = {
    id: "terminal:t1",
    kind: "terminal",
    resourceId: "t1",
    terminalIds: ["t1"],
    activeTerminalId: "t1",
  };
  openInSplit(thread("a"), { threadRef: thread("a"), surface: terminal });
  const store = useChatPanesStore.getState();
  store.updateSurface(thread("a"), terminal.id, (surface) =>
    surface.kind === "terminal" ? { ...surface, terminalIds: ["t1", "t2"] } : surface,
  );
  const leaf = collectLeaves(useChatPanesStore.getState().groups[0]!)[1]!;
  expect(leaf.surface?.kind === "terminal" && leaf.surface.terminalIds).toEqual(["t1", "t2"]);
  expect(store.closeSurface(thread("a"), terminal.id)).toEqual(thread("a"));
  expect(useChatPanesStore.getState().groups).toEqual([]);
});

it("drops a group left with only panel panes", () => {
  const diff = { id: "diff", kind: "diff" } as const;
  openInSplit(thread("a"), { threadRef: thread("a"), surface: diff });
  useChatPanesStore.getState().closeThread(thread("a"));
  expect(useChatPanesStore.getState().groups).toEqual([]);
});

it.each([-1, 1.1, 0.5])("validates persisted pane ratio %s", async (ratio) => {
  openInSplit(thread("a"), { threadRef: thread("b") });
  const root = useChatPanesStore.getState().groups[0]!;
  const groups = [{ ...root, ratio }];
  useChatPanesStore.setState({ groups: [], focusedPaneId: null });
  const { storage, name } = useChatPanesStore.persist.getOptions();
  await storage!.setItem(name!, { state: { groups, focusedPaneId: null } });
  await useChatPanesStore.persist.rehydrate();
  expect(useChatPanesStore.getState().groups).toEqual(ratio === 0.5 ? groups : []);
});

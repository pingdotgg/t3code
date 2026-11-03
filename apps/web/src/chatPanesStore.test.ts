import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  closeChatPane,
  commitChatPanes,
  openChatSplit,
  resolveChatPanes,
  SINGLE_CHAT_PANE_LAYOUT,
  swapChatPanes,
  type ChatPanesLayout,
} from "./chatPanesStore";
import { DraftId } from "./composerDraftStore";
import type { ThreadRouteTarget } from "./threadRoutes";

const thread = (id: string): ThreadRouteTarget => ({
  kind: "server",
  threadRef: scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(id)),
});
const draft = (id: string): ThreadRouteTarget => ({ kind: "draft", draftId: DraftId.make(id) });

function paneIds() {
  let next = 0;
  return () => `pane-${++next}`;
}

function split(left: ThreadRouteTarget, right: ThreadRouteTarget): ChatPanesLayout {
  return openChatSplit(SINGLE_CHAT_PANE_LAYOUT, {
    routeTarget: left,
    target: right,
    createPaneId: paneIds(),
  });
}

const shown = (layout: ChatPanesLayout, route: ThreadRouteTarget) =>
  resolveChatPanes(layout, route).map((pane) => ({
    id: pane.id,
    target: pane.target.kind === "server" ? pane.target.threadRef.threadId : pane.target.draftId,
    active: pane.active,
  }));

describe("chat panes", () => {
  it("opens beside the routed thread and keeps the routed pane focused", () => {
    const layout = split(thread("a"), thread("b"));
    expect(shown(layout, thread("a"))).toEqual([
      { id: "pane-1", target: "a", active: true },
      { id: "pane-2", target: "b", active: false },
    ]);
  });

  it("focuses the pane whose thread the route lands on, leaving the other pane as it was", () => {
    const layout = split(thread("a"), thread("b"));
    expect(shown(layout, thread("b"))).toEqual([
      { id: "pane-1", target: "a", active: false },
      { id: "pane-2", target: "b", active: true },
    ]);
  });

  it("retargets only the focused pane when the route moves to another thread", () => {
    const focusedRight = commitChatPanes(split(thread("a"), thread("b")), thread("b"));
    expect(shown(focusedRight, thread("c"))).toEqual([
      { id: "pane-1", target: "a", active: false },
      { id: "pane-2", target: "c", active: true },
    ]);
    const committed = commitChatPanes(focusedRight, thread("c"));
    expect(shown(committed, thread("a"))).toEqual([
      { id: "pane-1", target: "a", active: true },
      { id: "pane-2", target: "c", active: false },
    ]);
  });

  it("commits nothing when the route already matches the layout", () => {
    const layout = split(thread("a"), thread("b"));
    expect(commitChatPanes(layout, thread("a"))).toBe(layout);
  });

  it("keeps a draft pane addressable by its draft id", () => {
    const layout = split(thread("a"), draft("d"));
    expect(shown(layout, draft("d"))).toEqual([
      { id: "pane-1", target: "a", active: false },
      { id: "pane-2", target: "d", active: true },
    ]);
  });

  it("never shows one thread in two panes", () => {
    expect(split(thread("a"), thread("a"))).toBe(SINGLE_CHAT_PANE_LAYOUT);
    const layout = split(thread("a"), thread("b"));
    expect(
      openChatSplit(layout, {
        routeTarget: thread("a"),
        target: thread("b"),
        createPaneId: paneIds(),
      }),
    ).toBe(layout);
  });

  it("replaces the unfocused pane when the split is full", () => {
    const layout = openChatSplit(split(thread("a"), thread("b")), {
      routeTarget: thread("a"),
      target: thread("c"),
      createPaneId: paneIds(),
    });
    expect(shown(layout, thread("a"))).toEqual([
      { id: "pane-1", target: "a", active: true },
      { id: "pane-2", target: "c", active: false },
    ]);
  });

  it("swapping keeps each pane's thread, focus and size", () => {
    const layout = swapChatPanes({ ...split(thread("a"), thread("b")), ratio: 0.7 });
    expect(shown(layout, thread("a"))).toEqual([
      { id: "pane-2", target: "b", active: false },
      { id: "pane-1", target: "a", active: true },
    ]);
    expect(layout.ratio).toBeCloseTo(0.3);
  });

  it("closing the unfocused pane returns to one pane without moving the route", () => {
    const result = closeChatPane(split(thread("a"), thread("b")), "pane-2");
    expect(result.layout.panes).toEqual([]);
    expect(result.focusTarget).toBeNull();
  });

  it("closing the focused pane moves the route to the remaining pane", () => {
    const result = closeChatPane(split(thread("a"), thread("b")), "pane-1");
    expect(result.layout.panes).toEqual([]);
    expect(result.focusTarget).toEqual(thread("b"));
  });
});

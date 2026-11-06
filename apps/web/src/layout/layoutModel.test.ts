import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLayoutState,
  moveLayoutTabToWorkspace,
  openLayoutTab,
  selectFocusedTab,
  selectFocusedWorkspace,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";

function chat(id: string): LayoutTabContent {
  return {
    kind: "chat",
    target: {
      kind: "server",
      threadRef: scopeThreadRef(EnvironmentId.make("local"), ThreadId.make(id)),
    },
  };
}

function tabContents(state: LayoutState) {
  return state.workspaces.map((workspace) =>
    workspace.columns
      .flatMap((column) => column.panes)
      .flatMap((pane) => pane.tabs.map((tab) => tab.content)),
  );
}

describe("moveLayoutTabToWorkspace", () => {
  it("moves the top workspace's tab into a new workspace above it", () => {
    const first = chat("first");
    const second = chat("second");
    const state = [first, second].reduce(
      (layout, content) =>
        openLayoutTab(layout, content, { placement: "active-pane", position: "end" }),
      createLayoutState(),
    );

    const moved = moveLayoutTabToWorkspace(state, -1);

    expect(tabContents(moved)).toEqual([[second], [first], []]);
    expect(selectFocusedWorkspace(moved)).toBe(moved.workspaces[0]);
    expect(selectFocusedTab(moved)?.content).toBe(second);
  });
});

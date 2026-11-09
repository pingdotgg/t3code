import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  closeLayoutTab,
  closedLayoutTabIds,
  createLayoutState,
  moveLayoutTabToNewWorkspace,
  openLayoutTab,
  selectFocusedTab,
  showLayoutContent,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const chat: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef } };
const diff: LayoutTabContent = { kind: "surface", threadRef, surfaceId: "diff" };
const next: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make("next")) },
};

const columnsOf = (state: LayoutState) =>
  state.workspaces[0]!.columns.map((column) =>
    column.panes.flatMap((pane) => pane.tabs.map((tab) => tab.content)),
  );

describe("showLayoutContent", () => {
  it("opens a thread in place of the chat whose side panel has focus, not in the panel", () => {
    const withPanel = openLayoutTab(openLayoutTab(createLayoutState(), chat), diff, {
      placement: "new-column",
    });
    expect(selectFocusedTab(withPanel)?.content).toBe(diff);

    const shown = showLayoutContent(withPanel, next);

    expect(columnsOf(shown)).toEqual([[next], [diff]]);
    expect(selectFocusedTab(shown)?.content).toBe(next);
  });
});

describe("closedLayoutTabIds", () => {
  it("lists a tab that left the layout, not one that moved to another workspace", () => {
    const layout = openLayoutTab(openLayoutTab(createLayoutState(), chat), diff, {
      placement: "new-column",
    });
    const diffTabId = selectFocusedTab(layout)!.id;

    expect(closedLayoutTabIds(layout, closeLayoutTab(layout, diffTabId))).toEqual([diffTabId]);
    expect(closedLayoutTabIds(layout, moveLayoutTabToNewWorkspace(layout, diffTabId, 1))).toEqual(
      [],
    );
  });
});

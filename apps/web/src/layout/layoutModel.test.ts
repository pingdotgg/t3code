import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLayoutState,
  moveLayoutTab,
  openLayoutTab,
  selectFocusedTab,
  shareLayoutBeside,
  showLayoutContent,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const chat: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef } };
const otherRef = scopeThreadRef(environmentId, ThreadId.make("other"));
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

describe("moveLayoutTab", () => {
  it("gives a pane's height back to the pane in its column it moves into", () => {
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: "chat-pane",
          cameraWidth: 1200,
          columns: [
            {
              id: "column",
              width: 1,
              panes: [
                {
                  id: "chat-pane",
                  size: 0.55,
                  activeTabId: "chat",
                  tabs: [
                    {
                      id: "chat",
                      content: { kind: "chat", target: { kind: "server", threadRef } },
                    },
                    {
                      id: "terminal",
                      content: {
                        kind: "surface",
                        threadRef,
                        surfaceId: THREAD_TERMINAL_SURFACE_ID,
                      },
                    },
                  ],
                },
                {
                  id: "other-pane",
                  size: 0.45,
                  activeTabId: "other-terminal",
                  tabs: [
                    {
                      id: "other-terminal",
                      content: {
                        kind: "surface",
                        threadRef: otherRef,
                        surfaceId: THREAD_TERMINAL_SURFACE_ID,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const shown = shareLayoutBeside(
      moveLayoutTab(base, "terminal", { kind: "split", paneId: "chat-pane", side: "down" }),
      "terminal",
      "chat",
      "terminal",
      1 / 3,
      "shrink-then-scroll",
      0,
    );
    const hidden = moveLayoutTab(shown, "terminal", {
      kind: "pane",
      paneId: "chat-pane",
      index: 1,
    });
    const sizes = hidden.workspaces[0]!.columns[0]!.panes.map((pane) => [pane.id, pane.size]);
    expect(sizes).toEqual([
      ["chat-pane", expect.closeTo(0.55)],
      ["other-pane", expect.closeTo(0.45)],
    ]);
  });
});

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  moveLayoutTab,
  shareLayoutBeside,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutState,
} from "./layoutModel";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread"));
const otherRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("other"));

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

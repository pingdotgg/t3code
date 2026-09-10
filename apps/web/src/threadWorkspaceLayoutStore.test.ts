import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, test } from "vite-plus/test";

import { getPanes } from "./splitPaneTree";
import {
  parsePersistedThreadWorkspaceLayouts,
  selectThreadWorkspaceLayout,
} from "./threadWorkspaceLayoutStore";
import {
  createThreadWorkspaceTabFields,
  transitionThreadWorkspaceTabs,
} from "./threadWorkspaceTabs";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("env-test"), ThreadId.make("thread-test"));
const THREAD_KEY = scopedThreadKey(THREAD_REF);

describe("thread workspace layout persistence", () => {
  test("parses pane placement without owning surface descriptors", () => {
    const layout = transitionThreadWorkspaceTabs(createThreadWorkspaceTabFields(["diff"]), {
      _tag: "SplitTab",
      paneId: "pane:root",
      tabId: "pane-tab:1",
      direction: "right",
      mode: "move",
    });

    const parsed = parsePersistedThreadWorkspaceLayouts({
      byThreadKey: { [THREAD_KEY]: layout },
    });

    expect(selectThreadWorkspaceLayout(parsed.byThreadKey, THREAD_REF)).toEqual(layout);
    expect(getPanes(layout.paneTree.root)).toHaveLength(2);
  });

  test("drops malformed layouts at the persistence boundary", () => {
    expect(
      parsePersistedThreadWorkspaceLayouts({
        byThreadKey: { [THREAD_KEY]: { paneTree: null, tabsById: "invalid" } },
      }),
    ).toEqual({ byThreadKey: {} });
  });

  test("returns the stable thread-only layout for unknown threads", () => {
    const layout = selectThreadWorkspaceLayout({}, THREAD_REF);

    expect(getPanes(layout.paneTree.root)).toEqual([
      {
        _tag: "Group",
        id: "pane:root",
        tabIds: ["pane-tab:thread"],
        activeTabId: "pane-tab:thread",
      },
    ]);
  });
});

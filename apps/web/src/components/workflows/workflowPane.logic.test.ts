import { describe, expect, it } from "vite-plus/test";

import {
  activeWorkflowPaneTab,
  closeWorkflowPaneTab,
  openWorkflowPaneTab,
  readWorkflowPane,
  toggleWorkflowPaneTab,
  type WorkflowPaneState,
} from "./workflowPane.logic";

const issue = { kind: "issue", key: "i412" };
const pullRequest = { kind: "pullRequest", key: "p418" };
const transcript = { thread: "workflow:ab", env: "env-2" };

describe("the pane beside a run", () => {
  it("reads back from the address only what it can, once", () => {
    expect(
      readWorkflowPane(
        [issue, { kind: "issue" }, issue, transcript, { thread: "t1", env: 3 }, "x"],
        "0",
      ),
    ).toEqual({ pane: [issue, transcript, { thread: "t1" }], tab: 0 });
    // The last tab shows unless the address says another; one it cannot have shows the last.
    for (const rawTab of [7, "", " ", null, false]) {
      const state = readWorkflowPane([issue, pullRequest], rawTab);
      expect(state).toEqual({ pane: [issue, pullRequest] });
      expect(activeWorkflowPaneTab(state)).toEqual(pullRequest);
    }
    expect(readWorkflowPane("nope", 0)).toEqual({});
  });

  it("opens a tab once, shows it, and closing one shows the tab beside it", () => {
    let state: WorkflowPaneState = {};
    state = openWorkflowPaneTab(state, issue);
    state = openWorkflowPaneTab(state, pullRequest);
    state = openWorkflowPaneTab(state, transcript);
    expect(state).toEqual({ pane: [issue, pullRequest, transcript] });
    state = openWorkflowPaneTab(state, { ...issue });
    expect(state).toEqual({ pane: [issue, pullRequest, transcript], tab: 0 });
    state = closeWorkflowPaneTab(state, 0);
    expect(activeWorkflowPaneTab(state)).toEqual(pullRequest);
    // Closing one that does not show leaves the one that does.
    state = closeWorkflowPaneTab(state, 1);
    expect(state).toEqual({ pane: [pullRequest] });
    expect(closeWorkflowPaneTab(state, 0)).toEqual({});
  });

  it("asking for the tab that shows closes it, and any other shows it", () => {
    const open = { pane: [issue, transcript] };
    expect(toggleWorkflowPaneTab(open, transcript)).toEqual({ pane: [issue] });
    expect(toggleWorkflowPaneTab(open, issue)).toEqual({ pane: [issue, transcript], tab: 0 });
  });
});

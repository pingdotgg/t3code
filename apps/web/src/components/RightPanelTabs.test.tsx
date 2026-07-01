import { describe, expect, it, vi } from "@effect/vitest";

import {
  ADD_SURFACE_EMPTY_STATE_ORDER,
  ADD_SURFACE_MENU_ORDER,
  buildAddSurfaceActions,
} from "./RightPanelTabs";

function actionProps() {
  return {
    onAddBrowser: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddSourceControl: vi.fn(),
    browserAvailable: true,
    diffAvailable: false,
    filesAvailable: true,
    sourceControlAvailable: true,
  };
}

describe("RightPanelTabs add-surface actions", () => {
  it("keeps Version Control first in the empty state", () => {
    const actions = buildAddSurfaceActions(actionProps(), ADD_SURFACE_EMPTY_STATE_ORDER);

    expect(actions.map((action) => action.id)).toEqual([
      "source-control",
      "browser",
      "terminal",
      "files",
      "diff",
    ]);
  });

  it("preserves the legacy add-menu order", () => {
    const actions = buildAddSurfaceActions(actionProps(), ADD_SURFACE_MENU_ORDER);

    expect(actions.map((action) => action.label)).toEqual([
      "Browser",
      "Terminal",
      "Files",
      "Diff",
      "Version Control",
    ]);
  });

  it("shares enabled callbacks and disabled reasons across consumers", () => {
    const props = actionProps();
    const actions = buildAddSurfaceActions(props);
    const browser = actions.find((action) => action.id === "browser");
    const diff = actions.find((action) => action.id === "diff");

    expect(browser?.available).toBe(true);
    browser?.onClick();
    expect(props.onAddBrowser).toHaveBeenCalledTimes(1);
    expect(diff?.available).toBe(false);
    expect(diff?.disabledReason).toBe(
      "Diff is only available for server threads in Git repositories.",
    );
  });
});

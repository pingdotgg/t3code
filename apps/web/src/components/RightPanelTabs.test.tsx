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
    onAddAgents: vi.fn(),
    browserAvailable: true,
    diffAvailable: false,
    filesAvailable: true,
    sourceControlAvailable: true,
  };
}

describe("RightPanelTabs add-surface actions", () => {
  it("keeps Version Control first and unique in the empty state", () => {
    const actions = buildAddSurfaceActions(actionProps(), ADD_SURFACE_EMPTY_STATE_ORDER);
    const sourceControlActions = actions.filter((action) => action.id === "source-control");

    expect(actions[0]?.id).toBe("source-control");
    expect(sourceControlActions).toHaveLength(1);
  });

  it("keeps Version Control last and unique in the add menu", () => {
    const actions = buildAddSurfaceActions(actionProps(), ADD_SURFACE_MENU_ORDER);
    const sourceControlActions = actions.filter((action) => action.id === "source-control");

    expect(actions.at(-1)?.id).toBe("source-control");
    expect(sourceControlActions).toHaveLength(1);
  });

  it("uses the Version Control callback, availability, and disabled reason", () => {
    const props = actionProps();
    const actions = buildAddSurfaceActions(props);
    const sourceControl = actions.find((action) => action.id === "source-control");
    const unavailableSourceControl = buildAddSurfaceActions({
      ...props,
      sourceControlAvailable: false,
    }).find((action) => action.id === "source-control");

    expect(sourceControl?.available).toBe(true);
    sourceControl?.onClick();
    expect(props.onAddSourceControl).toHaveBeenCalledTimes(1);
    expect(unavailableSourceControl?.available).toBe(false);
    expect(unavailableSourceControl?.disabledReason).toBe(
      "Version Control is only available when a project is open in a Git repository.",
    );
  });
});

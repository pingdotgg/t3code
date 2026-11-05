import { describe, expect, it } from "vite-plus/test";

import { resizeLayoutColumnEdge, selectLayoutPaneSlots, type LayoutState } from "./layoutModel";

const column = (id: string, width: number) => ({
  id,
  width,
  panes: [{ id: `${id}-pane`, tabs: [], activeTabId: null, size: 1 }],
});

function drawnRightEdges(state: LayoutState, viewportWidth: number): number[] {
  const { slots, stripWidth } = selectLayoutPaneSlots(state.workspaces[0]!, {
    width: viewportWidth,
    whenNoRoom: "shrink-then-scroll",
  });
  return slots.map((slot) =>
    Math.round((slot.rect.left + slot.rect.width) * stripWidth * viewportWidth),
  );
}

describe("resizeLayoutColumnEdge", () => {
  it("keeps the dragged edge under the pointer when the strip was arranged wider than the window", () => {
    const viewportWidth = 1000;
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: null,
          cameraWidth: 1200,
          columns: [column("chat", 0.5), column("terminal", 0.55)],
        },
      ],
    };
    const { unitWidth } = selectLayoutPaneSlots(base.workspaces[0]!, {
      width: viewportWidth,
      whenNoRoom: "shrink-then-scroll",
    });
    expect(drawnRightEdges(base, viewportWidth)).toEqual([600, 1260]);

    const pointers = Array.from({ length: 41 }, (_, index) => 300 + index * 10);
    const drawn = pointers.map((pointer) =>
      drawnRightEdges(
        resizeLayoutColumnEdge(base, "chat", pointer / viewportWidth, viewportWidth, unitWidth),
        viewportWidth,
      ),
    );
    expect(drawn).toEqual(pointers.map((pointer) => [pointer, pointer + 660]));
  });
});

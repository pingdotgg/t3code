import { describe, expect, it } from "vite-plus/test";

import boardRouteSource from "./_chat.$environmentId.board.tsx?raw";

describe("workflow editor route surface", () => {
  it("mounts workflow editing in a full-screen surface, not the right panel sheet", () => {
    expect(boardRouteSource).toContain("WorkflowEditorFullscreen");
    expect(boardRouteSource).not.toMatch(/<RightPanelSheet[\s\S]*<WorkflowEditor/);
  });
});

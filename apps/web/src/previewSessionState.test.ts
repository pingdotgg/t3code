import { describe, expect, it } from "vitest";

import {
  buildSessionFromRuntimeSnapshot,
  createPreviewFileSessionState,
  mergePreviewControlsWithDrafts,
  normalizeSelectedScenarioId,
} from "./previewSessionState";
import type { PreviewControlDescriptor, PreviewRuntimeSnapshot } from "./previewWorkspaceStore";

function createRuntimeSnapshot(input?: Partial<PreviewRuntimeSnapshot>): PreviewRuntimeSnapshot {
  return {
    runtimeInstanceId: "runtime-1",
    currentScenarioId: "default",
    currentScenarioChoices: [
      { id: "default", name: "Default" },
      { id: "icon-only", name: "Icon Only" },
    ],
    controls: [],
    lastAppliedCommandId: 1,
    ...input,
  };
}

describe("previewSessionState", () => {
  it("keeps draft values visible until the runtime confirms them", () => {
    const session = createPreviewFileSessionState("src/Button.preview.tsx", {
      selectedScenarioId: "default",
      confirmedArgOverrides: { displayText: "Copy" },
      draftArgOverrides: { displayText: "" },
    });

    const nextSession = buildSessionFromRuntimeSnapshot({
      existingSession: session,
      previewFileRelativePath: session.previewFileRelativePath,
      runtimeSnapshot: createRuntimeSnapshot(),
      confirmedArgOverrides: { displayText: "Copy" },
    });

    expect(nextSession.draftArgOverrides).toEqual({ displayText: "" });
  });

  it("clears draft values after the runtime acknowledges them", () => {
    const session = createPreviewFileSessionState("src/Button.preview.tsx", {
      selectedScenarioId: "default",
      confirmedArgOverrides: { displayText: "Copy" },
      draftArgOverrides: { displayText: "" },
    });

    const nextSession = buildSessionFromRuntimeSnapshot({
      existingSession: session,
      previewFileRelativePath: session.previewFileRelativePath,
      runtimeSnapshot: createRuntimeSnapshot(),
      confirmedArgOverrides: { displayText: "" },
    });

    expect(nextSession.draftArgOverrides).toEqual({});
    expect(nextSession.confirmedArgOverrides).toEqual({ displayText: "" });
  });

  it("preserves a valid cached scenario selection across runtime remounts", () => {
    const session = createPreviewFileSessionState("src/Button.preview.tsx", {
      selectedScenarioId: "icon-only",
    });

    const nextSession = buildSessionFromRuntimeSnapshot({
      existingSession: session,
      previewFileRelativePath: session.previewFileRelativePath,
      runtimeSnapshot: createRuntimeSnapshot(),
      confirmedArgOverrides: {},
    });

    expect(nextSession.selectedScenarioId).toBe("icon-only");
  });

  it("falls back to the runtime scenario when the cached scenario is invalid", () => {
    expect(
      normalizeSelectedScenarioId(
        "missing",
        [
          { id: "default", name: "Default" },
          { id: "icon-only", name: "Icon Only" },
        ],
        "default",
      ),
    ).toBe("default");
  });

  it("overlays draft values on runtime controls", () => {
    const controls: PreviewControlDescriptor[] = [
      {
        name: "displayText",
        label: "Display Text",
        description: null,
        type: "text",
        value: "Copy",
      },
    ];

    expect(
      mergePreviewControlsWithDrafts(controls, {
        displayText: "",
      }),
    ).toEqual([
      {
        name: "displayText",
        label: "Display Text",
        description: null,
        type: "text",
        value: "",
      },
    ]);
  });
});

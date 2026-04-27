import { beforeEach, describe, expect, it } from "vitest";

import { useCommandPaletteStore } from "./commandPaletteStore";

describe("commandPaletteStore", () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({ open: false, openIntent: null });
  });

  it("opens the command palette with a switch-project intent and increments requestId", () => {
    useCommandPaletteStore.getState().openProjectSwitcher();

    expect(useCommandPaletteStore.getState().open).toBe(true);
    expect(useCommandPaletteStore.getState().openIntent).toEqual({
      kind: "switch-project",
      requestId: 1,
    });

    useCommandPaletteStore.getState().openProjectSwitcher();

    expect(useCommandPaletteStore.getState().openIntent).toEqual({
      kind: "switch-project",
      requestId: 2,
    });
  });
});

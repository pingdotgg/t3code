import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useHeaderControlsStore } from "./headerControlsStore";

describe("headerControlsStore", () => {
  beforeEach(() => {
    useHeaderControlsStore.getState().resetVisibility();
  });

  it("initializes with all controls visible by default", () => {
    const { visibility } = useHeaderControlsStore.getState();
    expect(visibility).toEqual({
      scripts: true,
      openIn: true,
      git: true,
    });
  });

  it("toggles individual control visibility", () => {
    useHeaderControlsStore.getState().toggleControl("scripts");
    expect(useHeaderControlsStore.getState().visibility.scripts).toBe(false);
    expect(useHeaderControlsStore.getState().visibility.openIn).toBe(true);
    expect(useHeaderControlsStore.getState().visibility.git).toBe(true);

    useHeaderControlsStore.getState().toggleControl("scripts");
    expect(useHeaderControlsStore.getState().visibility.scripts).toBe(true);
  });

  it("sets specific control visibility", () => {
    useHeaderControlsStore.getState().setControlVisibility("openIn", false);
    expect(useHeaderControlsStore.getState().visibility.openIn).toBe(false);

    useHeaderControlsStore.getState().setControlVisibility("openIn", true);
    expect(useHeaderControlsStore.getState().visibility.openIn).toBe(true);
  });

  it("resets visibility to defaults", () => {
    useHeaderControlsStore.getState().setControlVisibility("scripts", false);
    useHeaderControlsStore.getState().setControlVisibility("git", false);
    expect(useHeaderControlsStore.getState().visibility.scripts).toBe(false);
    expect(useHeaderControlsStore.getState().visibility.git).toBe(false);

    useHeaderControlsStore.getState().resetVisibility();
    expect(useHeaderControlsStore.getState().visibility).toEqual({
      scripts: true,
      openIn: true,
      git: true,
    });
  });
});

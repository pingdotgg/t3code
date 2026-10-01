import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  TITLEBAR_CONTROLS_WIDTH_VAR,
  TITLEBAR_PANEL_CONTROLS_WIDTH_VAR,
  publishTitlebarControlsWidth,
} from "./workspaceTitlebar";

// Minimal DOM: the root style the tab bar's padding reads, and resize delivery per element.
const rootProperties = new Map<string, string>();
const rootStyle = {
  getPropertyValue: (name: string) => rootProperties.get(name) ?? "",
  setProperty: (name: string, value: string) => void rootProperties.set(name, value),
  removeProperty: (name: string) => void rootProperties.delete(name),
};
const observers = new Map<object, () => void>();

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(target: object) {
    observers.set(target, this.callback);
  }
  disconnect() {
    for (const [target, callback] of observers)
      if (callback === this.callback) observers.delete(target);
  }
}

/**
 * The fixed cluster. `panelControls` is the width of the panel layout controls
 * it hosts (Extensions menu, dock toggle, panel toggles); the rest of the
 * cluster is the maximize slot, laid out but invisible while the panel is closed.
 */
function cluster(initialWidth: number, initialPanelControls: number | null = null) {
  let width = initialWidth;
  let panelControlsWidth = initialPanelControls;
  const panelControls = { getBoundingClientRect: () => ({ width: panelControlsWidth }) };
  const element = {
    ownerDocument: { documentElement: { style: rootStyle } },
    getBoundingClientRect: () => ({ width }),
    querySelector: (selector: string) =>
      selector === "[data-panel-layout-controls]" && panelControlsWidth !== null
        ? panelControls
        : null,
  };
  return {
    element: element as unknown as HTMLElement,
    resize(next: number, nextPanelControls = panelControlsWidth) {
      width = next;
      panelControlsWidth = nextPanelControls;
      observers.get(element)?.();
    },
  };
}

const published = () => rootProperties.get(TITLEBAR_CONTROLS_WIDTH_VAR) ?? null;
const publishedPanelControls = () => rootProperties.get(TITLEBAR_PANEL_CONTROLS_WIDTH_VAR) ?? null;

beforeEach(() => {
  rootProperties.clear();
  observers.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("titlebar controls width", () => {
  it("reserves the cluster's real width as it gains the Extensions menu", () => {
    const controls = cluster(96);
    const release = publishTitlebarControlsWidth(controls.element);
    expect(published()).toBe("96px");
    // Installed packs load after mount and widen the cluster past the old 112px guess.
    controls.resize(236.4);
    expect(published()).toBe("237px");
    controls.resize(96);
    expect(published()).toBe("96px");
    release?.();
  });

  it("follows the remounted cluster when a retained panel reopens", () => {
    // The retained extension panel keeps the tab bar mounted while the route
    // moves the cluster into a new element. React may detach the old ref
    // before or after attaching the new one; the new cluster wins either way.
    for (const oldReleasesFirst of [true, false]) {
      const before = cluster(236);
      const releaseBefore = publishTitlebarControlsWidth(before.element);
      const after = cluster(236);
      if (oldReleasesFirst) releaseBefore?.();
      const releaseAfter = publishTitlebarControlsWidth(after.element);
      if (!oldReleasesFirst) releaseBefore?.();
      expect(published()).toBe("236px");

      // The detached cluster measures zero; it must not shrink the reservation.
      before.resize(0);
      expect(published()).toBe("236px");
      after.resize(280);
      expect(published()).toBe("280px");
      releaseAfter?.();
    }
  });

  it("clears the reservation once no cluster is mounted", () => {
    const controls = cluster(120);
    const release = publishTitlebarControlsWidth(controls.element);
    release?.();
    expect(published()).toBeNull();
    controls.resize(300);
    expect(published()).toBeNull();
    expect(publishTitlebarControlsWidth(null)).toBeUndefined();
  });

  it("reserves the visible panel controls for the chat header as the Extensions menu arrives", () => {
    // Closed panel: two toggles (60px) visible, the 32px maximize slot invisible.
    const controls = cluster(92, 60);
    const release = publishTitlebarControlsWidth(controls.element);
    expect(publishedPanelControls()).toBe("60px");
    // The Extensions menu mounts once installed packs load.
    controls.resize(184.2, 152.2);
    expect(publishedPanelControls()).toBe("153px");
    expect(published()).toBe("185px");
    release?.();
    expect(publishedPanelControls()).toBeNull();
  });

  it("publishes no panel controls reservation for a cluster without them", () => {
    const release = publishTitlebarControlsWidth(cluster(40).element);
    expect(publishedPanelControls()).toBeNull();
    release?.();
  });
});

import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePanelNavigationSuppression } from "./panelAnimations";

let renderer: ReactTestRenderer | null = null;
let pendingFrames: FrameRequestCallback[] = [];
let observed: boolean[] = [];

function SuppressionProbe({ navigationKey }: { navigationKey: string }) {
  const suppressed = usePanelNavigationSuppression(navigationKey);
  useLayoutEffect(() => {
    observed.push(suppressed);
  }, [suppressed]);
  return null;
}

beforeEach(() => {
  pendingFrames = [];
  observed = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    }),
    cancelAnimationFrame: vi.fn(),
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function paintPendingFrame() {
  const callback = pendingFrames.shift();
  await act(() => callback?.(0));
}

describe("usePanelNavigationSuppression", () => {
  it("suppresses initial and navigated panel state until each route has painted", async () => {
    await act(() => {
      renderer = create(<SuppressionProbe navigationKey="/thread/one" />);
    });
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);

    await act(() => {
      renderer?.update(<SuppressionProbe navigationKey="/thread/two" />);
    });
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);
  });
});

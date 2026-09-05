import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "./panelAnimations";

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

const motionSettings = vi.hoisted(() => ({ durationMs: 0, reducedMotion: false }));
vi.mock("./hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { panelAnimationDurationMs: number }) => unknown) =>
    select({ panelAnimationDurationMs: motionSettings.durationMs }),
}));
vi.mock("./hooks/useMediaQuery", () => ({
  useMediaQuery: () => motionSettings.reducedMotion,
}));

it.each([
  { configured: 0, minimum: 200, reduced: false, suppressed: false, duration: 200, active: true },
  { configured: 100, minimum: 200, reduced: false, suppressed: false, duration: 200, active: true },
  { configured: 350, minimum: 200, reduced: false, suppressed: false, duration: 350, active: true },
  { configured: 0, minimum: 200, reduced: true, suppressed: false, duration: 200, active: false },
  { configured: 0, minimum: 200, reduced: false, suppressed: true, duration: 200, active: false },
  { configured: 0, minimum: 0, reduced: false, suppressed: false, duration: 0, active: false },
])(
  "resolves drawer motion with $configured ms, reduced=$reduced, suppressed=$suppressed",
  async ({ configured, minimum, reduced, suppressed, duration, active }) => {
    motionSettings.durationMs = configured;
    motionSettings.reducedMotion = reduced;
    let result: ReturnType<typeof usePanelAnimationSettings> | undefined;
    function Probe() {
      const settings = usePanelAnimationSettings(minimum);
      useLayoutEffect(() => {
        result = settings;
      }, [settings]);
      return null;
    }
    await act(() => {
      renderer = create(
        <PanelAnimationSuppressionProvider value={suppressed}>
          <Probe />
        </PanelAnimationSuppressionProvider>,
      );
    });
    expect(result).toEqual({ active, durationMs: duration });
  },
);

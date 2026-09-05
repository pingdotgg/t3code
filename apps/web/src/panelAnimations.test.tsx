import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { usePanelNavigationSuppression, usePanelPresence } from "./panelAnimations";
import {
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

let renderer: ReactTestRenderer | null = null;
let pendingFrames: FrameRequestCallback[] = [];
let observed: boolean[] = [];
let presenceObserved: { present: boolean; value: RightPanelSurface | null }[] = [];
const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

function PresenceProbe({ durationMs }: { durationMs: number }) {
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const active = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const presence = usePanelPresence(panel.isOpen, active, durationMs > 0, "thread-1", durationMs);
  useLayoutEffect(() => {
    presenceObserved.push(presence);
  }, [presence]);
  return null;
}

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
  presenceObserved = [];
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    }),
    cancelAnimationFrame: vi.fn(),
    setTimeout,
    clearTimeout,
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("panel close and restore", () => {
  it.each([0, 200])(
    "keeps the selected tab when restored with a %d ms duration",
    async (durationMs) => {
      const panels = useRightPanelStore.getState();
      panels.openBrowser(threadRef, "tab-1");
      await act(() => {
        renderer = create(<PresenceProbe durationMs={durationMs} />);
      });
      const browser = { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" };
      expect(presenceObserved.at(-1)).toEqual({ present: true, value: browser });

      await act(() => panels.close(threadRef));
      expect(presenceObserved.at(-1)).toEqual({
        present: durationMs > 0,
        value: durationMs > 0 ? browser : null,
      });
      await act(() => panels.toggleVisibility(threadRef));
      await act(() => vi.advanceTimersByTime(durationMs));
      expect(presenceObserved.at(-1)).toEqual({ present: true, value: browser });

      await act(() => panels.close(threadRef));
      await act(() => vi.advanceTimersByTime(durationMs));
      expect(presenceObserved.at(-1)).toEqual({ present: false, value: null });
    },
  );
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

import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../test/render";
import { usePanelNavigationSuppression } from "./panelAnimations";

function SuppressionProbe({
  navigationKey,
  observed,
}: {
  navigationKey: string;
  observed: boolean[];
}) {
  const suppressed = usePanelNavigationSuppression(navigationKey);
  useLayoutEffect(() => {
    observed.push(suppressed);
  }, [observed, suppressed]);
  return null;
}

describe("usePanelNavigationSuppression", () => {
  it("suppresses initial and navigated panel state until each route has painted", async () => {
    const pendingFrames: FrameRequestCallback[] = [];
    const observed: boolean[] = [];
    // Frames are stepped by hand so each assertion lands between two paints.
    using _requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => pendingFrames.push(callback));
    using _cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const paintPendingFrame = async () => {
      const callback = pendingFrames.shift();
      await act(() => callback?.(0));
    };

    await using screen = await render(
      <SuppressionProbe navigationKey="/thread/one" observed={observed} />,
    );
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);

    await screen.rerender(<SuppressionProbe navigationKey="/thread/two" observed={observed} />);
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);
  });
});

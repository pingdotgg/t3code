import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopUpdateCheckIcon,
  nextDesktopUpdateCheckAnimationKey,
  shouldContinueDesktopUpdateCheckAnimation,
} from "./DesktopUpdateCheckIcon";

describe("DesktopUpdateCheckIcon", () => {
  it("keeps the refresh icon spinning while a fast update check settles", () => {
    const markup = renderToStaticMarkup(<DesktopUpdateCheckIcon isAnimating />);

    expect(markup).toContain("animate-spin");
  });

  it("does not animate while idle", () => {
    const markup = renderToStaticMarkup(<DesktopUpdateCheckIcon isAnimating={false} />);

    expect(markup).not.toContain("animate-spin");
  });

  it("keeps status-driven checks spinning across rotations", () => {
    expect(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: true,
      }),
    ).toBe(true);
  });

  it("releases the manual animation latch after one rotation", () => {
    expect(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: false,
      }),
    ).toBe(false);
  });

  it("restarts the animation for each manual check", () => {
    expect(nextDesktopUpdateCheckAnimationKey(2)).toBe(3);
  });
});

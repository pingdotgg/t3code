import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  getThreadErrorBannerKey,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("stays hidden after its current error is dismissed", () => {
    const dismissedKey = getThreadErrorBannerKey("env:thread", "Aborted");

    expect(shouldShowThreadErrorBanner("env:thread", "Aborted", null)).toBe(true);
    expect(shouldShowThreadErrorBanner("env:thread", "Aborted", dismissedKey)).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    const dismissedKey = getThreadErrorBannerKey("env:thread", "Aborted");

    expect(shouldShowThreadErrorBanner("env:thread", "Turn failed", dismissedKey)).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    const dismissedKey = getThreadErrorBannerKey("env:thread", "Aborted");

    expect(shouldShowThreadErrorBanner("env:other-thread", "Aborted", dismissedKey)).toBe(true);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread", null, null)).toBe(false);
  });
  it("aligns the warning and dismiss icons with the first line of a multi-line error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).not.toContain("controlAlignment");
    expect(markup).toContain("flex gap-2 items-start");
    expect(markup).toContain("min-h-7 pt-1 sm:min-h-6 sm:pt-0.5");
    expect(markup).toContain("h-lh w-4");
    expect(markup).toContain("h-lh self-start");
  });
});

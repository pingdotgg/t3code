import { assert, describe, it } from "@effect/vitest";

import {
  renderStartupSplashHtml,
  STARTUP_SPLASH_MESSAGE,
  toStartupSplashUrl,
} from "./startupSplash.ts";

describe("startupSplash", () => {
  it("renders the display name and message", () => {
    const html = renderStartupSplashHtml({
      displayName: "T3 Code (Alpha)",
      shouldUseDarkColors: false,
      message: STARTUP_SPLASH_MESSAGE,
    });

    assert.include(html, "T3 Code (Alpha)");
    assert.include(html, STARTUP_SPLASH_MESSAGE);
    assert.include(html, "#ffffff");
  });

  it("uses dark colors when requested", () => {
    const html = renderStartupSplashHtml({
      displayName: "T3 Code",
      shouldUseDarkColors: true,
      message: STARTUP_SPLASH_MESSAGE,
    });

    assert.include(html, "#0a0a0a");
    assert.notInclude(html, "background: #ffffff");
  });

  it("escapes the display name", () => {
    const html = renderStartupSplashHtml({
      displayName: '<img src=x onerror="alert(1)">',
      shouldUseDarkColors: false,
      message: STARTUP_SPLASH_MESSAGE,
    });

    assert.notInclude(html, "<img");
    assert.include(html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("encodes the document as a data url", () => {
    const url = toStartupSplashUrl(
      renderStartupSplashHtml({
        displayName: "T3 Code",
        shouldUseDarkColors: false,
        message: STARTUP_SPLASH_MESSAGE,
      }),
    );

    assert.isTrue(url.startsWith("data:text/html;charset=utf-8,"));
    assert.include(decodeURIComponent(url), STARTUP_SPLASH_MESSAGE);
  });
});

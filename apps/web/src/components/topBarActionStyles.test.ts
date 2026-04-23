import { describe, expect, it } from "vitest";

import { topBarButtonLabelClassName, topBarGroupSeparatorClassName } from "./topBarActionStyles";

describe("topBarActionStyles", () => {
  it("keeps top-bar labels and separators compact when requested", () => {
    expect(topBarButtonLabelClassName(true)).toBe("sr-only");
    expect(topBarGroupSeparatorClassName(true)).toBe("hidden");
  });

  it("restores the wide-header expansion classes when compact mode is disabled", () => {
    expect(topBarButtonLabelClassName(false)).toBe(
      "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
    );
    expect(topBarGroupSeparatorClassName(false)).toBe("hidden @3xl/header-actions:block");
  });
});

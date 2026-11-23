import { describe, expect, it } from "vite-plus/test";

import { floatsOnPanelClose } from "./floatOnPanelClose";

describe("floatsOnPanelClose", () => {
  it("does not float a tab that never navigated", () => {
    expect(floatsOnPanelClose({ _tag: "Idle" })).toBe(false);
  });

  it("floats a tab that is loading or has loaded a page", () => {
    expect(floatsOnPanelClose({ _tag: "Loading", url: "https://example.test/", title: "" })).toBe(
      true,
    );
    expect(
      floatsOnPanelClose({ _tag: "Success", url: "https://example.test/", title: "Example" }),
    ).toBe(true);
  });

  it("floats a tab whose navigation failed, since its panel can retry it", () => {
    expect(
      floatsOnPanelClose({
        _tag: "LoadFailed",
        url: "https://example.test/",
        title: "Example",
        code: -105,
        description: "Name not resolved",
      }),
    ).toBe(true);
  });

  it("does not float a tab whose session is unknown", () => {
    expect(floatsOnPanelClose(undefined)).toBe(false);
  });
});

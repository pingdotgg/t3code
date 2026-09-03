import { describe, expect, it } from "vite-plus/test";

import { hostedBrowserWebviewKey, latchHostedBrowserWebviewSrc } from "./hostedBrowserWebviewGuest";

describe("hostedBrowserWebviewKey", () => {
  it("changes when the partition or generation changes", () => {
    expect(hostedBrowserWebviewKey("persist:a", 0)).not.toBe(
      hostedBrowserWebviewKey("persist:b", 0),
    );
    expect(hostedBrowserWebviewKey("persist:a", 0)).not.toBe(
      hostedBrowserWebviewKey("persist:a", 1),
    );
  });
});

describe("latchHostedBrowserWebviewSrc", () => {
  it("captures src when the guest key changes", () => {
    expect(latchHostedBrowserWebviewSrc(null, "persist:a:0", "https://a.example/")).toEqual({
      key: "persist:a:0",
      src: "https://a.example/",
    });
  });

  it("keeps the latched src for the same guest", () => {
    const latched = { key: "persist:a:0", src: "https://a.example/" };
    expect(latchHostedBrowserWebviewSrc(latched, "persist:a:0", "https://b.example/")).toBe(
      latched,
    );
  });

  it("takes the current url when the guest remounts", () => {
    const latched = { key: "persist:a:0", src: "https://a.example/" };
    expect(latchHostedBrowserWebviewSrc(latched, "persist:b:0", "https://b.example/")).toEqual({
      key: "persist:b:0",
      src: "https://b.example/",
    });
  });
});

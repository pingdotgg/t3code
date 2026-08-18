import { describe, expect, it } from "vite-plus/test";

import { applicationInitialIcon } from "./applicationInitialIcon";

const initialOf = (name: string) =>
  applicationInitialIcon(name).displayName?.replace(/^ApplicationInitialIcon\((.*)\)$/, "$1");

describe("applicationInitialIcon", () => {
  it("uses the first letter, upper-cased", () => {
    expect(initialOf("Android Studio")).toBe("A");
    expect(initialOf("zed")).toBe("Z");
  });

  it("skips leading punctuation to find a real character", () => {
    expect(initialOf("[Beta] Brave")).toBe("B");
    expect(initialOf(".hidden app")).toBe("H");
  });

  it("accepts a leading digit", () => {
    expect(initialOf("1Password")).toBe("1");
  });

  it("handles non-latin names", () => {
    expect(initialOf("日本語アプリ")).toBe("日");
  });

  it("falls back for a name with no letters or digits", () => {
    expect(initialOf("***")).toBe("?");
    expect(initialOf("")).toBe("?");
  });

  // One component per initial keeps element identity stable across renders of
  // a long list instead of remounting every row.
  it("reuses one component per initial", () => {
    expect(applicationInitialIcon("Brave")).toBe(applicationInitialIcon("Bitwarden"));
    expect(applicationInitialIcon("Brave")).not.toBe(applicationInitialIcon("Zed"));
  });
});

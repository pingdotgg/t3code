import { describe, expect, it } from "vite-plus/test";

import { nativeKeybindingCaptureInput } from "./NativeKeybindingCapture.ts";

describe("nativeKeybindingCaptureInput", () => {
  it("forwards Command-Escape with its modifiers", () => {
    expect(
      nativeKeybindingCaptureInput(
        {
          type: "keyDown",
          key: "Escape",
          meta: true,
          control: false,
          alt: false,
          shift: true,
        },
        "darwin",
      ),
    ).toEqual({
      key: "Escape",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });
  });

  it("forwards Control-Escape as mod+esc on non-macOS platforms", () => {
    expect(
      nativeKeybindingCaptureInput(
        {
          type: "keyDown",
          key: "Escape",
          meta: false,
          control: true,
          alt: true,
          shift: false,
        },
        "win32",
      ),
    ).toEqual({
      key: "Escape",
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
    });
  });

  it.each([
    ["bare Escape", { type: "keyDown", key: "Escape", meta: false }, "darwin"],
    ["Command keyup", { type: "keyUp", key: "Escape", meta: true }, "darwin"],
    ["another Command shortcut", { type: "keyDown", key: "k", meta: true }, "darwin"],
    ["Meta-Escape on Windows", { type: "keyDown", key: "Escape", meta: true }, "win32"],
  ] satisfies ReadonlyArray<
    readonly [
      string,
      { readonly type: string; readonly key: string; readonly meta: boolean },
      NodeJS.Platform,
    ]
  >)("ignores %s", (_name, input, platform) => {
    expect(
      nativeKeybindingCaptureInput(
        {
          control: false,
          alt: false,
          shift: false,
          ...input,
        },
        platform,
      ),
    ).toBeNull();
  });
});

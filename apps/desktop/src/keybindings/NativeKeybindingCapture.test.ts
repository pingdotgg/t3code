import { describe, expect, it } from "vite-plus/test";

import { nativeKeybindingCaptureInput } from "./NativeKeybindingCapture.ts";

describe("nativeKeybindingCaptureInput", () => {
  it("forwards Command-Escape with its modifiers", () => {
    expect(
      nativeKeybindingCaptureInput({
        type: "keyDown",
        key: "Escape",
        meta: true,
        control: false,
        alt: false,
        shift: true,
      }),
    ).toEqual({
      key: "Escape",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });
  });

  it.each([
    ["bare Escape", { type: "keyDown", key: "Escape", meta: false }],
    ["Command keyup", { type: "keyUp", key: "Escape", meta: true }],
    ["another Command shortcut", { type: "keyDown", key: "k", meta: true }],
  ])("ignores %s", (_name, input) => {
    expect(
      nativeKeybindingCaptureInput({
        control: false,
        alt: false,
        shift: false,
        ...input,
      }),
    ).toBeNull();
  });
});

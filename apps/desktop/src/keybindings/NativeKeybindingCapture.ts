import type { Input } from "electron";

export const NATIVE_KEYBINDING_CAPTURE_CHANNEL = "desktop:native-keybinding-capture";

export interface NativeKeybindingCaptureInput {
  readonly key: "Escape";
  readonly metaKey: true;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export function nativeKeybindingCaptureInput(
  input: Pick<Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
): NativeKeybindingCaptureInput | null {
  const key = input.key.toLowerCase();
  if (input.type !== "keyDown" || (key !== "escape" && key !== "esc") || !input.meta) {
    return null;
  }

  return {
    key: "Escape",
    metaKey: true,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
  };
}

export function dispatchNativeKeybindingCaptureInput(input: unknown): void {
  if (
    typeof input !== "object" ||
    input === null ||
    !("key" in input) ||
    input.key !== "Escape" ||
    !("metaKey" in input) ||
    input.metaKey !== true ||
    !("ctrlKey" in input) ||
    typeof input.ctrlKey !== "boolean" ||
    !("altKey" in input) ||
    typeof input.altKey !== "boolean" ||
    !("shiftKey" in input) ||
    typeof input.shiftKey !== "boolean"
  ) {
    return;
  }

  const target = document.activeElement ?? document;

  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      code: "Escape",
      metaKey: input.metaKey,
      ctrlKey: input.ctrlKey,
      altKey: input.altKey,
      shiftKey: input.shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

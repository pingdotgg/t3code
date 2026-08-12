import type { Input } from "electron";

export const NATIVE_KEYBINDING_CAPTURE_CHANNEL = "desktop:native-keybinding-capture";

export interface NativeKeybindingCaptureInput {
  readonly key: "Escape";
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export function nativeKeybindingCaptureInput(
  input: Pick<Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
  platform: NodeJS.Platform,
): NativeKeybindingCaptureInput | null {
  const key = input.key.toLowerCase();
  const modPressed = platform === "darwin" ? input.meta : input.control;
  if (input.type !== "keyDown" || (key !== "escape" && key !== "esc") || !modPressed) {
    return null;
  }

  return {
    key: "Escape",
    metaKey: input.meta,
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
    typeof input.metaKey !== "boolean" ||
    !("ctrlKey" in input) ||
    typeof input.ctrlKey !== "boolean" ||
    (!input.metaKey && !input.ctrlKey) ||
    !("altKey" in input) ||
    typeof input.altKey !== "boolean" ||
    !("shiftKey" in input) ||
    typeof input.shiftKey !== "boolean"
  ) {
    return;
  }

  const activeElement = document.activeElement;
  const target = activeElement?.hasAttribute("data-keybinding-capture") ? activeElement : window;

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

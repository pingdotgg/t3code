import type { DesktopWindowTransparencyMode } from "@t3tools/contracts";

export function windowOpacityHint(input: {
  readonly mode: DesktopWindowTransparencyMode;
  readonly opacity: number;
  readonly appName: string;
}): string {
  const base = "Make the whole window see-through. 100% is fully opaque.";
  if (input.mode === "restart-required" && input.opacity < 100) {
    return `${base} On Linux, restart ${input.appName} once to apply it. Needs a compositing desktop.`;
  }
  if (input.mode === "compositor") {
    return `${base} On Linux, the in-app browser and preview stay opaque. Needs a compositing desktop.`;
  }
  return base;
}

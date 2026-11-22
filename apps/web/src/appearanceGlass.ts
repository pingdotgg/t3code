import type { GlassOpacity } from "@t3tools/contracts/settings";

export function applyGlassOpacity(root: HTMLElement, glassOpacity: GlassOpacity): void {
  root.style.setProperty("--glass-opacity", `${glassOpacity}%`);
  if (glassOpacity === 100) {
    root.style.setProperty("--glass-blur", "0px");
    // A solid glass needs no backdrop filter, and even blur(0px) still costs a
    // compositor pass per frame.
    root.style.setProperty("--glass-backdrop-filter", "none");
  } else {
    root.style.removeProperty("--glass-blur");
    root.style.removeProperty("--glass-backdrop-filter");
  }
}

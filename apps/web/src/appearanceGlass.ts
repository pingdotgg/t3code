/**
 * Fully opaque glass has nothing to blur; `blur(0px)` still forces Chromium
 * offscreen backdrop passes (and macOS high-refresh flicker), so drop the filter.
 */
export function applyGlassAppearance(root: HTMLElement, glassOpacity: number): void {
  root.style.setProperty("--glass-opacity", `${glassOpacity}%`);
  if (glassOpacity === 100) {
    root.style.setProperty("--glass-backdrop-filter", "none");
    root.style.setProperty("--dialog-backdrop-filter", "none");
  } else {
    root.style.removeProperty("--glass-backdrop-filter");
    root.style.removeProperty("--dialog-backdrop-filter");
  }
}

export function applyGlassAppearance(root: HTMLElement, opacity: number): void {
  root.style.setProperty("--glass-opacity", `${opacity}%`);
  if (opacity === 100) {
    root.style.setProperty("--glass-blur", "0px");
    root.style.setProperty("--dialog-backdrop-filter", "none");
  } else {
    root.style.removeProperty("--glass-blur");
    root.style.removeProperty("--dialog-backdrop-filter");
  }
}

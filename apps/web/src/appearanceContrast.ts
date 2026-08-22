import type { AppearanceContrast } from "@t3tools/contracts/settings";

export function applyAppearanceContrast(root: HTMLElement, contrast: AppearanceContrast): void {
  root.style.setProperty("--appearance-contrast-base", `${Math.min(contrast, 100)}%`);
  root.style.setProperty("--appearance-contrast-boost", `${Math.max(contrast - 100, 0)}%`);
  root.style.setProperty(
    "--appearance-contrast-border-boost",
    `${Math.max(contrast - 100, 0) / 4}%`,
  );
}

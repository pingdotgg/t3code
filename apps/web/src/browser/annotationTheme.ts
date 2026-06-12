import type { DesktopPreviewAnnotationTheme } from "@t3tools/contracts";

const readVariable = (styles: CSSStyleDeclaration, name: string, fallback: string): string =>
  styles.getPropertyValue(name).trim() || fallback;

export function readPreviewAnnotationTheme(): DesktopPreviewAnnotationTheme {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return {
    colorScheme: root.classList.contains("dark") ? "dark" : "light",
    radius: readVariable(styles, "--radius", "0.625rem"),
    background: readVariable(styles, "--background", "white"),
    foreground: readVariable(styles, "--foreground", "oklch(0.269 0 0)"),
    popover: readVariable(styles, "--popover", "white"),
    popoverForeground: readVariable(styles, "--popover-foreground", "oklch(0.269 0 0)"),
    primary: readVariable(styles, "--primary", "oklch(0.488 0.217 264)"),
    primaryForeground: readVariable(styles, "--primary-foreground", "white"),
    muted: readVariable(styles, "--muted", "rgb(0 0 0 / 4%)"),
    mutedForeground: readVariable(styles, "--muted-foreground", "oklch(0.556 0 0)"),
    accent: readVariable(styles, "--accent", "rgb(0 0 0 / 4%)"),
    accentForeground: readVariable(styles, "--accent-foreground", "oklch(0.269 0 0)"),
    border: readVariable(styles, "--border", "rgb(0 0 0 / 8%)"),
    input: readVariable(styles, "--input", "rgb(0 0 0 / 10%)"),
    ring: readVariable(styles, "--ring", "oklch(0.488 0.217 264)"),
    fontSans: readVariable(styles, "--font-sans", styles.fontFamily || "system-ui, sans-serif"),
    fontMono: readVariable(styles, "--font-mono", "ui-monospace, monospace"),
  };
}

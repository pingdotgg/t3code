import type { DesktopPreviewAnnotationTheme } from "@t3tools/contracts";

export function applyAnnotationTheme(
  host: HTMLElement,
  theme: DesktopPreviewAnnotationTheme | null,
): void {
  if (!theme) return;
  host.style.colorScheme = theme.colorScheme;
  const variables = {
    "--t3-radius": theme.radius,
    "--t3-background": theme.background,
    "--t3-foreground": theme.foreground,
    "--t3-popover": theme.popover,
    "--t3-popover-foreground": theme.popoverForeground,
    "--t3-primary": theme.primary,
    "--t3-primary-foreground": theme.primaryForeground,
    "--t3-muted": theme.muted,
    "--t3-muted-foreground": theme.mutedForeground,
    "--t3-accent": theme.accent,
    "--t3-accent-foreground": theme.accentForeground,
    "--t3-border": theme.border,
    "--t3-input": theme.input,
    "--t3-ring": theme.ring,
    "--t3-font-sans": theme.fontSans,
    "--t3-font-mono": theme.fontMono,
  };
  for (const [name, value] of Object.entries(variables)) {
    host.style.setProperty(name, value);
  }
}

// Files live in apps/web/public/app-icons, which the web build ships and the desktop app reads.
export const APP_ICONS = [
  { id: "black", label: "Black" },
  { id: "orbital-sunrise", label: "Orbital Sunrise" },
  { id: "sunrise", label: "Sunrise" },
  { id: "blueprint", label: "Blueprint" },
  { id: "classic-blueprint", label: "Classic Blueprint" },
  { id: "classic-dev", label: "Classic Dev" },
] as const;

export type AppIconId = (typeof APP_ICONS)[number]["id"];

export const DEFAULT_APP_ICON = "default";

/** Null means the build's own icon, including for ids this version does not ship. */
export function resolveAppIconId(value: string): AppIconId | null {
  return APP_ICONS.find((icon) => icon.id === value)?.id ?? null;
}

/** macOS icons keep the Dock's safe area; the others fill the canvas like the Windows and Linux icons. */
export function appIconFileName(id: AppIconId, variant: "macos" | "universal" | "favicon"): string {
  if (variant === "macos") return `${id}-macos.png`;
  if (variant === "favicon") return `${id}-32.png`;
  return `${id}.png`;
}

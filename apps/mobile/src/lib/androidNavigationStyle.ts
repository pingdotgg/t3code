export type AndroidNavigationStyle = "one-ui" | "material";

export function resolveAndroidNavigationStyle(
  preference: AndroidNavigationStyle | undefined,
  manufacturer: string | null,
  previewEnabled: boolean,
): AndroidNavigationStyle {
  return (
    preference ??
    (manufacturer?.toLowerCase() === "samsung" || previewEnabled ? "one-ui" : "material")
  );
}

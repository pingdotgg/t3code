/**
 * Standalone builds move a stored stock theme (`system`, `light`, `dark`) to EasyDev once.
 * "record" marks the migration done without changing the theme, so a later pick of the stock
 * theme is never overridden.
 */
export function standaloneThemeMigration(input: {
  readonly standalone: boolean;
  readonly migrated: boolean;
  readonly storedTheme: string | null;
  readonly hasThemeHalves: boolean;
}): "adopt" | "record" | null {
  if (!input.standalone || input.migrated) return null;
  const stock =
    input.storedTheme === "system" || input.storedTheme === "light" || input.storedTheme === "dark";
  return stock && !input.hasThemeHalves ? "adopt" : "record";
}

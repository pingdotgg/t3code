import type { MobileThemeAppearance, MobileThemeVariables } from "./mobileTheme";
import type { MaterialYouPalette } from "./materialYouPalette";

export function materialYouPaletteToMobileThemeVariables(
  _palette: MaterialYouPalette,
  _appearance: MobileThemeAppearance,
  base: MobileThemeVariables,
): MobileThemeVariables {
  return base;
}

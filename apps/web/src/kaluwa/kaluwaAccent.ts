// Fork: provider accents picked from Kaluwa's palette are stored as plain hex, which the contract
// and mobile need, and shown as the same swatch of whatever palette is current.
import { kaluwaSwatchSlotForHex } from "./kaluwaPalette";
import { IS_KALUWA_BUILD } from "./kaluwaLook";

export function kaluwaAccentColor(hex: string): string {
  if (!IS_KALUWA_BUILD) return hex;
  const slot = kaluwaSwatchSlotForHex(hex);
  return slot === null ? hex : `var(--kaluwa-swatch-${slot}, ${hex})`;
}

// Fork: provider accents picked from Kaluwa's palette are stored as plain hex, which the contract
// and mobile need, and shown as the same swatch of whatever palette is current.
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";

import { kaluwaSwatchSlotForHex } from "./kaluwaPalette";
import { getKaluwaLookSnapshot, IS_KALUWA_BUILD, type KaluwaLookSnapshot } from "./kaluwaLook";
import { kaluwaNearestSwatchSlot } from "./kaluwaNearestSwatch";

/**
 * An accent as Kaluwa paints it. A swatch hex becomes that swatch of the current palette; with
 * palette status colours on, any other hex (an accent set before palettes existed) becomes its
 * nearest swatch, so no off-palette colour leaks into badges, icons or usage rings.
 */
export function kaluwaAccentColorFor(hex: string, look: KaluwaLookSnapshot): string {
  const slot =
    kaluwaSwatchSlotForHex(hex) ??
    (look.look.statusColors === "palette" ? kaluwaNearestSwatchSlot(hex, look.palette) : null);
  return slot === null ? hex : `var(--kaluwa-swatch-${slot}, ${look.palette[slot]})`;
}

export function kaluwaAccentColor(hex: string): string {
  if (!IS_KALUWA_BUILD) return hex;
  return kaluwaAccentColorFor(hex, getKaluwaLookSnapshot());
}

/** A provider instance's accent as Kaluwa paints it, or undefined when it has none. */
export function kaluwaInstanceAccent(accentColor: string | undefined): string | undefined {
  const accent = normalizeProviderAccentColor(accentColor);
  return accent === undefined ? undefined : kaluwaAccentColor(accent);
}

/**
 * The wallpaper preference from Settings → Appearance, applied as CSS custom
 * properties on the root element. The image paints on a fixed layer behind the
 * app, under a wash of the theme's own chrome color at whatever strength the
 * opacity preference leaves. While one is active (`html[data-wallpaper]`) the
 * workspace canvas clears so that layer becomes the canvas, and the sidebar
 * goes translucent at the existing glass opacity so the image ghosts through
 * it too. See the wallpaper rules in `index.css`.
 */

import {
  DEFAULT_WALLPAPER_OPACITY,
  MAX_WALLPAPER_OPACITY,
  MIN_WALLPAPER_OPACITY,
} from "@t3tools/contracts";

export interface AppearanceWallpaperPreferences {
  /** Image URL — normally a data URL; empty means no wallpaper. */
  readonly image: string;
  /** How strongly the image reads as the app canvas, in percent. */
  readonly opacity: number;
}

/**
 * The CSS `url()` value an image preference resolves to, or null when the
 * preference is effectively empty. The stored value is only length-checked by
 * the settings schema, so it is escaped here: JSON string escaping is also
 * valid CSS string escaping for `"` and `\`, which are the only characters
 * that could otherwise close the token and inject declarations after it.
 */
export function cssWallpaperImage(image: string): string | null {
  const trimmed = image.trim();
  if (trimmed.length === 0) return null;
  return `url(${JSON.stringify(trimmed)})`;
}

export function clampWallpaperOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WALLPAPER_OPACITY;
  return Math.min(MAX_WALLPAPER_OPACITY, Math.max(MIN_WALLPAPER_OPACITY, Math.round(value)));
}

/**
 * Apply the preference to the root element. An empty image removes the marker
 * attribute and both variables, so every wallpaper rule stops matching and the
 * canvas and sidebar go back to painting themselves opaque.
 */
export function applyAppearanceWallpaper(
  root: HTMLElement,
  preferences: AppearanceWallpaperPreferences,
): void {
  const image = cssWallpaperImage(preferences.image);
  if (image === null) {
    delete root.dataset.wallpaper;
    root.style.removeProperty("--wallpaper-image");
    root.style.removeProperty("--wallpaper-opacity");
    return;
  }

  root.dataset.wallpaper = "";
  root.style.setProperty("--wallpaper-image", image);
  root.style.setProperty("--wallpaper-opacity", `${clampWallpaperOpacity(preferences.opacity)}%`);
}

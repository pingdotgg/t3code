import { useEffect } from "react";

import { useAppSettings } from "../appSettings";
import { getInteractiveOpacityRate, interactiveOpacity, nestedOpacity } from "../lib/colorThemes";
import { resolveBackgroundImageUrl } from "../lib/wallpapers";

export function BackgroundLayer() {
  const { settings } = useAppSettings();
  const { backgroundImage, backgroundOpacity, backgroundBlur, colorThemeId } = settings;

  useEffect(() => {
    const root = document.documentElement;
    if (backgroundImage) {
      root.setAttribute("data-has-wallpaper", "true");

      const rate = getInteractiveOpacityRate(colorThemeId || undefined);
      const overlayPct = `${Math.round(backgroundOpacity * 100)}%`;
      const interactivePct = `${Math.round(interactiveOpacity(backgroundOpacity, rate * 0.4) * 100)}%`;
      const nestedPct = `${Math.round(nestedOpacity(backgroundOpacity, rate) * 100)}%`;

      root.style.setProperty("--wp-overlay", overlayPct);
      root.style.setProperty("--wp-interactive", interactivePct);
      root.style.setProperty("--wp-nested", nestedPct);
    } else {
      root.removeAttribute("data-has-wallpaper");
      root.style.removeProperty("--wp-overlay");
      root.style.removeProperty("--wp-interactive");
      root.style.removeProperty("--wp-nested");
    }
    return () => {
      root.removeAttribute("data-has-wallpaper");
      root.style.removeProperty("--wp-overlay");
      root.style.removeProperty("--wp-interactive");
      root.style.removeProperty("--wp-nested");
    };
  }, [backgroundImage, backgroundOpacity, colorThemeId]);

  if (!backgroundImage) return null;

  const imageUrl = resolveBackgroundImageUrl(backgroundImage);
  const overlayPercent = Math.round(backgroundOpacity * 100);

  return (
    <>
      {/* Wallpaper image layer */}
      <div
        className="pointer-events-none fixed"
        style={{
          zIndex: -20,
          inset: `-${backgroundBlur + 8}px`,
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
        }}
      />
      {/* Color overlay */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          zIndex: -10,
          backgroundColor: `color-mix(in srgb, var(--background) ${overlayPercent}%, transparent)`,
        }}
      />
    </>
  );
}

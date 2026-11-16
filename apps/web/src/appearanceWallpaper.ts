import type { ClientSettings } from "@t3tools/contracts/settings";

import f1RaceWallpaperUrl from "./assets/wallpapers/f1-race.svg";

type WallpaperSettings = Pick<ClientSettings, "wallpaper" | "wallpaperBlur" | "wallpaperDim">;

const WALLPAPER_URLS: Record<Exclude<ClientSettings["wallpaper"], "none">, string> = {
  "f1-race": f1RaceWallpaperUrl,
};

/** index.css paints the wallpaper from these variables while `data-wallpaper` is set. */
export function applyWallpaper(root: HTMLElement, settings: WallpaperSettings): void {
  if (settings.wallpaper === "none") {
    delete root.dataset.wallpaper;
    root.style.removeProperty("--wallpaper-image");
    root.style.removeProperty("--wallpaper-blur");
    root.style.removeProperty("--wallpaper-dim");
    return;
  }
  root.dataset.wallpaper = settings.wallpaper;
  root.style.setProperty("--wallpaper-image", `url("${WALLPAPER_URLS[settings.wallpaper]}")`);
  root.style.setProperty("--wallpaper-blur", `${settings.wallpaperBlur}px`);
  root.style.setProperty("--wallpaper-dim", `${settings.wallpaperDim}%`);
}

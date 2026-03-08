export interface WallpaperPreset {
  id: string;
  name: string;
  file: string;
}

export const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  { id: "preset:ship-at-sea", name: "Ship at Sea", file: "ship-at-sea.jpg" },
  { id: "preset:akane-pagoda", name: "Akane Pagoda", file: "akane-pagoda.jpg" },
  { id: "preset:everforest", name: "Everforest", file: "everforest.jpg" },
  { id: "preset:gruvbox-ferns", name: "Gruvbox Ferns", file: "gruvbox-ferns.jpg" },
  { id: "preset:akane-cliff", name: "Akane Cliff", file: "akane-cliff.jpg" },
  { id: "preset:akane-bridge", name: "Akane Bridge", file: "akane-bridge.jpg" },
  { id: "preset:akane-mist", name: "Akane Mist", file: "akane-mist.jpg" },
  { id: "preset:pink-lakeside", name: "Pink Lakeside", file: "pink-lakeside.png" },
] as const;

export function getWallpaperUrl(preset: WallpaperPreset): string {
  return `/wallpapers/${preset.file}`;
}

export function resolveBackgroundImageUrl(value: string): string {
  const preset = WALLPAPER_PRESETS.find((p) => p.id === value);
  if (preset) return getWallpaperUrl(preset);
  return value;
}

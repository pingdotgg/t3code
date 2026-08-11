import { describe, expect, it } from "vite-plus/test";

import {
  applyAppearanceWallpaper,
  clampWallpaperOpacity,
  cssWallpaperImage,
} from "./appearanceWallpaper";

/** The unit suite runs without a DOM, so stand in for the pieces used here. */
function createRoot() {
  const variables = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string | undefined>,
    style: {
      setProperty: (name: string, value: string) => {
        variables.set(name, value);
      },
      removeProperty: (name: string) => {
        variables.delete(name);
      },
    },
  };
  return { root: root as unknown as HTMLElement, dataset: root.dataset, variables };
}

describe("cssWallpaperImage", () => {
  it("returns null for effectively empty input", () => {
    expect(cssWallpaperImage("")).toBeNull();
    expect(cssWallpaperImage("   ")).toBeNull();
  });

  it("wraps the trimmed URL in a quoted url() token", () => {
    expect(cssWallpaperImage(" data:image/webp;base64,AAAA ")).toBe(
      'url("data:image/webp;base64,AAAA")',
    );
  });

  it("escapes quotes and backslashes so the URL cannot break out of the token", () => {
    expect(cssWallpaperImage('https://example.com/a")}body{background:red;}#x("')).toBe(
      'url("https://example.com/a\\")}body{background:red;}#x(\\"")',
    );
    expect(cssWallpaperImage("https://example.com/a\\b")).toBe('url("https://example.com/a\\\\b")');
  });
});

describe("clampWallpaperOpacity", () => {
  it("clamps to the supported range and rounds to whole percent", () => {
    expect(clampWallpaperOpacity(0)).toBe(5);
    expect(clampWallpaperOpacity(45.4)).toBe(45);
    expect(clampWallpaperOpacity(200)).toBe(80);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampWallpaperOpacity(Number.NaN)).toBe(15);
    expect(clampWallpaperOpacity(Number.POSITIVE_INFINITY)).toBe(15);
  });
});

describe("applyAppearanceWallpaper", () => {
  it("marks the root and writes both variables while a wallpaper is set", () => {
    const { root, dataset, variables } = createRoot();

    applyAppearanceWallpaper(root, { image: "data:image/webp;base64,AAAA", opacity: 45 });

    expect(dataset.wallpaper).toBe("");
    expect(variables.get("--wallpaper-image")).toBe('url("data:image/webp;base64,AAAA")');
    expect(variables.get("--wallpaper-opacity")).toBe("45%");
  });

  it("removes the marker and both variables when the image is cleared", () => {
    const { root, dataset, variables } = createRoot();

    applyAppearanceWallpaper(root, { image: "data:image/webp;base64,AAAA", opacity: 45 });
    applyAppearanceWallpaper(root, { image: "", opacity: 45 });

    expect("wallpaper" in dataset).toBe(false);
    expect(variables.size).toBe(0);
  });
});

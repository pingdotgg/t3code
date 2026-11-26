// Fork: the colours Kaluwa's backdrop art is drawn in, read from the live theme. They are
// resolved again only when the root element's class or inline style changes (theme switch).
import { useSyncExternalStore } from "react";

import type { Rgb } from "./backdropRender";
import { BACKDROP_SWATCHES, type BackdropSwatch } from "./backdropSettings";

export interface BackdropPalette {
  readonly accent: Rgb;
  readonly background: Rgb;
  readonly dark: boolean;
  /** Only swatches the theme defines. */
  readonly swatches: Partial<Record<BackdropSwatch, Rgb>>;
}

const FALLBACK: BackdropPalette = {
  accent: [91, 140, 255],
  background: [0, 0, 0],
  dark: true,
  swatches: {},
};

let palette: BackdropPalette = FALLBACK;
let paletteKey = "";
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

let pixel: OffscreenCanvasRenderingContext2D | null = null;
function toRgb(color: string): Rgb | null {
  if (!color) return null;
  pixel ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  if (!pixel) return null;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = "#000";
  pixel.fillStyle = color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function readPalette(): BackdropPalette {
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  // A probe resolves var() chains and color-mix() into one computed colour string.
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  const resolve = (expression: string) => {
    probe.style.color = "";
    probe.style.color = expression;
    return toRgb(getComputedStyle(probe).color);
  };
  const swatches: Partial<Record<BackdropSwatch, Rgb>> = {};
  for (const name of BACKDROP_SWATCHES) {
    const variable = `--kaluwa-swatch-${name}`;
    if (!rootStyle.getPropertyValue(variable).trim()) continue;
    const rgb = resolve(`var(${variable})`);
    if (rgb) swatches[name] = rgb;
  }
  const next: BackdropPalette = {
    accent: resolve("var(--primary)") ?? FALLBACK.accent,
    background: resolve("var(--background)") ?? FALLBACK.background,
    dark: root.classList.contains("dark"),
    swatches,
  };
  probe.remove();
  return next;
}

function refresh() {
  const next = readPalette();
  const key = JSON.stringify(next);
  if (key === paletteKey) return;
  paletteKey = key;
  palette = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      paletteKey = "";
    }
  };
}

const getSnapshot = () => palette;

export function useBackdropPalette(): BackdropPalette {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function backdropColor(
  current: BackdropPalette,
  colorMode: "accent" | "swatch",
  swatch: BackdropSwatch,
): Rgb {
  return colorMode === "swatch" ? (current.swatches[swatch] ?? current.accent) : current.accent;
}

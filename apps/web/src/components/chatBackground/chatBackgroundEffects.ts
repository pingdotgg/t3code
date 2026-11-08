// Effect algorithms adapted from monocode (MIT, Copyright (c) 2026 Nick),
// src/features/settings/model/newThreadBackgroundEffects.worker.ts.
import type { ChatBackgroundEffect } from "@t3tools/contracts";

export interface EffectSource {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

const GLYPHS = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 4, 0],
  [0, 4, 0, 0, 4, 0, 0],
  [0, 0, 0, 14, 0, 0, 0],
  [0, 0, 14, 0, 14, 0, 0],
  [0, 4, 4, 31, 4, 4, 0],
  [0, 21, 14, 31, 14, 21, 0],
  [10, 10, 31, 10, 31, 10, 10],
  [17, 2, 4, 4, 8, 16, 17],
  [14, 17, 23, 21, 23, 16, 14],
] as const;

const index = (source: EffectSource, x: number, y: number) =>
  Math.min(source.height - 1, y) * source.width + Math.min(source.width - 1, x);

const lumaAt = (pixels: Uint8ClampedArray, pixel: number) =>
  pixels[pixel * 4]! * 0.2126 + pixels[pixel * 4 + 1]! * 0.7152 + pixels[pixel * 4 + 2]! * 0.0722;

function dither(source: EffectSource) {
  const { width, height, pixels } = source;
  const output = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const base = index(source, x + 1, y + 1) * 4;
      const r = pixels[base]!;
      const g = pixels[base + 1]!;
      const b = pixels[base + 2]!;
      const peak = Math.max(r, g, b);
      const threshold = BAYER[(y / 2) % 4]![(x / 2) % 4]!;
      const gain = peak / 255 > (threshold + 0.5) / 16 ? 255 / Math.max(peak, 1) : 0.08;
      for (let dy = 0; dy < Math.min(2, height - y); dy += 1) {
        for (let dx = 0; dx < Math.min(2, width - x); dx += 1) {
          const out = ((y + dy) * width + x + dx) * 4;
          output[out] = r * gain;
          output[out + 1] = g * gain;
          output[out + 2] = b * gain;
          output[out + 3] = pixels[base + 3]!;
        }
      }
    }
  }
  return output;
}

function ascii(source: EffectSource, light: boolean) {
  const { width, height, pixels } = source;
  const output = new Uint8ClampedArray(pixels.length);
  const paper = light ? 255 : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sample = index(source, Math.floor(x / 6) * 6 + 3, Math.floor(y / 8) * 8 + 4);
      const luma = lumaAt(pixels, sample);
      const density = light ? 255 - luma : luma;
      const glyph = GLYPHS[Math.floor(Math.sqrt(density / 255) * 9)]!;
      const ink = x % 6 < 5 && y % 8 < 7 && (glyph[y % 8]! & (1 << (4 - (x % 6)))) !== 0;
      const out = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const texture = ink ? pixels[sample * 4 + channel]! : paper;
        output[out + channel] = pixels[out + channel]! * 0.6 + texture * 0.4;
      }
      output[out + 3] = pixels[out + 3]!;
    }
  }
  return output;
}

function halftone(source: EffectSource, light: boolean) {
  const { width, height, pixels } = source;
  const output = new Uint8ClampedArray(pixels.length);
  const paper = light ? 255 : 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const luma = lumaAt(pixels, index(source, x, y));
      const radius = 2 * (0.3 + 0.7 * Math.sqrt((light ? 255 - luma : luma) / 255));
      const dot = index(source, x + 2, y + 2) * 4;
      for (let dy = 0; dy < Math.min(4, height - y); dy += 1) {
        for (let dx = 0; dx < Math.min(4, width - x); dx += 1) {
          const coverage =
            Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx - 1.5, dy - 1.5))) *
            (pixels[dot + 3]! / 255);
          const out = ((y + dy) * width + x + dx) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            const texture = pixels[dot + channel]! * coverage + paper * (1 - coverage);
            output[out + channel] = pixels[out + channel]! * 0.6 + texture * 0.4;
          }
          output[out + 3] = pixels[out + 3]!;
        }
      }
    }
  }
  return output;
}

function scanlines(source: EffectSource, light: boolean) {
  const { width, height, pixels } = source;
  const output = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y += 1) {
    const gain = y % 3 === 0 ? 0.52 : 1;
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = pixels[out + channel]!;
        output[out + channel] = light ? value + (255 - value) * (1 - gain) : value * gain;
      }
      output[out + 3] = pixels[out + 3]!;
    }
  }
  return output;
}

export function applyChatBackgroundEffect(
  source: EffectSource,
  effect: Exclude<ChatBackgroundEffect, "none">,
  light: boolean,
): Uint8ClampedArray {
  switch (effect) {
    case "dither":
      return dither(source);
    case "ascii":
      return ascii(source, light);
    case "halftone":
      return halftone(source, light);
    case "scanlines":
      return scanlines(source, light);
  }
}

// Fork: draws one frame of Kaluwa's backdrop art into an OffscreenCanvas. It runs once per
// settings, theme or size change, never per animation frame.
import {
  adjustedLuminance,
  bayerThreshold,
  bottomPlacementFactor,
  clamp,
  composerFadeFactor,
  errorDiffusionDither,
  fbm,
  hash,
  heroFadeFactor,
  mixRgb,
  orderedDither,
  placeImage,
} from "./backdropMath";
import { buildSceneField, TEXTURED_ARTS, type SceneAssets } from "./backdropScenes";
import type { BackdropImageSettings, GeneratedArt } from "./backdropSettings";

export type Rgb = readonly [number, number, number];

export type BackdropSource =
  | { readonly kind: "generated"; readonly art: GeneratedArt }
  | {
      readonly kind: "image";
      readonly bitmap: ImageBitmap;
      readonly settings: BackdropImageSettings;
    };

export interface BackdropRenderRequest {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly source: BackdropSource;
  readonly pattern: "scatter" | "ordered";
  readonly shape: "square" | "round";
  readonly cell: number;
  /** 0..100 */
  readonly density: number;
  /** 0..100, how much the art clears under the composer. */
  readonly fade: number;
  readonly bottom: boolean;
  /** Clear the area under a bottom-docked composer. */
  readonly dock: boolean;
  /** Vertical centre (0..1) of a headline to keep readable, or null. */
  readonly heroY: number | null;
  readonly seed: number;
  readonly color: Rgb;
  readonly background: Rgb;
  readonly dark: boolean;
}

const rgba = ([r, g, b]: Rgb, alpha = 1) => `rgba(${r},${g},${b},${alpha})`;

function imageField(
  bitmap: ImageBitmap,
  settings: BackdropImageSettings,
  cols: number,
  rows: number,
  dark: boolean,
): Float32Array {
  const canvas = new OffscreenCanvas(cols, rows);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high";
  const place = placeImage(
    bitmap.width,
    bitmap.height,
    cols,
    rows,
    settings.fit,
    settings.focusX / 100,
    settings.focusY / 100,
  );
  g.drawImage(bitmap, place.x, place.y, place.width, place.height);
  const pixels = g.getImageData(0, 0, cols, rows).data;
  const field = new Float32Array(cols * rows);
  // On a light theme the dots are dark ink, so the image is inverted unless asked otherwise.
  const invert = settings.invert !== !dark;
  for (let i = 0; i < field.length; i++) {
    const luminance = adjustedLuminance(
      pixels[i * 4]!,
      pixels[i * 4 + 1]!,
      pixels[i * 4 + 2]!,
      settings.contrast,
      settings.brightness,
      invert,
    );
    field[i] = luminance * (pixels[i * 4 + 3]! / 255);
  }
  return field;
}

function drawPhoto(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  request: BackdropRenderRequest,
  settings: BackdropImageSettings,
) {
  const { width, height } = request;
  const place = placeImage(
    bitmap.width,
    bitmap.height,
    width,
    height,
    settings.fit,
    settings.focusX / 100,
    settings.focusY / 100,
  );
  const blur = settings.blur;
  if (blur > 0) ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(
    bitmap,
    place.x - blur,
    place.y - blur,
    place.width + blur * 2,
    place.height + blur * 2,
  );
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-atop";
  if (settings.tint > 0) {
    ctx.globalAlpha = settings.tint / 100;
    ctx.fillStyle = rgba(request.color);
    ctx.fillRect(0, 0, width, height);
  }
  if (settings.wash > 0) {
    ctx.globalAlpha = settings.wash / 100;
    ctx.fillStyle = rgba(request.background);
    ctx.fillRect(0, 0, width, height);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "destination-out";
  if (request.bottom) {
    const clear = ctx.createLinearGradient(0, height * 0.25, 0, height * 0.8);
    clear.addColorStop(0, "rgba(0,0,0,1)");
    clear.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = clear;
    ctx.fillRect(0, 0, width, height);
  }
  if (request.dock && request.fade > 0) {
    const fade = request.fade / 100;
    ctx.save();
    ctx.translate(width / 2, height * 1.02);
    ctx.scale(width * 0.62, height * 0.46);
    const clear = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    clear.addColorStop(0, `rgba(0,0,0,${fade})`);
    clear.addColorStop(0.55, `rgba(0,0,0,${fade * 0.8})`);
    clear.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = clear;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Renders the backdrop, or returns null when there is nothing to draw. */
export function renderBackdrop(
  request: BackdropRenderRequest,
  assets: SceneAssets,
): OffscreenCanvas | null {
  const { width, height, dpr, source, cell } = request;
  if (width < 4 || height < 4) return null;
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(width * dpr)),
    Math.max(1, Math.round(height * dpr)),
  );
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (source.kind === "image" && source.settings.mode === "photo") {
    drawPhoto(ctx, source.bitmap, request, source.settings);
    return canvas;
  }

  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const image = source.kind === "image" ? source : null;
  const art = source.kind === "generated" ? source.art : null;
  const field = image
    ? imageField(image.bitmap, image.settings, cols, rows, request.dark)
    : buildSceneField(art!, cols, rows, request.seed, assets);

  const gain = image ? request.density / 50 : 0.3 + (request.density / 100) * 1.7;
  const fade = request.fade / 100;
  const texture = art ? TEXTURED_ARTS[art] : undefined;
  const halftone = art === "halftone";
  const seed = request.seed;
  for (let y = 0; y < rows; y++) {
    const ny = y / rows;
    for (let x = 0; x < cols; x++) {
      const nx = x / cols;
      const index = y * cols + x;
      let value = field[index]!;
      if (texture) {
        value *= texture[0] + texture[1] * fbm(x * texture[2], y * texture[2], seed);
        if (hash(x, y, seed + 5) > 0.985) value += 0.22 * fbm(x * 0.02, y * 0.02, seed + 3);
      } else if (art === "grain") {
        value *= 0.5 + fbm(x * 0.05, y * 0.05, seed);
      }
      if (request.bottom) value *= bottomPlacementFactor(ny);
      if (request.dock) value *= composerFadeFactor(nx, ny, fade);
      if (request.heroY !== null) value *= heroFadeFactor(nx, ny, request.heroY, fade);
      if (art && request.pattern === "ordered" && !halftone)
        value = Math.max(0, value - 0.07) * 1.08;
      field[index] = value * gain;
    }
  }

  const base = new Path2D();
  const hot = new Path2D();
  const dot = Math.max(1, cell * (halftone ? 1 : 0.68));
  const round = request.shape === "round";
  const add = (path: Path2D, x: number, y: number, size: number) => {
    if (round) {
      path.moveTo(x + cell / 2 + size / 2, y + cell / 2);
      path.arc(x + cell / 2, y + cell / 2, size / 2, 0, Math.PI * 2);
    } else {
      path.rect(x + (cell - size) / 2, y + (cell - size) / 2, size, size);
    }
  };

  if (image && image.settings.dither !== "ordered") {
    const on = errorDiffusionDither(
      field,
      cols,
      rows,
      image.settings.threshold / 100,
      image.settings.dither,
    );
    for (let index = 0; index < on.length; index++) {
      if (on[index]) add(base, (index % cols) * cell, Math.floor(index / cols) * cell, dot);
    }
  } else if (image) {
    const on = orderedDither(field, cols, rows, image.settings.threshold / 100);
    for (let index = 0; index < on.length; index++) {
      if (!on[index]) continue;
      const x = index % cols;
      const y = Math.floor(index / cols);
      const over = field[index]! - (bayerThreshold(x, y) + image.settings.threshold / 100 - 0.5);
      add(over > 0.55 ? hot : base, x * cell, y * cell, dot);
    }
  } else {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const value = field[y * cols + x]!;
        if (halftone) {
          const size = dot * Math.sqrt(clamp(value)) * 0.92;
          if (size > 0.9) add(value > 0.75 ? hot : base, x * cell, y * cell, size);
          continue;
        }
        const ordered = bayerThreshold(x, y);
        const threshold =
          request.pattern === "ordered"
            ? ordered
            : art === "grain"
              ? hash(x, y, seed)
              : 0.3 * ordered + 0.7 * hash(x, y, seed);
        if (value > threshold) add(value - threshold > 0.55 ? hot : base, x * cell, y * cell, dot);
      }
    }
  }

  ctx.fillStyle = rgba(request.color, 0.82);
  ctx.fill(base);
  ctx.fillStyle = rgba(
    request.dark
      ? mixRgb(request.color, [255, 255, 255], 0.22)
      : mixRgb(request.color, [0, 0, 0], 0.18),
  );
  ctx.fill(hot);
  return canvas;
}

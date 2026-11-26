// Fork: Kaluwa's original backdrop artworks. Each scene paints white light on black into a
// small canvas (one pixel per dither cell); the renderer reads its brightness as a field.
import { clamp, fbm, hash, smoothstep, valueNoise } from "./backdropMath";
import type { GeneratedArt } from "./backdropSettings";

type Ctx = OffscreenCanvasRenderingContext2D;
export type SceneAssets = { readonly horse: ImageBitmap | null };
type Scene = (g: Ctx, w: number, h: number, seed: number, assets: SceneAssets) => void;

const white = (alpha: number) => `rgba(255,255,255,${alpha})`;

function glow(g: Ctx, w: number, h: number, x: number, y: number, r: number, alpha: number) {
  const gradient = g.createRadialGradient(x, y, 0, x, y, r);
  gradient.addColorStop(0, white(alpha));
  gradient.addColorStop(1, white(0));
  g.fillStyle = gradient;
  g.fillRect(0, 0, w, h);
}

function horseSprite(horse: ImageBitmap | null, width: number, height: number) {
  const sprite = new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
  if (!horse) return sprite;
  const g = sprite.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(horse, 0, 0, sprite.width, sprite.height);
  g.globalCompositeOperation = "source-in";
  const shade = g.createLinearGradient(0, 0, sprite.width, sprite.height);
  shade.addColorStop(0, "#fff");
  shade.addColorStop(0.55, "#c4c4c4");
  shade.addColorStop(1, "#7e7e7e");
  g.fillStyle = shade;
  g.fillRect(0, 0, sprite.width, sprite.height);
  return sprite;
}

const horseRatio = (horse: ImageBitmap | null) =>
  horse ? horse.width / Math.max(1, horse.height) : 0.7;

function band(
  g: Ctx,
  w: number,
  h: number,
  curve: (x: number) => number,
  y0: number,
  y1: number,
  topAlpha: number,
  lineAlpha: number,
  mid = 0.17,
) {
  const path = new Path2D();
  path.moveTo(0, curve(0));
  for (let x = 1; x <= w; x++) path.lineTo(x, curve(x));
  const crest = new Path2D(path);
  path.lineTo(w, h);
  path.lineTo(0, h);
  path.closePath();
  g.globalAlpha = 1;
  g.fillStyle = "rgba(0,0,0,.84)";
  g.fill(path);
  const gradient = g.createLinearGradient(0, y0, 0, y1);
  gradient.addColorStop(0, white(topAlpha));
  gradient.addColorStop(0.3, white(mid));
  gradient.addColorStop(1, white(0));
  g.fillStyle = gradient;
  g.fill(path);
  g.strokeStyle = white(lineAlpha);
  g.lineWidth = Math.max(1, h * 0.006);
  g.stroke(crest);
}

function drawWaves(g: Ctx, w: number, h: number, top: number, count: number, seed: number) {
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    const base = h * (top + (1 - top) * (i / count) * 0.92);
    const amp = h * (0.05 - t * 0.018);
    const freq = 1.1 + hash(i, 3, seed) * 1.3;
    const phase = hash(i, 9, seed) * 6.28;
    const curve = (x: number) =>
      base +
      amp * Math.sin((x / w) * 6.283 * freq + phase) +
      amp * 0.42 * Math.sin((x / w) * 6.283 * freq * 2.3 + phase * 1.7);
    band(g, w, h, curve, base - amp * 1.4, base + h * 0.2, 0.66 - t * 0.2, 0.85 - t * 0.25);
  }
}

function petal(
  g: Ctx,
  x: number,
  y: number,
  rotation: number,
  length: number,
  width: number,
  alpha: number,
  lineWidth: number,
) {
  g.save();
  g.translate(x, y);
  g.rotate(rotation);
  const p = new Path2D();
  p.moveTo(0, 0);
  p.bezierCurveTo(-width, -length * 0.35, -width * 0.75, -length * 0.8, 0, -length);
  p.bezierCurveTo(width * 0.75, -length * 0.8, width, -length * 0.35, 0, 0);
  g.fillStyle = "rgba(0,0,0,.86)";
  g.fill(p);
  const gradient = g.createLinearGradient(0, 0, 0, -length);
  gradient.addColorStop(0, white(alpha * 0.1));
  gradient.addColorStop(1, white(alpha * 0.8));
  g.fillStyle = gradient;
  g.fill(p);
  g.strokeStyle = white(alpha * 0.9);
  g.lineWidth = lineWidth;
  g.stroke(p);
  g.restore();
}

const SCENES: Record<Exclude<GeneratedArt, "contours">, Scene> = {
  horse(g, w, h, seed, { horse }) {
    const hh = h * 0.86;
    const hw = hh * horseRatio(horse);
    const hx = clamp(w * 0.72 - hw / 2, w * 0.5 - hw * 0.2, w - hw * 1.02);
    const hy = h * 0.04;
    glow(g, w, h, hx + hw * 0.5, hy + hh * 0.42, Math.max(w, h) * 0.5, 0.3);
    const sprite = horseSprite(horse, hw, hh);
    g.filter = `blur(${Math.max(2, h * 0.035)}px)`;
    g.globalAlpha = 0.24;
    g.drawImage(sprite, hx, hy);
    g.filter = "none";
    g.globalAlpha = 1;
    g.drawImage(sprite, hx, hy);
    drawWaves(g, w, h, 0.7, 4, seed);
  },
  herd(g, w, h, seed, { horse }) {
    glow(g, w, h, w * 0.55, h * 0.5, Math.max(w, h) * 0.5, 0.26);
    const herd: ReadonlyArray<readonly [number, number, number]> = [
      [0.13, 0.32, 0.5],
      [0.38, 0.48, 0.74],
      [0.73, 0.74, 1],
    ];
    herd.forEach(([cx, heightFactor, alpha], n) => {
      const hh = h * heightFactor;
      const hw = hh * horseRatio(horse);
      const x = w * cx - hw / 2;
      const y = h * 0.82 - hh;
      for (let k = 0; k < 14; k++) {
        const sy = y + hh * (0.18 + 0.62 * hash(k, n, seed));
        const sx = x + hw * (0.5 + 0.35 * hash(k, n + 7, seed));
        const len = w * (0.06 + 0.2 * hash(k, n + 13, seed));
        const streak = g.createLinearGradient(sx, 0, sx + len, 0);
        streak.addColorStop(0, white(alpha * 0.6));
        streak.addColorStop(1, white(0));
        g.fillStyle = streak;
        g.fillRect(sx, sy, len, Math.max(1, h * 0.006));
      }
      g.globalAlpha = alpha;
      g.drawImage(horseSprite(horse, hw, hh), x, y);
      g.globalAlpha = 1;
    });
    drawWaves(g, w, h, 0.8, 3, seed);
  },
  waves(g, w, h, seed) {
    glow(g, w, h, w * 0.82, h * 0.12, Math.max(w, h) * 0.6, 0.26);
    drawWaves(g, w, h, 0.38, 6, seed);
  },
  halftone(g, w, h, seed) {
    glow(g, w, h, w * 0.82, h * 0.12, Math.max(w, h) * 0.6, 0.36);
    drawWaves(g, w, h, 0.46, 4, seed);
  },
  ridges(g, w, h, seed) {
    const sx = w * 0.68;
    const sy = h * 0.34;
    glow(g, w, h, sx, sy, Math.max(w, h) * 0.4, 0.24);
    g.fillStyle = white(0.95);
    g.beginPath();
    g.arc(sx, sy, h * 0.085, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const base = h * (0.5 + i * 0.11);
      const amp = h * (0.13 + t * 0.09);
      const curve = (x: number) =>
        base -
        amp *
          ((1 - Math.abs(2 * valueNoise((x / w) * (1.7 + i * 0.7) + i * 5.3, i, seed) - 1)) * 0.85 +
            fbm((x / w) * (6 + i * 2), i * 3.1, seed) * 0.35 -
            0.5);
      band(
        g,
        w,
        h,
        curve,
        base - amp * 0.6,
        base + h * 0.17,
        0.7 - t * 0.25,
        0.95 - t * 0.25,
        0.2 - t * 0.05,
      );
    }
  },
  lotus(g, w, h) {
    const cx = w * 0.66;
    const cy = h * 0.64;
    const L = Math.min(h * 0.44, w * 0.4);
    const lw = Math.max(1, h * 0.005);
    glow(g, w, h, cx, cy - L * 0.4, L * 1.7, 0.3);
    for (let i = 0; i < 6; i++) {
      g.strokeStyle = white(0.55 - i * 0.08);
      g.lineWidth = lw;
      g.beginPath();
      g.ellipse(
        cx,
        cy + L * 0.05 + i * L * 0.1,
        L * (0.5 + i * 0.34),
        L * (0.06 + i * 0.035),
        0,
        0,
        Math.PI * 2,
      );
      g.stroke();
    }
    const outer: ReadonlyArray<readonly [number, number]> = [
      [-1.42, 0.78],
      [1.42, 0.78],
      [-1.08, 0.92],
      [1.08, 0.92],
      [-0.72, 1.02],
      [0.72, 1.02],
      [-0.36, 1.09],
      [0.36, 1.09],
      [0, 1.13],
    ];
    const inner: ReadonlyArray<readonly [number, number]> = [
      [-0.95, 0.6],
      [0.95, 0.6],
      [-0.5, 0.7],
      [0.5, 0.7],
      [0, 0.75],
    ];
    for (const [angle, length] of outer) petal(g, cx, cy, angle, L * length, L * 0.25, 0.72, lw);
    for (const [angle, length] of inner) petal(g, cx, cy, angle, L * length, L * 0.2, 1, lw);
  },
  moonstone(g, w, h) {
    const cx = w * 0.7;
    const cy = h * 1.02;
    const R = Math.min(h * 0.88, w * 0.62);
    const lw = Math.max(1, h * 0.006);
    const P = Math.PI;
    glow(g, w, h, cx, cy, R * 1.3, 0.24);
    const at = (r: number, a: number): [number, number] => [
      cx + r * Math.cos(a),
      cy + r * Math.sin(a),
    ];
    [1, 0.9, 0.74, 0.6, 0.46, 0.3].forEach((f, i) => {
      g.strokeStyle = white(0.85 - i * 0.06);
      g.lineWidth = lw;
      g.beginPath();
      g.arc(cx, cy, R * f, P, 2 * P);
      g.stroke();
    });
    for (let a = P; a <= 2 * P; a += P / 64) {
      const [x0, y0] = at(R * 0.915, a);
      const [x1, y1] = at(R * 0.985, a + 0.025);
      g.strokeStyle = white(0.55);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    for (let i = 0; i < 26; i++) {
      const a = P + ((i + 0.5) * P) / 26;
      const [x, y] = at(R * 0.745, a);
      petal(g, x, y, a + P / 2, R * 0.145, R * 0.034, 0.85, lw);
    }
    g.strokeStyle = white(0.75);
    g.beginPath();
    for (let i = 0; i <= 400; i++) {
      const a = P + (i * P) / 400;
      const [x, y] = at(R * (0.67 + 0.045 * Math.sin(((i * P) / 400) * 44)), a);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
    for (let i = 0; i < 34; i++) {
      const a = P + ((i + 0.5) * P) / 34;
      const [x, y] = at(R * 0.53, a);
      g.fillStyle = white(0.8);
      g.beginPath();
      g.arc(x, y, Math.max(1, R * 0.014), 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 12; i++) {
      const a = P + ((i + 0.5) * P) / 12;
      const [x, y] = at(R * 0.31, a);
      petal(g, x, y, a + P / 2, R * 0.14, R * 0.05, 0.7, lw);
    }
    for (let i = 0; i < 9; i++)
      petal(g, cx, cy, -P / 2 + (i - 4) * 0.36, R * 0.28, R * 0.07, 1, lw);
  },
  palms(g, w, h, seed) {
    const hz = h * 0.66;
    const lw = Math.max(1, h * 0.006);
    glow(g, w, h, w * 0.3, hz, Math.max(w, h) * 0.45, 0.36);
    g.fillStyle = white(0.95);
    g.beginPath();
    g.arc(w * 0.3, hz - h * 0.035, h * 0.075, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#000";
    g.fillRect(0, hz, w, h - hz);
    g.strokeStyle = white(0.8);
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(0, hz);
    g.lineTo(w, hz);
    g.stroke();
    for (let i = 0; i < 16; i++) {
      const y = hz + h * 0.012 + Math.pow(i + 1, 1.5) * h * 0.0052;
      g.strokeStyle = white(0.6 - i * 0.03);
      g.setLineDash([w * (0.03 + 0.09 * hash(i, 1, seed)), w * (0.02 + 0.05 * hash(i, 2, seed))]);
      g.lineDashOffset = hash(i, 3, seed) * w;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    g.setLineDash([]);
    for (let i = 0; i < 10; i++) {
      const y = hz + h * 0.015 + i * h * 0.022;
      const halfWidth = h * (0.07 - i * 0.004);
      g.fillStyle = white(0.8 - i * 0.06);
      g.fillRect(w * 0.3 - halfWidth, y, halfWidth * 2, lw);
    }
    const land = new Path2D();
    land.moveTo(w * 0.44, h);
    land.bezierCurveTo(w * 0.56, hz + h * 0.1, w * 0.7, hz + h * 0.05, w, hz - h * 0.015);
    land.lineTo(w, h);
    land.closePath();
    g.fillStyle = "#000";
    g.fill(land);
    const landShade = g.createLinearGradient(0, hz, 0, h);
    landShade.addColorStop(0, white(0.4));
    landShade.addColorStop(1, white(0.04));
    g.fillStyle = landShade;
    g.fill(land);
    g.strokeStyle = white(0.75);
    g.stroke(land);
    const palm = (bx: number, by: number, height: number, lean: number, n: number) => {
      const tx = bx + lean;
      const ty = by - height;
      g.strokeStyle = white(0.95);
      g.lineWidth = Math.max(1.5, h * 0.013);
      g.beginPath();
      g.moveTo(bx, by);
      g.quadraticCurveTo(bx + lean * 0.2, by - height * 0.55, tx, ty);
      g.stroke();
      for (let k = 0; k < 9; k++) {
        const a = -Math.PI * 1.12 + k * ((Math.PI * 1.24) / 8);
        const len = height * (0.36 + 0.16 * hash(k, n, seed));
        const ex = tx + Math.cos(a) * len;
        const ey = ty + Math.sin(a) * len * 0.7 + len * 0.34;
        const qx = tx + Math.cos(a) * len * 0.55;
        const qy = ty + Math.sin(a) * len * 0.75 - len * 0.12;
        g.lineWidth = lw;
        g.strokeStyle = white(0.95);
        g.beginPath();
        g.moveTo(tx, ty);
        g.quadraticCurveTo(qx, qy, ex, ey);
        g.stroke();
        for (let j = 1; j < 9; j++) {
          const t = j / 9;
          const u = 1 - t;
          const px = u * u * tx + 2 * u * t * qx + t * t * ex;
          const py = u * u * ty + 2 * u * t * qy + t * t * ey;
          g.strokeStyle = white(0.7);
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(a) * len * 0.05, py + len * 0.17 * (1 - t * 0.45));
          g.stroke();
        }
      }
    };
    palm(w * 0.8, hz + h * 0.035, h * 0.5, -w * 0.05, 1);
    palm(w * 0.91, hz + h * 0.01, h * 0.4, w * 0.025, 2);
    palm(w * 0.68, hz + h * 0.06, h * 0.33, -w * 0.03, 3);
  },
  stars(g, w, h, seed) {
    g.save();
    g.translate(w * 0.5, h * 0.45);
    g.rotate(-0.5);
    const milkyWay = g.createLinearGradient(0, -h * 0.28, 0, h * 0.28);
    milkyWay.addColorStop(0, white(0));
    milkyWay.addColorStop(0.5, white(0.2));
    milkyWay.addColorStop(1, white(0));
    g.fillStyle = milkyWay;
    g.fillRect(-w, -h * 0.28, w * 2, h * 0.56);
    g.restore();
    const count = Math.round((w * h) / 55);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(hash(i, 1, seed) * w);
      const y = Math.floor(hash(i, 2, seed) * h);
      const brightness = Math.pow(hash(i, 3, seed), 4);
      const size = brightness > 0.55 ? 2 : 1;
      g.fillStyle = white(0.3 + brightness * 0.7);
      g.fillRect(x, y, size, size);
    }
    const points = Array.from({ length: 8 }, (_, i): [number, number] => [
      w * (0.42 + (0.5 * i) / 7 + (hash(i, 21, seed) - 0.5) * 0.07),
      h * (0.34 + 0.17 * Math.sin(i * 1.35 + seed) + (hash(i, 22, seed) - 0.5) * 0.12),
    ]);
    g.strokeStyle = white(0.5);
    g.lineWidth = 1;
    g.beginPath();
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    const [x2, y2] = points[2]!;
    const [x5, y5] = points[5]!;
    g.moveTo(x2, y2);
    g.lineTo(x2 - w * 0.05, y2 + h * 0.16);
    g.moveTo(x5, y5);
    g.lineTo(x5 + w * 0.03, y5 + h * 0.15);
    g.stroke();
    g.fillStyle = white(1);
    for (const [px, py] of points) {
      const x = Math.floor(px);
      const y = Math.floor(py);
      g.fillRect(x - 1, y - 1, 3, 3);
      g.fillRect(x - 2, y, 5, 1);
      g.fillRect(x, y - 2, 1, 5);
    }
  },
  aurora(g, w, h, seed) {
    g.globalCompositeOperation = "lighter";
    for (let r = 0; r < 3; r++) {
      const base = h * (0.36 + r * 0.2);
      const freq = 0.7 + hash(r, 1, seed) * 1.1;
      const phase = hash(r, 2, seed) * 6.28;
      for (let x = 0; x < w; x++) {
        const u = (x / w) * 6.283;
        const yc =
          base +
          h * 0.09 * Math.sin(u * freq + phase) +
          h * 0.04 * Math.sin(u * freq * 2.7 + phase * 2);
        const len = h * (0.22 + 0.13 * Math.sin(u * (freq + 0.6) + phase * 0.7));
        const alpha =
          (0.7 - r * 0.1) *
          (0.12 + 0.88 * valueNoise(x * 0.22, r * 9, seed)) *
          (0.5 + 0.5 * valueNoise(x * 0.9, r * 5 + 3, seed));
        const curtain = g.createLinearGradient(0, yc - len, 0, yc + len * 0.12);
        curtain.addColorStop(0, white(0));
        curtain.addColorStop(0.86, white(alpha));
        curtain.addColorStop(1, white(0));
        g.fillStyle = curtain;
        g.fillRect(x, yc - len, 1, len * 1.12);
      }
    }
    g.globalCompositeOperation = "source-over";
  },
  grain(g, w, h) {
    const ramp = g.createLinearGradient(0, 0, 0, h);
    ramp.addColorStop(0, "#1c1c1c");
    ramp.addColorStop(1, "#8a8a8a");
    g.fillStyle = ramp;
    g.fillRect(0, 0, w, h);
    glow(g, w, h, w * 0.7, h * 0.25, Math.max(w, h) * 0.45, 0.3);
  },
};

/** Brightness field (0..1 per cell) for a generated artwork. */
export function buildSceneField(
  art: GeneratedArt,
  cols: number,
  rows: number,
  seed: number,
  assets: SceneAssets,
): Float32Array {
  const field = new Float32Array(cols * rows);
  if (art === "contours") {
    const k = 3.2 / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const n = fbm(x * k, y * k, seed);
        const fraction = (n * 12) % 1;
        const distance = Math.min(fraction, 1 - fraction);
        field[y * cols + x] = (1 - smoothstep(0.02, 0.11, distance)) * (0.35 + 0.9 * n) + 0.05 * n;
      }
    }
    return field;
  }
  const canvas = new OffscreenCanvas(cols, rows);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, cols, rows);
  SCENES[art](g, cols, rows, seed, assets);
  const pixels = g.getImageData(0, 0, cols, rows).data;
  for (let i = 0; i < field.length; i++) field[i] = pixels[i * 4]! / 255;
  return field;
}

/** Arts whose flat areas get a soft noise texture so the dither reads as hand-made. */
export const TEXTURED_ARTS: Partial<Record<GeneratedArt, readonly [number, number, number]>> = {
  horse: [0.68, 0.62, 0.05],
  herd: [0.7, 0.6, 0.05],
  waves: [0.5, 0.95, 0.06],
  ridges: [0.62, 0.7, 0.06],
};

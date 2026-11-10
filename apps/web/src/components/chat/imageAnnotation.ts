export type AnnotationTool = "pen" | "arrow" | "rect" | "text" | "crop";

export interface AnnotationPoint {
  readonly x: number;
  readonly y: number;
}

export interface AnnotationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type AnnotationOp =
  | {
      readonly kind: "pen";
      readonly color: string;
      readonly width: number;
      readonly points: ReadonlyArray<AnnotationPoint>;
    }
  | {
      readonly kind: "arrow" | "rect";
      readonly color: string;
      readonly width: number;
      readonly from: AnnotationPoint;
      readonly to: AnnotationPoint;
    }
  | {
      readonly kind: "text";
      readonly color: string;
      readonly size: number;
      readonly at: AnnotationPoint;
      readonly text: string;
    }
  | { readonly kind: "crop"; readonly rect: AnnotationRect };

export const ANNOTATION_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#ffffff",
  "#111111",
] as const;

/** Stroke and text sizes follow the image so marks read the same on small and 5K captures. */
export function annotationScale(width: number, height: number) {
  const unit = Math.max(width, height) / 1000;
  return {
    stroke: Math.max(2, Math.round(unit * 4)),
    text: Math.max(14, Math.round(unit * 28)),
  };
}

export function rectFromPoints(
  a: AnnotationPoint,
  b: AnnotationPoint,
  bounds: { readonly width: number; readonly height: number },
): AnnotationRect {
  const clampX = (value: number) => Math.min(bounds.width, Math.max(0, value));
  const clampY = (value: number) => Math.min(bounds.height, Math.max(0, value));
  const left = Math.round(clampX(Math.min(a.x, b.x)));
  const top = Math.round(clampY(Math.min(a.y, b.y)));
  const right = Math.round(clampX(Math.max(a.x, b.x)));
  const bottom = Math.round(clampY(Math.max(a.y, b.y)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function activeCrop(ops: ReadonlyArray<AnnotationOp>): AnnotationRect | null {
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index];
    if (op?.kind === "crop") return op.rect;
  }
  return null;
}

/** Drops strokes too small to be intentional, such as a click with the arrow tool. */
export function isMeaningfulOp(op: AnnotationOp): boolean {
  switch (op.kind) {
    case "pen":
      return op.points.length > 1;
    case "arrow":
      return Math.hypot(op.to.x - op.from.x, op.to.y - op.from.y) > op.width * 2;
    case "rect":
      return Math.abs(op.to.x - op.from.x) > 2 && Math.abs(op.to.y - op.from.y) > 2;
    case "text":
      return op.text.trim().length > 0;
    case "crop":
      return op.rect.width > 4 && op.rect.height > 4;
  }
}

function textOutline(color: string): string {
  return color === "#111111" ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.6)";
}

export function drawAnnotationOp(ctx: CanvasRenderingContext2D, op: AnnotationOp): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (op.kind) {
    case "pen": {
      const [first, ...rest] = op.points;
      if (!first) break;
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const point of rest) ctx.lineTo(point.x, point.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const angle = Math.atan2(op.to.y - op.from.y, op.to.x - op.from.x);
      const head = op.width * 4.5;
      const shaftEnd = {
        x: op.to.x - Math.cos(angle) * head * 0.8,
        y: op.to.y - Math.sin(angle) * head * 0.8,
      };
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.beginPath();
      ctx.moveTo(op.from.x, op.from.y);
      ctx.lineTo(shaftEnd.x, shaftEnd.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(op.to.x, op.to.y);
      ctx.lineTo(
        op.to.x - head * Math.cos(angle - Math.PI / 7),
        op.to.y - head * Math.sin(angle - Math.PI / 7),
      );
      ctx.lineTo(
        op.to.x - head * Math.cos(angle + Math.PI / 7),
        op.to.y - head * Math.sin(angle + Math.PI / 7),
      );
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "rect": {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.strokeRect(
        Math.min(op.from.x, op.to.x),
        Math.min(op.from.y, op.to.y),
        Math.abs(op.to.x - op.from.x),
        Math.abs(op.to.y - op.from.y),
      );
      break;
    }
    case "text": {
      ctx.font = `600 ${op.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = "top";
      ctx.lineWidth = Math.max(2, op.size / 7);
      ctx.strokeStyle = textOutline(op.color);
      ctx.fillStyle = op.color;
      op.text.split("\n").forEach((line, index) => {
        const y = op.at.y + index * op.size * 1.25;
        ctx.strokeText(line, op.at.x, y);
        ctx.fillText(line, op.at.x, y);
      });
      break;
    }
    case "crop":
      break;
  }
  ctx.restore();
}

export function drawCropShade(
  ctx: CanvasRenderingContext2D,
  crop: AnnotationRect,
  bounds: { readonly width: number; readonly height: number },
  stroke: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, bounds.width, bounds.height);
  ctx.clearRect(crop.x, crop.y, crop.width, crop.height);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1, stroke / 2);
  ctx.setLineDash([stroke * 2, stroke * 2]);
  ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
  ctx.restore();
}

/** Flattens the image and marks, then applies the latest crop. */
export async function exportAnnotatedImage(
  image: CanvasImageSource,
  size: { readonly width: number; readonly height: number },
  ops: ReadonlyArray<AnnotationOp>,
): Promise<Blob> {
  const crop = activeCrop(ops) ?? { x: 0, y: 0, ...size };
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.translate(-crop.x, -crop.y);
  ctx.drawImage(image, 0, 0, size.width, size.height);
  for (const op of ops) drawAnnotationOp(ctx, op);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))),
      "image/png",
    );
  });
}

export function annotatedFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.png`;
}

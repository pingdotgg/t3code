import { m } from "~/i18n/messages";
import { msg } from "gt-react";
export interface ImageEditorPoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageEditorCrop extends ImageEditorPoint {
  readonly width: number;
  readonly height: number;
}

interface ImageEditorObjectBase extends ImageEditorCrop {
  readonly id: string;
  readonly rotation: number;
  readonly color: string;
  readonly strokeWidth: number;
}

export type ImageEditorObject = ImageEditorObjectBase &
  (
    | {
        readonly kind: "freehand" | "remove" | "arrow";
        readonly points: readonly ImageEditorPoint[];
      }
    | { readonly kind: "rectangle" | "ellipse" }
    | {
        readonly kind: "text";
        readonly text: string;
        readonly fontFamily: string;
        readonly fontSize: number;
        readonly align: "left" | "center" | "right";
        readonly letterSpacing: number;
        readonly wordSpacing?: number;
        readonly lineHeight: number;
        readonly stretch: number;
        readonly curve: number;
      }
    | { readonly kind: "pin"; readonly comment: string }
  );

export interface ImageEditorDocument {
  readonly width: number;
  readonly height: number;
  readonly objects: readonly ImageEditorObject[];
  readonly crop: ImageEditorCrop | null;
}

export interface ImageEditorHistory {
  readonly past: readonly ImageEditorDocument[];
  readonly present: ImageEditorDocument;
  readonly future: readonly ImageEditorDocument[];
}

const HISTORY_LIMIT = 80;

export function createImageEditorDocument(width: number, height: number): ImageEditorDocument {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(m(msg("The image must have positive, finite dimensions.")));
  }
  return { width, height, objects: [], crop: null };
}

export function createImageEditorHistory(present: ImageEditorDocument): ImageEditorHistory {
  return { past: [], present, future: [] };
}

export function commitImageEditorDocument(
  history: ImageEditorHistory,
  present: ImageEditorDocument,
): ImageEditorHistory {
  if (present === history.present) return history;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present, future: [] };
}

export function undoImageEditor(history: ImageEditorHistory): ImageEditorHistory {
  const present = history.past.at(-1);
  if (!present) return history;
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  };
}

export function redoImageEditor(history: ImageEditorHistory): ImageEditorHistory {
  const present = history.future[0];
  if (!present) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present,
    future: history.future.slice(1),
  };
}

export function addImageEditorObject(
  document: ImageEditorDocument,
  object: ImageEditorObject,
): ImageEditorDocument {
  if (document.objects.some((entry) => entry.id === object.id)) return document;
  return { ...document, objects: [...document.objects, object] };
}

export function updateImageEditorObject(
  document: ImageEditorDocument,
  id: string,
  patch: Partial<ImageEditorObject>,
): ImageEditorDocument {
  const previous = document.objects.find((object) => object.id === id);
  if (!previous) return document;
  let next = { ...previous, ...patch, id: previous.id, kind: previous.kind } as ImageEditorObject;
  if (
    (previous.kind === "freehand" || previous.kind === "remove" || previous.kind === "arrow") &&
    (next.kind === "freehand" || next.kind === "remove" || next.kind === "arrow") &&
    !("points" in patch) &&
    (previous.width !== next.width || previous.height !== next.height)
  ) {
    const scaleX = previous.width > 0 ? next.width / previous.width : 1;
    const scaleY = previous.height > 0 ? next.height / previous.height : 1;
    next = {
      ...next,
      points: previous.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })),
    };
  }
  if (previous.kind === "text" && next.kind === "text") {
    const scaleX = previous.width > 0 ? next.width / previous.width : 1;
    const scaleY = previous.height > 0 ? next.height / previous.height : 1;
    next = {
      ...next,
      fontSize: "fontSize" in patch ? next.fontSize : previous.fontSize * scaleY,
      letterSpacing:
        "letterSpacing" in patch ? next.letterSpacing : previous.letterSpacing * scaleY,
      wordSpacing:
        "wordSpacing" in patch ? (next.wordSpacing ?? 0) : (previous.wordSpacing ?? 0) * scaleY,
      stretch:
        "stretch" in patch ? next.stretch : (previous.stretch * scaleX) / Math.max(0.01, scaleY),
      curve: "curve" in patch ? next.curve : previous.curve * scaleY,
    };
  }
  return {
    ...document,
    objects: document.objects.map((object) => (object.id === id ? next : object)),
  };
}

export function anchoredImageEditorResize(
  object: Pick<ImageEditorObject, "x" | "y" | "width" | "height" | "rotation">,
  width: number,
  height: number,
): ImageEditorCrop {
  const radians = (object.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const widthChange = width - object.width;
  const heightChange = height - object.height;
  return {
    x: object.x + (widthChange * (cosine - 1) - heightChange * sine) / 2,
    y: object.y + (widthChange * sine + heightChange * (cosine - 1)) / 2,
    width,
    height,
  };
}

export function removeImageEditorObject(
  document: ImageEditorDocument,
  id: string,
): ImageEditorDocument {
  const objects = document.objects.filter((object) => object.id !== id);
  return objects.length === document.objects.length ? document : { ...document, objects };
}

export function reorderImageEditorObject(
  document: ImageEditorDocument,
  id: string,
  direction: "forward" | "backward",
): ImageEditorDocument {
  const index = document.objects.findIndex((object) => object.id === id);
  const nextIndex = index + (direction === "forward" ? 1 : -1);
  if (index < 0 || nextIndex < 0 || nextIndex >= document.objects.length) return document;
  const objects = [...document.objects];
  const object = objects[index];
  const neighbor = objects[nextIndex];
  if (!object || !neighbor) return document;
  objects[index] = neighbor;
  objects[nextIndex] = object;
  return { ...document, objects };
}

export function setImageEditorCrop(
  document: ImageEditorDocument,
  crop: ImageEditorCrop | null,
): ImageEditorDocument {
  if (crop === null) return document.crop === null ? document : { ...document, crop: null };
  const x = Math.max(0, Math.min(document.width - 1, crop.x));
  const y = Math.max(0, Math.min(document.height - 1, crop.y));
  const width = Math.max(1, Math.min(document.width - x, crop.width));
  const height = Math.max(1, Math.min(document.height - y, crop.height));
  if (![x, y, width, height].every(Number.isFinite)) return document;
  return { ...document, crop: { x, y, width, height } };
}

export function imageEditorObjectBounds(object: ImageEditorObject): ImageEditorCrop {
  const radians = (object.rotation * Math.PI) / 180;
  const width =
    Math.abs(object.width * Math.cos(radians)) + Math.abs(object.height * Math.sin(radians));
  const height =
    Math.abs(object.width * Math.sin(radians)) + Math.abs(object.height * Math.cos(radians));
  return {
    x: object.x + (object.width - width) / 2,
    y: object.y + (object.height - height) / 2,
    width,
    height,
  };
}

function localPoint(object: ImageEditorObject, point: ImageEditorPoint): ImageEditorPoint {
  const radians = (-object.rotation * Math.PI) / 180;
  const x = point.x - object.x - object.width / 2;
  const y = point.y - object.y - object.height / 2;
  return {
    x: x * Math.cos(radians) - y * Math.sin(radians) + object.width / 2,
    y: x * Math.sin(radians) + y * Math.cos(radians) + object.height / 2,
  };
}

function segmentDistance(point: ImageEditorPoint, a: ImageEditorPoint, b: ImageEditorPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
}

export function hitTestImageEditorObject(
  document: ImageEditorDocument,
  point: ImageEditorPoint,
  displayScale = 1,
): ImageEditorObject | null {
  for (const object of document.objects.toReversed()) {
    const local = localPoint(object, point);
    const tolerance = Math.max(6 / Math.max(0.001, displayScale), object.strokeWidth / 2);
    if (object.kind === "freehand" || object.kind === "remove") {
      if (
        object.points.some(
          (entry, index) =>
            segmentDistance(local, entry, object.points[index + 1] ?? entry) <= tolerance,
        )
      )
        return object;
      continue;
    }
    if (object.kind === "arrow") {
      const start = object.points[0] ?? { x: 0, y: 0 };
      const end = object.points.at(-1) ?? { x: object.width, y: object.height };
      if (segmentDistance(local, start, end) <= tolerance) return object;
      continue;
    }
    if (object.kind === "ellipse") {
      const rx = Math.max(1, object.width / 2);
      const ry = Math.max(1, object.height / 2);
      const distance = Math.hypot((local.x - rx) / rx, (local.y - ry) / ry);
      if (Math.abs(distance - 1) <= tolerance / Math.min(rx, ry)) return object;
      continue;
    }
    if (
      local.x < -tolerance ||
      local.y < -tolerance ||
      local.x > object.width + tolerance ||
      local.y > object.height + tolerance
    )
      continue;
    if (
      object.kind === "rectangle" &&
      local.x > tolerance &&
      local.y > tolerance &&
      local.x < object.width - tolerance &&
      local.y < object.height - tolerance
    )
      continue;
    return object;
  }
  return null;
}

function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ??
      character,
  );
}

function number(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
}

export function imageEditorSvgMarkup(
  document: ImageEditorDocument,
  options: { mode?: "annotated" | "mask" } = {},
): string {
  const mask = options.mode === "mask";
  let pin = 0;
  return document.objects
    .map((object) => {
      if (object.kind === "pin") pin += 1;
      if (mask && object.kind !== "remove") return "";
      const color = mask ? "#ffffff" : object.kind === "remove" ? "#ef4444" : xml(object.color);
      const width = number(object.width);
      const height = number(object.height);
      const stroke = `stroke="${color}" stroke-width="${number(object.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
      let content: string;
      switch (object.kind) {
        case "freehand":
        case "remove": {
          const path = object.points
            .map(
              (point, index) => `${index === 0 ? "M" : "L"}${number(point.x)} ${number(point.y)}`,
            )
            .join(" ");
          const dot = object.points[0];
          content =
            object.points.length === 1 && dot
              ? `<circle cx="${number(dot.x)}" cy="${number(dot.y)}" r="${number(object.strokeWidth / 2)}" fill="${color}"/>`
              : `<path d="${path}" ${stroke}/>`;
          break;
        }
        case "rectangle":
          content = `<rect width="${width}" height="${height}" ${stroke}/>`;
          break;
        case "ellipse":
          content = `<ellipse cx="${number(object.width / 2)}" cy="${number(object.height / 2)}" rx="${number(object.width / 2)}" ry="${number(object.height / 2)}" ${stroke}/>`;
          break;
        case "arrow": {
          const start = object.points[0] ?? { x: 0, y: 0 };
          const target = object.points.at(-1) ?? { x: object.width, y: object.height };
          const angle = Math.atan2(target.y - start.y, target.x - start.x);
          const length = Math.max(12, object.strokeWidth * 4);
          const end = (delta: number) =>
            `${number(target.x - length * Math.cos(angle + delta))} ${number(target.y - length * Math.sin(angle + delta))}`;
          content = `<path d="M${number(start.x)} ${number(start.y)} L${number(target.x)} ${number(target.y)} M${end(-0.45)} L${number(target.x)} ${number(target.y)} L${end(0.45)}" ${stroke}/>`;
          break;
        }
        case "text": {
          const anchor =
            object.align === "center" ? "middle" : object.align === "right" ? "end" : "start";
          const x =
            object.align === "center"
              ? object.width / 2
              : object.align === "right"
                ? object.width - object.fontSize * object.stretch
                : object.fontSize * object.stretch;
          const textAttrs = `fill="${color}" font-family="${xml(object.fontFamily)}" font-size="${number(object.fontSize)}" letter-spacing="${number(object.letterSpacing)}" word-spacing="${number(object.wordSpacing ?? 0)}" text-anchor="${anchor}"`;
          const lines = object.text.split("\n");
          if (object.curve !== 0) {
            const pathId = `curve-${xml(object.id)}`;
            const startOffset =
              object.align === "center" ? "50%" : object.align === "right" ? "100%" : "0%";
            const stretch = Math.max(0.01, object.stretch);
            content = `<g transform="scale(${number(stretch)} 1)"><defs><path id="${pathId}" d="M${number(object.fontSize)} ${number(object.fontSize * 1.2 + Math.max(0, object.curve))} Q${number(object.width / 2 / stretch)} ${number(object.fontSize * 1.2 + Math.max(0, object.curve) - 2 * object.curve)} ${number(Math.max(object.fontSize, object.width / stretch - object.fontSize))} ${number(object.fontSize * 1.2 + Math.max(0, object.curve))}"/></defs><text ${textAttrs}><textPath href="#${pathId}" startOffset="${startOffset}">${xml(lines.join(" "))}</textPath></text></g>`;
          } else {
            const spans = lines
              .map(
                (line, index) =>
                  `<tspan x="${number(x / Math.max(0.01, object.stretch))}" y="${number(object.fontSize * 1.2 + index * object.fontSize * object.lineHeight)}">${xml(line)}</tspan>`,
              )
              .join("");
            content = `<text ${textAttrs} transform="scale(${number(object.stretch)} 1)">${spans}</text>`;
          }
          break;
        }
        case "pin":
          content = `<circle cx="${number(object.width / 2)}" cy="${number(object.height / 2)}" r="${number(Math.min(object.width, object.height) / 2)}" fill="${color}" stroke="white" stroke-width="2"/><text x="${number(object.width / 2)}" y="${number(object.height / 2)}" dominant-baseline="central" text-anchor="middle" fill="white" font-family="sans-serif" font-size="${number(Math.min(object.width, object.height) * 0.55)}">${pin}</text>`;
          break;
      }
      return `<g transform="translate(${number(object.x)} ${number(object.y)}) rotate(${number(object.rotation)} ${number(object.width / 2)} ${number(object.height / 2)})"${object.kind === "remove" && !mask ? ' opacity="0.55"' : ""}>${content}</g>`;
    })
    .join("");
}

export function buildImageEditorPrompt(
  document: ImageEditorDocument,
  options: { instructions: string; removeBackground: boolean; aspectRatio: string },
): string {
  const frame = document.crop ?? { x: 0, y: 0, width: document.width, height: document.height };
  const lines = [
    "Edit the attached original image using the attached guidance image. The annotations are editing instructions; do not reproduce them in the result.",
  ];
  if (options.instructions.trim()) lines.push(options.instructions.trim());
  const pins = document.objects.filter((object) => object.kind === "pin");
  const comments = pins.flatMap((object, index) => {
    const centerX = object.x + object.width / 2;
    const centerY = object.y + object.height / 2;
    if (
      centerX < frame.x ||
      centerY < frame.y ||
      centerX > frame.x + frame.width ||
      centerY > frame.y + frame.height
    )
      return [];
    const x = Math.round(((centerX - frame.x) / frame.width) * 100);
    const y = Math.round(((centerY - frame.y) / frame.height) * 100);
    return [`${index + 1}. At ${x}% from the left, ${y}% from the top: ${object.comment}`];
  });
  if (comments.length > 0) {
    lines.push("Location comments (coordinates relative to the original attachment):", ...comments);
  }
  if (document.objects.some((object) => object.kind === "remove")) {
    lines.push(
      "Remove the areas painted red in the guidance image and repair them to match their surroundings. The attached mask uses white for the selected areas and black for areas to preserve. Treat it as visual guidance if the image tool does not accept a mask input.",
    );
  }
  if (options.removeBackground)
    lines.push(
      "Remove the image background and return a PNG with a transparent background. Preserve the foreground subject and its detail.",
    );
  if (options.aspectRatio && options.aspectRatio !== "original")
    lines.push(
      `Regenerate the image at ${options.aspectRatio} aspect ratio. Extend or recompose the scene to fit; preserve the subject.`,
    );
  lines.push("Use the available image generation/editing tool and return the edited image.");
  return lines.join("\n\n");
}

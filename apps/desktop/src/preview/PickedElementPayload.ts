/**
 * Strict structural validator for `PickedElementPayload` messages received
 * from the in-page picker preload (`apps/desktop/src/preview/PickPreload.ts`)
 * via `wc.ipc`. Lives in its own electron-free module so the validator is
 * trivially unit-testable.
 *
 * Validation must be tight: downstream `normalizeElementContextSelection`
 * calls `.trim()` on incoming strings, so a malformed payload (preload bug,
 * future schema mismatch, malicious page that intercepts the preload's IPC
 * channel via prototype pollution) would otherwise throw deep in the
 * renderer and the chip silently never appears.
 */
import type { PickedElementPayload, PreviewAnnotationPayload } from "@t3tools/contracts";

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isPickedStackFrame(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    isStringOrNull(frame["functionName"]) &&
    isStringOrNull(frame["fileName"]) &&
    isFiniteNumberOrNull(frame["lineNumber"]) &&
    isFiniteNumberOrNull(frame["columnNumber"])
  );
}

export function isPickedElementPayload(value: unknown): value is PickedElementPayload {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c["pageUrl"] !== "string") return false;
  if (typeof c["tagName"] !== "string") return false;
  if (typeof c["htmlPreview"] !== "string") return false;
  if (typeof c["styles"] !== "string") return false;
  if (typeof c["pickedAt"] !== "string") return false;
  if (!isStringOrNull(c["pageTitle"])) return false;
  if (!isStringOrNull(c["selector"])) return false;
  if (!isStringOrNull(c["componentName"])) return false;
  if (c["source"] !== null && !isPickedStackFrame(c["source"])) return false;
  if (!Array.isArray(c["stack"])) return false;
  if (!c["stack"].every(isPickedStackFrame)) return false;
  return true;
}

function isRect(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof rect[key] === "number" && Number.isFinite(rect[key]),
  );
}

function isPoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point["x"] === "number" &&
    Number.isFinite(point["x"]) &&
    typeof point["y"] === "number" &&
    Number.isFinite(point["y"])
  );
}

export function isPreviewAnnotationPayload(value: unknown): value is PreviewAnnotationPayload {
  if (typeof value !== "object" || value === null) return false;
  const annotation = value as Record<string, unknown>;
  if (typeof annotation["id"] !== "string") return false;
  if (typeof annotation["pageUrl"] !== "string") return false;
  if (!isStringOrNull(annotation["pageTitle"])) return false;
  if (typeof annotation["comment"] !== "string") return false;
  if (typeof annotation["createdAt"] !== "string") return false;
  if (annotation["screenshot"] !== null) return false;

  const elements = annotation["elements"];
  if (!Array.isArray(elements)) return false;
  if (
    !elements.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const target = entry as Record<string, unknown>;
      return (
        typeof target["id"] === "string" &&
        isPickedElementPayload(target["element"]) &&
        isRect(target["rect"])
      );
    })
  ) {
    return false;
  }

  const regions = annotation["regions"];
  if (!Array.isArray(regions)) return false;
  if (
    !regions.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const target = entry as Record<string, unknown>;
      return typeof target["id"] === "string" && isRect(target["rect"]);
    })
  ) {
    return false;
  }

  const strokes = annotation["strokes"];
  if (!Array.isArray(strokes)) return false;
  if (
    !strokes.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const target = entry as Record<string, unknown>;
      return (
        typeof target["id"] === "string" &&
        typeof target["color"] === "string" &&
        typeof target["width"] === "number" &&
        Number.isFinite(target["width"]) &&
        Array.isArray(target["points"]) &&
        target["points"].every(isPoint) &&
        isRect(target["bounds"])
      );
    })
  ) {
    return false;
  }

  const styleChanges = annotation["styleChanges"];
  if (!Array.isArray(styleChanges)) return false;
  if (
    !styleChanges.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const change = entry as Record<string, unknown>;
      return (
        typeof change["targetId"] === "string" &&
        isStringOrNull(change["selector"]) &&
        typeof change["property"] === "string" &&
        typeof change["previousValue"] === "string" &&
        typeof change["value"] === "string"
      );
    })
  ) {
    return false;
  }
  return true;
}

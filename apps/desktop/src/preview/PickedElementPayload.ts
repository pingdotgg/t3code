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

function isNormalizedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNormalizedPoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return isNormalizedNumber(point["x"]) && isNormalizedNumber(point["y"]);
}

function isNormalizedRect(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  if (
    !isNormalizedNumber(rect["x"]) ||
    !isNormalizedNumber(rect["y"]) ||
    !isNormalizedNumber(rect["width"]) ||
    !isNormalizedNumber(rect["height"]) ||
    rect["width"] <= 0 ||
    rect["height"] <= 0
  ) {
    return false;
  }
  return rect["x"] + rect["width"] <= 1 && rect["y"] + rect["height"] <= 1;
}

function isPreviewAnnotationSource(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Record<string, unknown>;
  if (source["kind"] === "image") {
    return isStringOrNull(source["name"]);
  }
  if (source["kind"] === "preview") {
    return typeof source["url"] === "string" && isStringOrNull(source["title"]);
  }
  return false;
}

function isPreviewAnnotationCallout(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const callout = value as Record<string, unknown>;
  if (
    typeof callout["id"] !== "string" ||
    typeof callout["number"] !== "number" ||
    !Number.isInteger(callout["number"]) ||
    callout["number"] < 1 ||
    typeof callout["comment"] !== "string"
  ) {
    return false;
  }

  const anchorValue = callout["anchor"];
  if (typeof anchorValue !== "object" || anchorValue === null) return false;
  const anchor = anchorValue as Record<string, unknown>;
  if (anchor["kind"] === "point") {
    return isNormalizedPoint(anchor["point"]);
  }
  if (anchor["kind"] === "region") {
    return isNormalizedRect(anchor["rect"]);
  }
  if (anchor["kind"] === "element") {
    return typeof anchor["targetId"] === "string" && isNormalizedRect(anchor["rect"]);
  }
  return false;
}

function isPreviewAnnotationEditableStroke(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const stroke = value as Record<string, unknown>;
  return (
    typeof stroke["id"] === "string" &&
    typeof stroke["color"] === "string" &&
    isNormalizedNumber(stroke["width"]) &&
    stroke["width"] > 0 &&
    Array.isArray(stroke["points"]) &&
    stroke["points"].every(isNormalizedPoint) &&
    isNormalizedRect(stroke["bounds"])
  );
}

function isPreviewAnnotationEditable(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const editable = value as Record<string, unknown>;
  return (
    editable["version"] === 1 &&
    editable["coordinateSpace"] === "normalized" &&
    Array.isArray(editable["strokes"]) &&
    editable["strokes"].every(isPreviewAnnotationEditableStroke)
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
  // The guest submits structure only. The trusted main process captures and
  // attaches the screenshot after this boundary.
  if (annotation["screenshot"] !== null) return false;
  if (annotation["schemaVersion"] !== undefined && annotation["schemaVersion"] !== 1) return false;
  if (annotation["source"] !== undefined && !isPreviewAnnotationSource(annotation["source"])) {
    return false;
  }
  if (
    annotation["callouts"] !== undefined &&
    (!Array.isArray(annotation["callouts"]) ||
      !annotation["callouts"].every(isPreviewAnnotationCallout))
  ) {
    return false;
  }
  if (
    annotation["editable"] !== undefined &&
    annotation["editable"] !== null &&
    !isPreviewAnnotationEditable(annotation["editable"])
  ) {
    return false;
  }

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

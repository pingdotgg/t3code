import type {
  PickedElementPayload,
  PickedElementStackFrame,
  PreviewAnnotationPayload,
} from "@t3tools/contracts";

const ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT = 4000;
const ELEMENT_CONTEXT_STYLES_LIMIT = 4000;

/**
 * Stable, persistable element selection captured from the in-app preview
 * browser. We deliberately keep the shape JSON-serializable so it can ride
 * through `localStorage` persistence, draft restoration, and transcript
 * snapshots without bespoke marshalling.
 */
export interface ElementContextSelection {
  /** Page URL where the element was picked. */
  pageUrl: string;
  /** Best-effort `<title>`. */
  pageTitle: string | null;
  /** Lowercase tag, e.g. `"button"`. */
  tagName: string;
  /** CSS selector — may be null when react-grab can't compute one. */
  selector: string | null;
  /** Truncated outer-HTML preview. */
  htmlPreview: string;
  /** Nearest React component display name, or null. */
  componentName: string | null;
  /** Source frame (file + line) — null when unavailable. */
  source: PickedElementStackFrame | null;
  /** Author CSS (no UA defaults). May be empty. */
  styles: string;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Sanitize a payload coming back from the desktop bridge before it lands in
 * the composer draft. Trims/clamps every string field so we never persist a
 * 5MB outerHTML blob and silently break `localStorage`.
 */
export function normalizeElementContextSelection(
  raw: PickedElementPayload,
): ElementContextSelection | null {
  const pageUrl = raw.pageUrl.trim();
  const tagName = raw.tagName.trim().toLowerCase();
  if (pageUrl.length === 0 || tagName.length === 0) {
    return null;
  }
  const stackFrame = raw.source ?? raw.stack[0] ?? null;
  return {
    pageUrl,
    pageTitle: raw.pageTitle?.trim() ?? null,
    tagName,
    selector: raw.selector?.trim() || null,
    htmlPreview: truncateString(normalizeText(raw.htmlPreview), ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT),
    componentName: raw.componentName?.trim() || null,
    source: stackFrame
      ? {
          functionName: stackFrame.functionName?.trim() || null,
          fileName: stackFrame.fileName?.trim() || null,
          lineNumber: stackFrame.lineNumber ?? null,
          columnNumber: stackFrame.columnNumber ?? null,
        }
      : null,
    styles: truncateString(normalizeText(raw.styles), ELEMENT_CONTEXT_STYLES_LIMIT),
  };
}

/** Converts a saved element pick into the annotation shape used by current drafts. */
export function elementContextToPreviewAnnotation(
  element: ElementContextSelection,
  id: string,
  pickedAt: string,
): PreviewAnnotationPayload {
  return {
    id,
    pageUrl: element.pageUrl,
    pageTitle: element.pageTitle,
    comment: "",
    elements: [
      {
        id,
        element: { ...element, stack: [], pickedAt },
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    ],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: pickedAt,
  };
}

import type { AssistantTextSelector } from "./assistantTextSelection";
import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
} from "@t3tools/contracts";

export type HtmlSelectionRect = { left: number; top: number; width: number; height: number };
export type HtmlSelection = {
  selector: AssistantTextSelector;
  rect: HtmlSelectionRect;
  pointer: { x: number; y: number } | null;
};

export function readHtmlSelectionRect(data: unknown): HtmlSelectionRect | null {
  if (typeof data !== "object" || data === null) return null;
  const r = data as Record<string, unknown>;
  if (
    ![r.left, r.top, r.width, r.height].every(
      (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 100_000,
    )
  )
    return null;
  if ((r.width as number) <= 0 || (r.height as number) <= 0) return null;
  return {
    left: r.left as number,
    top: r.top as number,
    width: r.width as number,
    height: r.height as number,
  };
}

export function htmlSelectionParams(data: unknown): Record<string, unknown> | null | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d.jsonrpc !== "2.0" || d.method !== "t3/selection") return undefined;
  if (d.params === null) return null;
  return typeof d.params === "object" && d.params !== null
    ? (d.params as Record<string, unknown>)
    : undefined;
}

export function readHtmlSelection(data: unknown): HtmlSelection | null {
  const p = htmlSelectionParams(data);
  if (!p || typeof p.selector !== "object" || p.selector === null) return null;
  const s = p.selector as Record<string, unknown>;
  const rect = readHtmlSelectionRect(p.rect);
  if (
    !rect ||
    typeof s.text !== "string" ||
    !s.text.trim() ||
    s.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH ||
    typeof s.prefix !== "string" ||
    s.prefix.length > ASSISTANT_CITATION_CONTEXT_LENGTH ||
    typeof s.suffix !== "string" ||
    s.suffix.length > ASSISTANT_CITATION_CONTEXT_LENGTH ||
    !Number.isSafeInteger(s.start) ||
    !Number.isSafeInteger(s.end) ||
    (s.start as number) < 0 ||
    (s.end as number) <= (s.start as number)
  )
    return null;
  const pointer = p.pointer as Record<string, unknown> | null;
  if (
    pointer !== null &&
    (typeof pointer !== "object" || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y))
  )
    return null;
  return {
    selector: {
      text: s.text,
      start: s.start as number,
      end: s.end as number,
      prefix: s.prefix,
      suffix: s.suffix,
    },
    rect,
    pointer: pointer as HtmlSelection["pointer"],
  };
}

export function htmlSelectionCommand(
  frame: HTMLIFrameElement,
  action: "clear" | "dismiss" | "mark" | "unmark" | "target",
  selector?: AssistantTextSelector,
) {
  frame.contentWindow?.postMessage(
    {
      method: "t3/selection-command",
      params: {
        action,
        selector: selector && {
          text: selector.text,
          start: selector.start,
          end: selector.end,
          prefix: selector.prefix,
          suffix: selector.suffix,
        },
      },
    },
    "*",
  );
}

export function htmlSelectionClientRect(
  frame: HTMLIFrameElement,
  rect: HtmlSelectionRect,
): DOMRect {
  const bounds = frame.getBoundingClientRect();
  const scaleX = frame.clientWidth ? bounds.width / frame.clientWidth : 1;
  const scaleY = frame.clientHeight ? bounds.height / frame.clientHeight : 1;
  return new DOMRect(
    bounds.left + rect.left * scaleX,
    bounds.top + rect.top * scaleY,
    rect.width * scaleX,
    rect.height * scaleY,
  );
}

// @effect-diagnostics globalDate:off globalTimers:off - Shared DOM helpers for the isolated pick preload.
import { getElementContext } from "react-grab/primitives";
import type {
  PickedElementPayload,
  PickedElementStackFrame,
} from "@t3tools/contracts";

import type {
  DesktopPreviewAnnotationTheme,
  PreviewAnnotationPoint,
  PreviewAnnotationRect,
} from "@t3tools/contracts";

import { createAnnotationIdSource } from "./AnnotationIds.ts";
import { HUMAN_INPUT_CHANNEL, MOUSE_NAVIGATE_CHANNEL } from "./GuestProtocol.ts";

/** The isolated preload owns the Electron IPC handle; the UI helpers call through it. */
export interface PickUiBridge {
  readonly send: (channel: string, payload: unknown) => void;
}

let pickUiBridge: PickUiBridge = { send: () => {} };

export const installPickUiBridge = (bridge: PickUiBridge): void => {
  pickUiBridge = bridge;
};

const OVERLAY_ATTRIBUTE = "data-t3code-annotation-ui";
const INPUT_LAYER_ATTRIBUTE = "data-t3code-annotation-input";
const CONTENT_LAYER_Z_INDEX = 1;
const ELEMENT_CONTEXT_TIMEOUT_MS = 5_000;
export const PRIMARY = "var(--t3-primary)";
const PRIMARY_FILL = "color-mix(in srgb, var(--t3-primary) 10%, transparent)";

export type AnnotationTool = "select" | "marquee" | "draw" | "erase";

export interface SelectedElement {
  id: string;
  element: Element;
  outline: HTMLDivElement;
  label: HTMLDivElement;
  baselineStyles: Map<string, string>;
}

export interface AnnotationSession {
  teardown: (notifyMain: boolean) => void;
  applyTheme: (theme: DesktopPreviewAnnotationTheme) => void;
  setSendEnabled: (enabled: boolean) => void;
}

export const applyAnnotationTheme = (
  host: HTMLElement,
  theme: DesktopPreviewAnnotationTheme | null,
): void => {
  if (!theme) return;
  host.style.colorScheme = theme.colorScheme;
  const variables = {
    "--t3-radius": theme.radius,
    "--t3-background": theme.background,
    "--t3-foreground": theme.foreground,
    "--t3-popover": theme.popover,
    "--t3-popover-foreground": theme.popoverForeground,
    "--t3-primary": theme.primary,
    "--t3-primary-foreground": theme.primaryForeground,
    "--t3-muted": theme.muted,
    "--t3-muted-foreground": theme.mutedForeground,
    "--t3-accent": theme.accent,
    "--t3-accent-foreground": theme.accentForeground,
    "--t3-border": theme.border,
    "--t3-input": theme.input,
    "--t3-ring": theme.ring,
    "--t3-font-sans": theme.fontSans,
    "--t3-font-mono": theme.fontMono,
  };
  for (const [name, value] of Object.entries(variables)) {
    host.style.setProperty(name, value);
  }
};

export const reportHumanPointerInput = (event: PointerEvent): void => {
  if (!event.isTrusted) return;
  pickUiBridge.send(HUMAN_INPUT_CHANNEL, {
    kind: "pointer",
    x: event.clientX,
    y: event.clientY,
    button: event.button,
  });
};

export const reportHumanKeyInput = (event: KeyboardEvent): void => {
  if (!event.isTrusted) return;
  pickUiBridge.send(HUMAN_INPUT_CHANNEL, {
    kind: "key",
    key: event.key,
    code: event.code,
  });
};

window.addEventListener("pointerdown", reportHumanPointerInput, true);
window.addEventListener("keydown", reportHumanKeyInput, true);

export const MOUSE_BUTTON_BACK = 3;
export const MOUSE_BUTTON_FORWARD = 4;

export const navigationDirectionForButton = (button: number): "back" | "forward" | null => {
  if (button === MOUSE_BUTTON_BACK) return "back";
  if (button === MOUSE_BUTTON_FORWARD) return "forward";
  return null;
};

// Chromium routes thumb-button navigation to the focused WebContents; navigate this hovered guest explicitly.
export const suppressNavigationButton = (event: MouseEvent): void => {
  if (!event.isTrusted || navigationDirectionForButton(event.button) === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};

export const requestNavigationForButton = (event: MouseEvent): void => {
  if (!event.isTrusted) return;
  const direction = navigationDirectionForButton(event.button);
  if (direction === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  pickUiBridge.send(MOUSE_NAVIGATE_CHANNEL, { direction });
};

window.addEventListener("mousedown", suppressNavigationButton, true);
window.addEventListener("mouseup", requestNavigationForButton, true);
window.addEventListener("auxclick", suppressNavigationButton, true);

export const nextId = createAnnotationIdSource();

export const rectFromDomRect = (rect: DOMRect): PreviewAnnotationRect => ({
  x: rect.left,
  y: rect.top,
  width: rect.width,
  height: rect.height,
});

export const normalizeRect = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): PreviewAnnotationRect => ({
  x: Math.min(startX, endX),
  y: Math.min(startY, endY),
  width: Math.abs(endX - startX),
  height: Math.abs(endY - startY),
});

export const isUsableRect = (rect: PreviewAnnotationRect): boolean => rect.width >= 3 && rect.height >= 3;

export function unionRects(
  rects: ReadonlyArray<PreviewAnnotationRect>,
  padding = 20,
): PreviewAnnotationRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  // Main clips to the captured viewport; clipping here would lose offscreen bounds.
  return {
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  };
}

export function isAnnotationNode(element: Element): boolean {
  return element instanceof Element && element.closest(`[${OVERLAY_ATTRIBUTE}]`) !== null;
}

export function pickFromPoint(clientX: number, clientY: number): Element | null {
  for (const candidate of document.elementsFromPoint(clientX, clientY)) {
    if (!(candidate instanceof Element)) continue;
    if (isAnnotationNode(candidate) || candidate.hasAttribute(INPUT_LAYER_ATTRIBUTE)) continue;
    if (candidate === document.documentElement || candidate === document.body) continue;
    return candidate;
  }
  return null;
}

export function describeRawElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const classes =
    element instanceof HTMLElement && typeof element.className === "string"
      ? element.className
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join("")
      : "";
  return `${tag}${id}${classes}`;
}

export function createBox(color: string, fill: string): HTMLDivElement {
  const node = document.createElement("div");
  node.setAttribute(OVERLAY_ATTRIBUTE, "");
  node.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    `border:2px solid ${color}`,
    `background:${fill}`,
    "border-radius:3px",
    "box-sizing:border-box",
    "display:none",
    `z-index:${CONTENT_LAYER_Z_INDEX}`,
  ].join(";");
  return node;
}

export function positionBox(node: HTMLElement, rect: PreviewAnnotationRect): void {
  if (rect.width <= 0 || rect.height <= 0) {
    node.style.display = "none";
    return;
  }
  node.style.display = "block";
  node.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

export function visibleElementRect(element: Element): PreviewAnnotationRect {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(document.documentElement.clientWidth, rect.right);
  let bottom = Math.min(document.documentElement.clientHeight, rect.bottom);
  if (getComputedStyle(element).position !== "fixed") {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === document.body || ancestor === document.documentElement) break;
      const style = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      const clipLeft = bounds.left + ancestor.clientLeft;
      const clipTop = bounds.top + ancestor.clientTop;
      if (style.overflowX !== "visible") {
        left = Math.max(left, clipLeft);
        right = Math.min(right, clipLeft + ancestor.clientWidth);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, clipTop);
        bottom = Math.min(bottom, clipTop + ancestor.clientHeight);
      }
    }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function createLabel(): HTMLDivElement {
  const label = document.createElement("div");
  label.setAttribute(OVERLAY_ATTRIBUTE, "");
  label.className =
    "fixed z-1 max-w-70 overflow-hidden rounded-md bg-primary px-2 py-1 font-sans text-xs font-semibold text-primary-foreground shadow-md";
  label.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    "white-space:nowrap",
    "text-overflow:ellipsis",
    `z-index:${CONTENT_LAYER_Z_INDEX}`,
  ].join(";");
  return label;
}

export function updateSelectedVisual(target: SelectedElement): void {
  if (!target.element.isConnected) {
    target.outline.style.display = "none";
    target.label.style.display = "none";
    return;
  }
  const rect = visibleElementRect(target.element);
  positionBox(target.outline, rect);
  if (rect.width === 0 || rect.height === 0) {
    target.label.style.display = "none";
    return;
  }
  target.label.textContent = describeRawElement(target.element);
  target.label.style.display = "block";
  target.label.style.transform = `translate(${Math.max(4, rect.x)}px, ${Math.max(4, rect.y - 22)}px)`;
}

export function toStackFrame(frame: {
  functionName?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}): PickedElementStackFrame {
  return {
    functionName: frame.functionName ?? null,
    fileName: frame.fileName ?? null,
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
  };
}

/** React-internals lookups can remain pending forever; bound them so submit cannot stall the overlay. */
export function withCaptureTimeout<A>(promise: Promise<A>, millis: number): Promise<A | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), millis);
    }),
  ]).finally(() => clearTimeout(timer));
}

export const HTML_PREVIEW_MAX_CHARS = 500;

/** Preserve the tag, HTML, and crop rect when React context lookup fails or stalls. */
export async function captureElement(element: Element): Promise<PickedElementPayload> {
  const base = {
    pageUrl: location.href,
    pageTitle: document.title?.trim() || null,
    tagName: element.tagName.toLowerCase(),
    pickedAt: new Date().toISOString(),
  };
  try {
    const context = await withCaptureTimeout(
      Promise.resolve(getElementContext(element)),
      ELEMENT_CONTEXT_TIMEOUT_MS,
    );
    if (context) {
      const stack = (context.stack ?? []).map(toStackFrame);
      return {
        ...base,
        selector: context.selector,
        htmlPreview: context.htmlPreview ?? "",
        componentName: context.componentName,
        source: stack[0] ?? null,
        stack,
        styles: context.styles ?? "",
      };
    }
  } catch {}
  return {
    ...base,
    selector: null,
    htmlPreview: element.outerHTML.slice(0, HTML_PREVIEW_MAX_CHARS),
    componentName: null,
    source: null,
    stack: [],
    styles: "",
  };
}

export function createButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.className =
    "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-transparent px-2 font-sans text-xs font-medium text-foreground outline-none hover:bg-accent disabled:pointer-events-none disabled:opacity-60";
  return button;
}

export function styleControl(input: HTMLInputElement | HTMLSelectElement): void {
  input.setAttribute("aria-label", input.getAttribute("aria-label") ?? "Style value");
  input.className =
    "h-7 min-w-0 w-full appearance-none rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground shadow-xs outline-none";
}

export function createUnitControl(input: HTMLInputElement): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:relative;min-width:0";
  const unit = document.createElement("span");
  unit.textContent = input.dataset.unit ?? "";
  unit.className =
    "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-xs text-muted-foreground";
  wrapper.append(input, unit);
  return wrapper;
}

export function createField(
  labelText: string,
  input: HTMLInputElement | HTMLSelectElement,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className =
    "grid min-h-7 grid-cols-[82px_minmax(0,1fr)] items-center gap-2 font-sans text-xs font-medium text-muted-foreground";
  const text = document.createElement("span");
  text.textContent = labelText;
  styleControl(input);
  label.append(
    text,
    input instanceof HTMLInputElement && input.dataset.unit ? createUnitControl(input) : input,
  );
  return label;
}

export function createStyleSection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "grid gap-1 border-t border-border py-2";
  return section;
}

export function createUnitInput(unit: string, placeholder = "0"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.placeholder = placeholder;
  input.style.paddingRight = "30px";
  input.dataset.unit = unit;
  return input;
}

export function pathFromPoints(points: ReadonlyArray<PreviewAnnotationPoint>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y} l 0.01 0.01`;
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    path += ` Q ${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`;
  }
  const last = points[points.length - 1]!;
  path += ` L ${last.x} ${last.y}`;
  return path;
}

export function strokeBounds(
  points: ReadonlyArray<PreviewAnnotationPoint>,
  width: number,
): PreviewAnnotationRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = width + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  const right = Math.max(...xs) + padding;
  const bottom = Math.max(...ys) + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

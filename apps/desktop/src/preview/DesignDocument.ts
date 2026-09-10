import type { PreviewAnnotationPayload } from "@t3tools/contracts";

export const DESIGN_UI_ATTRIBUTE = "data-t3code-design-ui";
export const DESIGN_EDITING_ATTRIBUTE = "data-t3code-design-editing";
export const DESIGN_OPEN_ATTRIBUTE = "data-t3code-design-open";

export interface DesignElementState {
  style: string;
  text: string | null;
  x: string | null;
  y: string | null;
}

export function captureDesignElementState(element: HTMLElement | SVGElement): DesignElementState {
  return {
    style: element.style.cssText,
    text: element.childElementCount === 0 ? element.textContent : null,
    x: element.getAttribute("data-t3-design-x"),
    y: element.getAttribute("data-t3-design-y"),
  };
}

export function applyDesignElementState(
  element: HTMLElement | SVGElement,
  state: DesignElementState,
): void {
  element.style.cssText = state.style;
  if (state.text !== null) element.textContent = state.text;
  for (const [name, value] of [
    ["data-t3-design-x", state.x],
    ["data-t3-design-y", state.y],
  ] as const) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
}

export function designElementStatesMatch(
  left: DesignElementState,
  right: DesignElementState,
): boolean {
  return (
    left.style === right.style &&
    left.text === right.text &&
    left.x === right.x &&
    left.y === right.y
  );
}

export function cancelDesignInteraction(
  interaction:
    | { readonly kind: "create"; readonly element: Pick<Element, "remove"> }
    | {
        readonly kind: "move" | "resize";
        readonly element: HTMLElement | SVGElement;
        readonly before: DesignElementState;
      }
    | null,
): void {
  if (interaction?.kind === "create") interaction.element.remove();
  else if (interaction) applyDesignElementState(interaction.element, interaction.before);
}

export function rgbToHex(value: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const parts = value
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map((part) => Number(part) * (value.startsWith("color(srgb ") ? 255 : 1));
  return parts?.length === 3
    ? `#${parts
        .map((part) =>
          Math.max(0, Math.min(255, Math.round(part)))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`
    : fallback;
}

export function designColorWithAlpha(color: string, original: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
  return `rgb(from ${original} ${channels.join(" ")} / alpha)`;
}

export interface DesignSelectionInput {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  tagName: string;
  selector: string;
  htmlPreview: string;
  styles: string;
  rect: PreviewAnnotationPayload["elements"][number]["rect"];
  createdAt: string;
}

export function createDesignSelectionAnnotation(
  input: DesignSelectionInput,
): PreviewAnnotationPayload {
  const element = {
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    tagName: input.tagName,
    selector: input.selector,
    htmlPreview: input.htmlPreview,
    componentName: null,
    source: null,
    stack: [],
    styles: input.styles,
    pickedAt: input.createdAt,
  };
  return {
    id: `design-${input.id}`,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    comment: "Selected design element",
    elements: [{ id: input.id, element, rect: input.rect }],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: input.createdAt,
  };
}

const designLength = (value: string | undefined, relativeTo: number): number => {
  const number = Number.parseFloat(value ?? "");
  if (!Number.isFinite(number)) return 0;
  return value?.endsWith("%") ? (number * relativeTo) / 100 : number;
};

export function resolveDesignPosition(
  storedX: string | null,
  storedY: string | null,
  translate: string,
  width: number,
  height: number,
): { x: number; y: number } {
  if (storedX !== null || storedY !== null) {
    return {
      x: designLength(storedX ?? undefined, width),
      y: designLength(storedY ?? undefined, height),
    };
  }
  const [x, y] = translate === "none" ? [] : translate.split(/\s+/);
  return { x: designLength(x, width), y: designLength(y, height) };
}

export function designPathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.searchParams.get("t3-design-path");
    const segments = path?.split(/[\\/]/) ?? [];
    return parsed.searchParams.has("t3-design") &&
      parsed.pathname.startsWith("/api/assets/") &&
      path !== null &&
      path === path.trim() &&
      path.length > 0 &&
      path.length <= 1024 &&
      segments[0] === ".t3" &&
      segments[1] === "designs" &&
      segments.length > 2 &&
      !path.startsWith("/") &&
      !path.startsWith("\\") &&
      !/^[a-z]:[\\/]/i.test(path) &&
      !segments.includes("..") &&
      /\.html?$/i.test(path)
      ? path
      : null;
  } catch {
    return null;
  }
}

export function serializeDesignDocument(document: Document): string {
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  root.removeAttribute(DESIGN_OPEN_ATTRIBUTE);
  root.querySelectorAll(`[${DESIGN_UI_ATTRIBUTE}]`).forEach((element) => element.remove());
  root.querySelectorAll(`[${DESIGN_EDITING_ATTRIBUTE}]`).forEach((element) => {
    element.removeAttribute(DESIGN_EDITING_ATTRIBUTE);
    element.removeAttribute("contenteditable");
  });
  return `<!doctype html>\n${root.outerHTML}`;
}

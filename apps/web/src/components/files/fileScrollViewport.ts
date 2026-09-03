import { type FileScrollSurface, rememberFileScrollPosition } from "~/fileScrollState";

function fileScrollAnchorRoot(
  viewport: HTMLElement,
  surface: FileScrollSurface,
): ParentNode | null {
  if (surface === "markdown") return viewport;
  const fileContainer = viewport.querySelector<HTMLElement>("diffs-container");
  return fileContainer?.shadowRoot ?? fileContainer;
}

function fileScrollAnchorSelector(surface: FileScrollSurface): string {
  return surface === "markdown" ? "[data-source-line]" : "[data-line]";
}

function fileScrollAnchorElements(
  viewport: HTMLElement,
  surface: FileScrollSurface,
): HTMLElement[] {
  const root = fileScrollAnchorRoot(viewport, surface);
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(fileScrollAnchorSelector(surface)));
}

function fileScrollAnchorLine(element: HTMLElement, surface: FileScrollSurface): number | null {
  const value = surface === "markdown" ? element.dataset.sourceLine : element.dataset.line;
  const line = Number(value);
  return Number.isSafeInteger(line) && line > 0 ? line : null;
}

function readFileScrollAnchorLine(
  viewport: HTMLElement,
  surface: FileScrollSurface,
): number | null {
  const anchorRoot = fileScrollAnchorRoot(viewport, surface);
  if (!anchorRoot) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const hitTestRoot = anchorRoot instanceof ShadowRoot ? anchorRoot : viewport.ownerDocument;
  const horizontalInset = Math.min(24, viewportRect.width / 4);
  const xCoordinates = [
    viewportRect.left + horizontalInset,
    viewportRect.left + viewportRect.width / 2,
    viewportRect.right - horizontalInset,
  ];
  const selector = fileScrollAnchorSelector(surface);

  for (let y = viewportRect.top + 1; y < viewportRect.bottom; y += 24) {
    for (const x of xCoordinates) {
      const hit = hitTestRoot.elementFromPoint(x, y);
      const anchor = hit instanceof Element ? hit.closest<HTMLElement>(selector) : null;
      if (!anchor || !anchorRoot.contains(anchor)) continue;
      const line = fileScrollAnchorLine(anchor, surface);
      if (line !== null) return line;
    }
  }
  return null;
}

export function resolveFileScrollAnchorTop(
  viewport: HTMLElement,
  surface: FileScrollSurface,
  anchorLine: number,
): number | null {
  let exact: HTMLElement | null = null;
  let next: { element: HTMLElement; line: number } | null = null;
  let previous: { element: HTMLElement; line: number } | null = null;
  for (const element of fileScrollAnchorElements(viewport, surface)) {
    const line = fileScrollAnchorLine(element, surface);
    if (line === null) continue;
    if (line === anchorLine) {
      exact = element;
      break;
    }
    if (line > anchorLine && (next === null || line < next.line)) next = { element, line };
    if (line < anchorLine && (previous === null || line > previous.line)) {
      previous = { element, line };
    }
  }
  // The source view is virtualized, so a neighbouring mounted line says nothing about where the
  // requested line is; report no anchor and let the caller fall back to a line estimate. Markdown
  // mounts every block, so the nearest anchored block is the right answer there.
  const element = surface === "source" ? exact : (exact ?? next?.element ?? previous?.element);
  if (!element) return null;
  const viewportRect = viewport.getBoundingClientRect();
  return viewport.scrollTop + element.getBoundingClientRect().top - viewportRect.top;
}

export function rememberFileScrollPositionFromViewport(input: {
  positionKey: string;
  viewport: HTMLElement;
  surface: FileScrollSurface;
}): void {
  rememberFileScrollPosition(
    input.positionKey,
    input.viewport.scrollTop,
    Math.max(0, input.viewport.scrollHeight - input.viewport.clientHeight),
    {
      surface: input.surface,
      anchorLine: readFileScrollAnchorLine(input.viewport, input.surface),
    },
  );
}

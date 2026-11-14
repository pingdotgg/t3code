import type {
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
} from "@t3tools/contracts";

import { unionRects, visibleElementRect, type SelectedElement } from "./pickPreloadUi.ts";

export interface AnnotationEditorPlacementInput {
  readonly editor: HTMLElement;
  readonly stylePanel: HTMLElement;
  readonly dragHandle: HTMLElement;
  readonly adjust: HTMLButtonElement;
  readonly selected: ReadonlyMap<Element, SelectedElement>;
  readonly regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  readonly strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  readonly syncStyleControls: () => void;
}

/** Owns the annotation editor's expanded state and its viewport-clamped placement. */
export function createAnnotationEditorPlacement(input: AnnotationEditorPlacementInput) {
  const { editor, stylePanel, dragHandle, adjust, selected, regions, strokes, syncStyleControls } =
    input;
  let expanded = false;
  let position: { left: number; top: number } | null = null;
  let layoutFrame: number | null = null;
  const clampEditorPosition = (left: number, top: number): { left: number; top: number } => {
    const margin = 8;
    const rect = editor.getBoundingClientRect();
    return {
      left: Math.min(
        Math.max(margin, left),
        Math.max(margin, window.innerWidth - rect.width - margin),
      ),
      top: Math.min(
        Math.max(margin, top),
        Math.max(margin, window.innerHeight - rect.height - margin),
      ),
    };
  };

  const applyEditorPosition = (position: { left: number; top: number }): void => {
    const clamped = clampEditorPosition(position.left, position.top);
    editor.style.left = `${clamped.left}px`;
    editor.style.top = `${clamped.top}px`;
    editor.style.right = "auto";
    editor.style.bottom = "auto";
    if (expanded) position = clamped;
  };

  const getAnnotationBounds = (): PreviewAnnotationRect | null =>
    unionRects(
      [
        ...Array.from(selected.values(), (target) => visibleElementRect(target.element)).filter(
          (rect) => rect.width > 0 && rect.height > 0,
        ),
        ...regions.map((region) => region.rect),
        ...strokes.map((stroke) => stroke.bounds),
      ],
      0,
    );

  const positionCompactEditor = (): void => {
    const bounds = getAnnotationBounds();
    if (!bounds) return;
    const editorRect = editor.getBoundingClientRect();
    const gap = 8;
    const candidates = [
      { left: bounds.x + bounds.width + gap, top: bounds.y },
      { left: bounds.x - editorRect.width - gap, top: bounds.y },
      {
        left: bounds.x + bounds.width - editorRect.width,
        top: bounds.y + bounds.height + gap,
      },
      {
        left: bounds.x + bounds.width - editorRect.width,
        top: bounds.y - editorRect.height - gap,
      },
    ];
    const overflow = (position: { left: number; top: number }): number =>
      Math.max(0, -position.left) +
      Math.max(0, -position.top) +
      Math.max(0, position.left + editorRect.width - window.innerWidth) +
      Math.max(0, position.top + editorRect.height - window.innerHeight);
    const best = candidates.reduce((current, candidate) =>
      overflow(candidate) < overflow(current) ? candidate : current,
    );
    applyEditorPosition(best);
  };

  function queueEditorLayout(): void {
    if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = null;
      if (editor.style.display === "none") return;
      if (expanded && position) applyEditorPosition(position);
      else positionCompactEditor();
    });
  }

  const toggleExpanded = (): void => {
    if (selected.size === 0) return;
    if (!expanded) {
      const rect = editor.getBoundingClientRect();
      expanded = true;
      position = { left: rect.left, top: rect.top };
      stylePanel.style.display = selected.size > 0 ? "grid" : "none";
      dragHandle.style.display = "block";
      adjust.setAttribute("aria-expanded", "true");
      adjust.title = "Collapse annotation editor";
      adjust.setAttribute("aria-label", "Collapse annotation editor");
      if (selected.size > 0) syncStyleControls();
    } else {
      expanded = false;
      position = null;
      stylePanel.style.display = "none";
      dragHandle.style.display = "none";
      adjust.setAttribute("aria-expanded", "false");
      adjust.title = "Expand annotation editor";
      adjust.setAttribute("aria-label", "Expand annotation editor");
    }
    queueEditorLayout();
  };

  const cancelLayout = (): void => {
    if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
  };

  return {
    get expanded(): boolean {
      return expanded;
    },
    applyEditorPosition,
    queueEditorLayout,
    toggleExpanded,
    cancelLayout,
  };
}

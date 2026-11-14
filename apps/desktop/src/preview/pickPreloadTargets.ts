import type {
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
} from "@t3tools/contracts";

import { isAnnotationNode, type SelectedElement } from "./pickPreloadUi.ts";

const MAX_MARQUEE_ELEMENTS = 20;

export interface AnnotationTargetRemovalInput {
  readonly selected: ReadonlyMap<Element, SelectedElement>;
  readonly regions: PreviewAnnotationRegionTarget[];
  readonly strokes: PreviewAnnotationStrokeTarget[];
  readonly root: HTMLElement;
  readonly svg: SVGSVGElement;
  readonly removeSelected: (target: SelectedElement) => void;
  readonly addSelected: (element: Element) => void;
  readonly updateStatus: () => void;
}

/** Erase-by-point and marquee selection over the host page's elements. */
export function createAnnotationTargets(input: AnnotationTargetRemovalInput) {
  const { selected, regions, strokes, root, svg, removeSelected, addSelected, updateStatus } = input;

  const removeTargetAtPoint = (x: number, y: number): boolean => {
    for (const target of Array.from(selected.values()).toReversed()) {
      const rect = target.element.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        removeSelected(target);
        return true;
      }
    }
    const regionIndex = regions.findIndex(
      (region) =>
        x >= region.rect.x &&
        x <= region.rect.x + region.rect.width &&
        y >= region.rect.y &&
        y <= region.rect.y + region.rect.height,
    );
    if (regionIndex >= 0) {
      const [removed] = regions.splice(regionIndex, 1);
      root.querySelector(`[data-region-id="${removed?.id}"]`)?.remove();
      updateStatus();
      return true;
    }
    const strokeIndex = strokes.findIndex(
      (stroke) =>
        x >= stroke.bounds.x &&
        x <= stroke.bounds.x + stroke.bounds.width &&
        y >= stroke.bounds.y &&
        y <= stroke.bounds.y + stroke.bounds.height,
    );
    if (strokeIndex >= 0) {
      const [removed] = strokes.splice(strokeIndex, 1);
      svg.querySelector(`[data-stroke-id="${removed?.id}"]`)?.remove();
      updateStatus();
      return true;
    }
    return false;
  };

  const selectElementsInRect = (rect: PreviewAnnotationRect): number => {
    const candidates = Array.from(document.querySelectorAll("body *"))
      .filter((element) => !isAnnotationNode(element))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect: candidate }) => {
        if (candidate.width < 2 || candidate.height < 2) return false;
        return !(
          candidate.right < rect.x ||
          candidate.left > rect.x + rect.width ||
          candidate.bottom < rect.y ||
          candidate.top > rect.y + rect.height
        );
      })
      .filter(({ element, rect: candidate }) => {
        const centerX = candidate.left + candidate.width / 2;
        const centerY = candidate.top + candidate.height / 2;
        return (
          centerX >= rect.x &&
          centerX <= rect.x + rect.width &&
          centerY >= rect.y &&
          centerY <= rect.y + rect.height &&
          (element.children.length === 0 ||
            element instanceof HTMLButtonElement ||
            element instanceof HTMLAnchorElement ||
            element.getAttribute("role") === "button")
        );
      })
      .sort(
        (left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height,
      )
      .slice(0, MAX_MARQUEE_ELEMENTS);
    for (const candidate of candidates) addSelected(candidate.element);
    return candidates.length;
  };

  return { removeTargetAtPoint, selectElementsInRect };
}

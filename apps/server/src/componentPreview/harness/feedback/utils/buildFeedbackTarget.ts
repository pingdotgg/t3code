import type { PreviewFeedbackElementTarget } from "../types.ts";
import {
  getAccessibilityInfo,
  getDetailedComputedStyles,
  getElementClasses,
  getElementPath,
  getFullElementPath,
  getNearbyElements,
  getNearbyText,
  identifyElement,
} from "./domMetadata.ts";
import { getPopupPosition, isElementFixed } from "./positioning.ts";
import { readReactMetadata } from "./reactMetadata.ts";

function formatComputedStyles(styles: Record<string, string>): string | null {
  const entries = Object.entries(styles);
  if (entries.length === 0) {
    return null;
  }
  return entries
    .map(([key, value]) => `${key.replace(/([A-Z])/g, "-$1").toLowerCase()}: ${value}`)
    .join("; ");
}

export function buildFeedbackTarget(
  element: HTMLElement,
  rectOverride?: DOMRect,
): PreviewFeedbackElementTarget {
  const rect = rectOverride ?? element.getBoundingClientRect();
  const identified = identifyElement(element);
  const computedStyleMap = getDetailedComputedStyles(element);
  const reactMetadata = readReactMetadata(element);
  const fixed = isElementFixed(element);

  return {
    kind: "element",
    element: identified.name,
    elementPath: identified.path || getElementPath(element),
    fullPath: getFullElementPath(element),
    cssClasses: getElementClasses(element),
    computedStyles: formatComputedStyles(computedStyleMap),
    computedStyleMap,
    accessibility: getAccessibilityInfo(element),
    nearbyText: getNearbyText(element),
    nearbyElements: getNearbyElements(element),
    reactComponents: reactMetadata.componentPath,
    sourceFile: reactMetadata.sourceFile,
    boundingBox: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
    marker: {
      xPercent: ((rect.left + rect.width / 2) / Math.max(window.innerWidth, 1)) * 100,
      yDocument: fixed ? rect.top + rect.height / 2 : window.scrollY + rect.top + rect.height / 2,
      isFixed: fixed,
    },
  };
}

export { getPopupPosition };

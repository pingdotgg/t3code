import { contentInlineWidth } from "../../lib/contentInlineWidth";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";
import { resolveRestingComposerControlsNaturalWidth } from "../composerFooterLayout";

const COMPOSER_CONTEXT_LABEL_SELECTOR = "[data-composer-label]";

/**
 * The width a label takes when shown, clipped parts included.
 *
 * Text keeps its full width when its box clips it, so each text run measures
 * whole. A label can hold more than one run (MiddleTruncate splits a branch
 * into a head and a tail), so the runs are added. Reading one element's
 * scrollWidth drops the tail when the label is hidden or squeezed, and the
 * strip then flips between labels and icons on every measure.
 *
 * A shown label never grows past its motion span's max width, so longer text
 * reserves only that much.
 */
function labelTextWidth(label: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    width += range.getBoundingClientRect().width;
  }
  const motion = label.querySelector<HTMLElement>("[data-composer-label-motion]");
  const maxWidth = motion ? Number.parseFloat(getComputedStyle(motion).maxWidth) : Number.NaN;
  return Number.isFinite(maxWidth) ? Math.min(width, maxWidth) : width;
}

/**
 * The laid-out width of a group's in-flow children.
 *
 * `flex-1` stretches the groups to fill the strip, so their own boxes always
 * measure "full". Summing the laid-out content instead skips hidden form
 * artifacts and other out-of-flow nodes.
 */
function contentWidth(parent: Element): number {
  const style = getComputedStyle(parent);
  const gap = Number.parseFloat(style.columnGap) || 0;
  let width = 0;
  let counted = 0;
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.offsetWidth === 0) continue;
    const childStyle = getComputedStyle(child);
    const position = childStyle.position;
    if (position === "absolute" || position === "fixed") continue;
    width +=
      child.offsetWidth +
      (Number.parseFloat(childStyle.marginInlineStart) || 0) +
      (Number.parseFloat(childStyle.marginInlineEnd) || 0);
    counted += 1;
  }
  return width + gap * Math.max(0, counted - 1);
}

export interface ContextStripMeasurement {
  /** Every group's laid-out width plus the labels the strip would like to show. */
  neededWidth: number;
  /** What the strip can actually give its children. */
  availableWidth: number;
  /** Every `[data-composer-label]` box, for the caller's collapse animation. */
  labels: readonly HTMLElement[];
}

/**
 * Read the context strip's fit from the DOM: what its groups and expandable
 * labels need, and what it can give them. Free space goes through
 * `contentInlineWidth`, the same read the composer applies to the host it docks
 * its resting controls into, so neither side can count the strip's `ps-1 pe-2`
 * as room the other one hasn't already spent.
 *
 * Returns `null` while the strip has no layout, so the caller keeps its previous
 * answer instead of collapsing everything against a zero-width row.
 */
export function measureContextStrip(element: HTMLElement): ContextStripMeasurement | null {
  if (element.clientWidth === 0) return null;

  const stripStyle = getComputedStyle(element);
  const availableWidth = contentInlineWidth(element, stripStyle);
  const stripGap = Number.parseFloat(stripStyle.columnGap) || 0;

  let needed = 0;
  let groups = 0;
  for (const child of element.children) {
    if (!(child instanceof HTMLElement)) continue;
    // The host itself flexes into all remaining room. Reserve the natural
    // width of the controls inside it, blocks in overflow included, so Git
    // labels compact before squeezing out the model picker. Reserving only
    // the visible controls would let the labels expand into room the
    // composer just freed, shrink the host, and hide the controls again.
    const hostedControls = child.matches('[data-chat-resting-composer-controls-host="true"]')
      ? child.querySelector<HTMLElement>('[data-chat-composer-resting-controls="true"]')
      : null;
    const hostedMeasurement = hostedControls
      ? measureRestingComposerControls(hostedControls)
      : null;
    const width = hostedMeasurement
      ? resolveRestingComposerControlsNaturalWidth(hostedMeasurement)
      : contentWidth(hostedControls ?? child);
    if (width <= 1) continue;
    groups += 1;
    needed += width;
  }
  needed += stripGap * Math.max(0, groups - 1);

  const labels = Array.from(element.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_LABEL_SELECTOR));
  const range = document.createRange();
  for (const label of labels) {
    // Subtract the visible width even during an animation. The content
    // sum already includes it; only the hidden text needs reserving.
    needed += Math.max(0, labelTextWidth(label, range) - label.getBoundingClientRect().width);
  }

  return { neededWidth: needed, availableWidth, labels };
}

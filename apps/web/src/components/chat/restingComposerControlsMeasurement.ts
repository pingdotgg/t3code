import type { RestingComposerControlsMeasurement } from "../composerFooterLayout";

function elementOuterWidth(element: HTMLElement): number {
  const width = element.getBoundingClientRect().width;
  if (width === 0) return 0;
  const style = getComputedStyle(element);
  return (
    width +
    (Number.parseFloat(style.marginInlineStart) || 0) +
    (Number.parseFloat(style.marginInlineEnd) || 0)
  );
}

function elementInlineMarginWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    (Number.parseFloat(style.marginInlineStart) || 0) +
    (Number.parseFloat(style.marginInlineEnd) || 0)
  );
}

function providerModelPickerNaturalWidth(picker: HTMLElement): number {
  const renderedWidth = picker.getBoundingClientRect().width;
  if (renderedWidth === 0) return 0;
  const style = getComputedStyle(picker);
  const label = picker.querySelector<HTMLElement>('[data-chat-provider-model-picker-label="true"]');
  const hiddenLabelWidth = label ? Math.max(0, label.scrollWidth - label.clientWidth) : 0;
  const maxWidth = Number.parseFloat(style.maxWidth);
  const naturalWidth = Math.min(
    renderedWidth + hiddenLabelWidth,
    Number.isFinite(maxWidth) ? maxWidth : Number.POSITIVE_INFINITY,
  );
  return naturalWidth + elementInlineMarginWidth(picker);
}

function providerModelPickerMinimumWidth(picker: HTMLElement): number {
  const minWidth = Number.parseFloat(getComputedStyle(picker).minWidth) || 0;
  return minWidth + elementInlineMarginWidth(picker);
}

/**
 * Read the natural widths of the resting composer controls from the DOM.
 *
 * Both the composer (deciding which blocks move into overflow) and the
 * context strip (deciding whether its labels may expand) read the same
 * numbers, so neither decision depends on what the other one hid last render.
 *
 * Hidden blocks and the unused overflow trigger stay mounted out of flow at
 * full size. The picker is the one flexible item: its intended width is
 * recovered from the truncated label.
 */
export function measureRestingComposerControls(
  controls: HTMLElement,
): RestingComposerControlsMeasurement | null {
  const gap = Number.parseFloat(getComputedStyle(controls).columnGap) || 0;
  const picker = controls.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
  const leadingControl =
    picker ?? controls.querySelector<HTMLElement>('[data-chat-provider-unavailable="true"]');
  if (!leadingControl) return null;
  // Separators are display:none on phone widths; a hidden one takes no gap.
  const separator = controls.querySelector<HTMLElement>("[data-resting-controls-separator]");
  const separatorWidth = separator ? elementOuterWidth(separator) : 0;
  const overflow = controls.querySelector<HTMLElement>("[data-resting-controls-overflow]");
  const separatorAndGapWidth = separatorWidth > 0 ? separatorWidth + gap : 0;
  const blocks = Array.from(controls.querySelectorAll<HTMLElement>("[data-resting-block]"));
  return {
    gap,
    naturalFixedWidth:
      (picker ? providerModelPickerNaturalWidth(picker) : elementOuterWidth(leadingControl)) +
      separatorAndGapWidth,
    minimumFixedWidth:
      (picker ? providerModelPickerMinimumWidth(picker) : elementOuterWidth(leadingControl)) +
      separatorAndGapWidth,
    blockWidths: blocks.map(elementOuterWidth),
    overflowWidth: overflow ? elementOuterWidth(overflow) : 0,
  };
}

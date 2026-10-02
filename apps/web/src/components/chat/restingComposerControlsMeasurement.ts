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
  // Narrow composers deliberately collapse the label with w-0 and flex-none.
  // A flexible label squeezed to zero still needs its natural width recovered.
  const labelIsCollapsed = label?.clientWidth === 0 && getComputedStyle(label).flexGrow === "0";
  const hiddenLabelWidth =
    label && !labelIsCollapsed ? Math.max(0, label.scrollWidth - label.clientWidth) : 0;
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

function controlBlockWidths(block: HTMLElement): { natural: number; iconOnly: number } {
  const compact = block.dataset.composerBlockIconOnly === "true";
  let natural = elementOuterWidth(block);
  let iconOnly = natural;
  for (const label of block.querySelectorAll<HTMLElement>("[data-composer-control-label]")) {
    // Labels remain mounted at natural width when icons replace them. Reading
    // both variants from one tree avoids duplicate controls or write/read probes.
    const labelStyle = getComputedStyle(label);
    const inFlow = labelStyle.position !== "absolute";
    // Phone widths already hide the build label with sr-only. Its clipping
    // remains in effect even when compact styles replace its one-pixel width.
    if (!inFlow && (!compact || labelStyle.clip !== "auto")) continue;
    const labelWidth = label.scrollWidth;
    const renderedWidth = inFlow ? label.getBoundingClientRect().width : 0;
    const gap = Number.parseFloat(getComputedStyle(label.parentElement!).columnGap) || 0;
    natural += labelWidth - renderedWidth + (inFlow ? 0 : gap);
    iconOnly -= renderedWidth + (inFlow ? gap : 0);
  }
  for (const icon of block.querySelectorAll<HTMLElement>("[data-composer-control-compact-icon]")) {
    const width = elementOuterWidth(icon);
    const gap = Number.parseFloat(getComputedStyle(icon.parentElement!).columnGap) || 0;
    natural -= compact ? width + gap : 0;
    iconOnly += compact ? 0 : width + gap;
  }
  return { natural, iconOnly: Math.min(natural, iconOnly) };
}

/**
 * Read the natural widths of the resting composer controls from the DOM.
 *
 * Hidden blocks and the unused overflow trigger stay mounted out of flow at
 * full size, so every pass measures the same natural numbers regardless of
 * what the previous pass hid. The picker is the one flexible item: its
 * intended width is recovered from the truncated label.
 */
export function measureRestingComposerControls(
  controls: HTMLElement,
): RestingComposerControlsMeasurement | null {
  const gap = Number.parseFloat(getComputedStyle(controls).columnGap) || 0;
  const picker = controls.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
  const leadingControl =
    picker ?? controls.querySelector<HTMLElement>('[data-chat-provider-unavailable="true"]');
  if (!leadingControl) return null;
  const overflow = controls.querySelector<HTMLElement>("[data-resting-controls-overflow]");
  const blocks = Array.from(controls.querySelectorAll<HTMLElement>("[data-resting-block]"));
  const widths = blocks.map(controlBlockWidths);
  return {
    gap,
    naturalFixedWidth: picker
      ? providerModelPickerNaturalWidth(picker)
      : elementOuterWidth(leadingControl),
    minimumFixedWidth: picker
      ? providerModelPickerMinimumWidth(picker)
      : elementOuterWidth(leadingControl),
    blockWidths: widths.map((width) => width.natural),
    iconOnlyBlockWidths: widths.map((width) => width.iconOnly),
    overflowWidth: overflow ? elementOuterWidth(overflow) : 0,
  };
}

/**
 * The room a host leaves for the resting controls: its content box minus
 * the prompt's reservation (the pixel value its reserved element carries)
 * and the rendered width of any image previews, each with the row gap.
 * Reading a constant for the prompt instead of its rendered width keeps the
 * answer independent of how much room the controls took last render.
 */
export function measureRestingComposerControlsHostWidth(host: HTMLElement): number {
  const style = getComputedStyle(host);
  const contentWidth =
    host.clientWidth -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0);
  const reserved = host.querySelector<HTMLElement>("[data-resting-controls-reserved]");
  if (!reserved) return contentWidth;
  const gap = Number.parseFloat(style.columnGap) || 0;
  const promptWidth = Number.parseFloat(reserved.dataset.restingControlsReserved ?? "") || 0;
  const previews = host.querySelector<HTMLElement>('[data-chat-composer-resting-images="true"]');
  const previewsWidth = previews ? elementOuterWidth(previews) : 0;
  return contentWidth - promptWidth - gap - (previewsWidth > 0 ? previewsWidth + gap : 0);
}

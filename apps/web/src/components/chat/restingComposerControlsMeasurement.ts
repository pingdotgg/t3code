import type { RestingComposerControlsMeasurement } from "../composerFooterLayout";

function elementOuterWidth(element: HTMLElement, scale: number): number {
  const width = element.getBoundingClientRect().width / scale;
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

function providerModelPickerNaturalWidth(picker: HTMLElement, scale: number): number {
  const renderedWidth = picker.getBoundingClientRect().width / scale;
  if (renderedWidth === 0) return 0;
  const style = getComputedStyle(picker);
  const label = picker.querySelector<HTMLElement>('[data-chat-provider-model-picker-label="true"]');
  const labelIsCollapsed = label?.clientWidth === 0 && getComputedStyle(label).flexGrow === "0";
  // A label with its own max width, such as a long model name, never grows past it.
  const labelMaxWidth = label ? Number.parseFloat(getComputedStyle(label).maxWidth) : Number.NaN;
  const hiddenLabelWidth =
    label && !labelIsCollapsed
      ? Math.max(
          0,
          Math.min(
            label.scrollWidth,
            Number.isFinite(labelMaxWidth) ? labelMaxWidth : Number.POSITIVE_INFINITY,
          ) - label.clientWidth,
        )
      : 0;
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

function controlBlockWidths(
  block: HTMLElement,
  scale: number,
): { natural: number; iconOnly: number } {
  const compact = block.dataset.composerBlockIconOnly === "true";
  let natural = elementOuterWidth(block, scale);
  let iconOnly = natural;
  for (const label of block.querySelectorAll<HTMLElement>("[data-composer-control-label]")) {
    const labelStyle = getComputedStyle(label);
    const inFlow = labelStyle.position !== "absolute";
    // Phone sr-only clipping survives compact styles overriding the label width.
    if (!inFlow && (!compact || labelStyle.clip !== "auto")) continue;
    const labelWidth = label.scrollWidth;
    const renderedWidth = inFlow ? label.getBoundingClientRect().width / scale : 0;
    const gap = Number.parseFloat(getComputedStyle(label.parentElement!).columnGap) || 0;
    natural += labelWidth - renderedWidth + (inFlow ? 0 : gap);
    iconOnly -= renderedWidth + (inFlow ? gap : 0);
  }
  for (const icon of block.querySelectorAll<HTMLElement>("[data-composer-control-compact-icon]")) {
    const width = elementOuterWidth(icon, scale);
    const gap = Number.parseFloat(getComputedStyle(icon.parentElement!).columnGap) || 0;
    natural -= compact ? width + gap : 0;
    iconOnly += compact ? 0 : width + gap;
  }
  return { natural, iconOnly: Math.min(natural, iconOnly) };
}

/** Measure independently of controls hidden by the previous render. */
export function measureRestingComposerControls(
  controls: HTMLElement,
): RestingComposerControlsMeasurement | null {
  const style = getComputedStyle(controls);
  const gap = Number.parseFloat(style.columnGap) || 0;
  // Rects include the overview's scale; CSS gaps, margins and scrollWidth do not.
  // Recover the common scale from the fractional layout border box, not offsetWidth.
  const layoutWidth =
    Number.parseFloat(style.width) +
    (style.boxSizing === "border-box"
      ? 0
      : (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.paddingRight) || 0) +
        (Number.parseFloat(style.borderLeftWidth) || 0) +
        (Number.parseFloat(style.borderRightWidth) || 0));
  const measuredScale = controls.getBoundingClientRect().width / layoutWidth;
  const scale = Number.isFinite(measuredScale) && measuredScale > 0 ? measuredScale : 1;
  const picker = controls.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
  const leadingControl =
    picker ?? controls.querySelector<HTMLElement>('[data-chat-provider-unavailable="true"]');
  if (!leadingControl) return null;
  const separator = controls.querySelector<HTMLElement>("[data-resting-controls-separator]");
  const separatorWidth = separator ? elementOuterWidth(separator, scale) : 0;
  const overflow = controls.querySelector<HTMLElement>("[data-resting-controls-overflow]");
  const separatorAndGapWidth = separatorWidth > 0 ? separatorWidth + gap : 0;
  const blocks = Array.from(controls.querySelectorAll<HTMLElement>("[data-resting-block]"));
  const widths = blocks.map((block) => controlBlockWidths(block, scale));
  return {
    gap,
    naturalFixedWidth:
      (picker
        ? providerModelPickerNaturalWidth(picker, scale)
        : elementOuterWidth(leadingControl, scale)) + separatorAndGapWidth,
    minimumFixedWidth:
      (picker
        ? providerModelPickerMinimumWidth(picker)
        : elementOuterWidth(leadingControl, scale)) + separatorAndGapWidth,
    blockWidths: widths.map((width) => width.natural),
    iconOnlyBlockWidths: widths.map((width) => width.iconOnly),
    overflowWidth: overflow ? elementOuterWidth(overflow, scale) : 0,
  };
}

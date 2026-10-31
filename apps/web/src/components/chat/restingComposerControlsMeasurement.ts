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

function horizontalBoxWidth(style: CSSStyleDeclaration): number {
  return (
    (Number.parseFloat(style.paddingInlineStart) || 0) +
    (Number.parseFloat(style.paddingInlineEnd) || 0) +
    (Number.parseFloat(style.borderInlineStartWidth) || 0) +
    (Number.parseFloat(style.borderInlineEndWidth) || 0)
  );
}

function providerModelPickerLabel(picker: HTMLElement): HTMLElement | null {
  return picker.querySelector<HTMLElement>('[data-chat-provider-model-picker-label="true"]');
}

/** Measure padding, border and icon independently of label visibility to keep fitting stable. */
function providerModelPickerIconOnlyWidth(picker: HTMLElement, scale: number): number | undefined {
  const label = providerModelPickerLabel(picker);
  const wrapper = label?.parentElement?.firstElementChild;
  const icon =
    wrapper instanceof HTMLElement && getComputedStyle(wrapper).display === "contents"
      ? wrapper.firstElementChild
      : wrapper;
  if (!label || !(icon instanceof HTMLElement) || icon === label) return undefined;
  return (
    horizontalBoxWidth(getComputedStyle(picker)) +
    elementOuterWidth(icon, scale) +
    elementInlineMarginWidth(picker)
  );
}

function providerModelPickerNaturalWidth(picker: HTMLElement, scale: number): number {
  const renderedWidth = picker.getBoundingClientRect().width / scale;
  if (renderedWidth === 0) return 0;
  const style = getComputedStyle(picker);
  const label = providerModelPickerLabel(picker);
  // A label with its own max width, such as a long model name, never grows past it.
  const labelMaxWidth = label ? Number.parseFloat(getComputedStyle(label).maxWidth) : Number.NaN;
  const labelWidth = label
    ? Math.min(
        label.scrollWidth,
        Number.isFinite(labelMaxWidth) ? labelMaxWidth : Number.POSITIVE_INFINITY,
      )
    : 0;
  let naturalWidth = renderedWidth;
  if (label && getComputedStyle(label).position === "absolute") {
    // Recover the capped label width while the provider icon is the visible trigger.
    const content = label.parentElement!;
    naturalWidth += (Number.parseFloat(getComputedStyle(content).columnGap) || 0) + labelWidth;
  } else if (label) {
    // A flexible label squeezed below its text still needs its width recovered.
    naturalWidth += Math.max(0, labelWidth - label.clientWidth);
  }
  const maxWidth = Number.parseFloat(style.maxWidth);
  return (
    Math.min(naturalWidth, Number.isFinite(maxWidth) ? maxWidth : Number.POSITIVE_INFINITY) +
    elementInlineMarginWidth(picker)
  );
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
  // Compact icons stay in flow beside their label, so both variants already
  // include them. Adjusting for them here made each variant measure the other
  // 16px off, and the layout flipped between labels and icons every frame.
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
  const pickerIconOnlyWidth = picker ? providerModelPickerIconOnlyWidth(picker, scale) : undefined;
  const fixedControls = Array.from(
    controls.querySelectorAll<HTMLElement>("[data-resting-fixed-control]"),
  );
  const fixedWidths = fixedControls.map((control) => controlBlockWidths(control, scale));
  const fixedNatural = fixedWidths.reduce((sum, width) => sum + width.natural + gap, 0);
  const fixedIconOnly = fixedWidths.reduce((sum, width) => sum + width.iconOnly + gap, 0);
  return {
    gap,
    naturalFixedWidth:
      (picker
        ? providerModelPickerNaturalWidth(picker, scale)
        : elementOuterWidth(leadingControl, scale)) +
      separatorAndGapWidth +
      fixedNatural,
    minimumFixedWidth:
      (picker
        ? providerModelPickerMinimumWidth(picker)
        : elementOuterWidth(leadingControl, scale)) +
      separatorAndGapWidth +
      fixedNatural,
    blockWidths: widths.map((width) => width.natural),
    iconOnlyBlockWidths: widths.map((width) => width.iconOnly),
    overflowWidth: overflow ? elementOuterWidth(overflow, scale) : 0,
    ...(pickerIconOnlyWidth === undefined
      ? {}
      : { iconOnlyFixedWidth: pickerIconOnlyWidth + separatorAndGapWidth + fixedIconOnly }),
  };
}

// Keep the native drawing inset out of the visible size and edge margins.
export const FLOATING_TABS = { edge: 16, bottom: 6, gap: 12, shadow: 8 };

export function floatingTabsMetrics(
  count: number,
  scale: number,
  fabSize: number,
  paneWidth?: number,
  fillWidth = false,
) {
  const unit = Math.max(1, scale);
  const spacing = 2 * FLOATING_TABS.edge + FLOATING_TABS.gap;
  // Share width evenly when space is tight, retaining Android's 48dp touch target.
  const height =
    paneWidth === undefined
      ? fabSize
      : Math.max(48, Math.min(fabSize, (paneWidth - spacing) / (count + 1)));
  const beside = spacing + height;
  const room = paneWidth === undefined ? count * 60 * unit : paneWidth - beside;
  return {
    // Reserve the compose slot even while its button is hidden.
    pill: Math.max(0, fillWidth ? room : Math.min(count * 72 * unit, room)),
    height,
    row: beside + count * 60 * unit,
  };
}

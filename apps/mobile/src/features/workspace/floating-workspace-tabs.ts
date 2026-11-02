// Keep the native drawing inset out of the visible size and edge margins.
export const FLOATING_TABS = { edge: 16, bottom: 6, gap: 12, shadow: 8, height: 56, iconSize: 24 };

export function floatingTabsMetrics(count: number, paneWidth?: number, fillWidth = false) {
  const beside = 2 * FLOATING_TABS.edge + FLOATING_TABS.gap + FLOATING_TABS.height;
  const room = paneWidth === undefined ? count * 60 : paneWidth - beside;
  return {
    // Reserve the compose slot even while its button is hidden.
    pill: Math.max(0, fillWidth ? room : Math.min(count * 72, room)),
    height: FLOATING_TABS.height,
    row: beside + count * 60,
  };
}

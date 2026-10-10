import { observeResize } from "~/lib/observeResize";

/** Measure the currently mounted column and follow replacements made by virtualization. */
export function observeTimelineColumn(
  viewport: HTMLElement,
  onMeasure: (viewportWidth: number, contentWidth: number) => void,
) {
  let observedColumn: HTMLElement | null = null;
  let stopColumn: (() => void) | null = null;
  const measure = () => {
    const candidate = viewport.querySelector<HTMLElement>("[data-timeline-root]");
    const column = candidate?.isConnected ? candidate : null;
    if (column !== observedColumn) {
      stopColumn?.();
      observedColumn = column;
      stopColumn = column ? observeResize(column, measure) : null;
    }
    const viewportWidth = viewport.getBoundingClientRect().width;
    // No mounted row means no usable gutter; the hit strip must stay inert.
    onMeasure(viewportWidth, column?.getBoundingClientRect().width ?? viewportWidth);
  };
  const stopViewport = observeResize(viewport, measure);
  let frame = requestAnimationFrame(measure);
  const rowObserver = new MutationObserver((records) => {
    const rowAdded = records.some((record) => {
      if (record.target instanceof Element && record.target.closest("[data-timeline-root]")) {
        return false;
      }
      return Array.from(record.addedNodes).some(
        (node) =>
          node instanceof Element &&
          (node.matches("[data-timeline-root]") || node.querySelector("[data-timeline-root]")),
      );
    });
    // Row insertion/removal can leave viewport geometry unchanged. Coalesce it
    // into one measurement; ordinary streamed text does not change the column.
    if (!observedColumn?.isConnected || rowAdded) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
  });
  rowObserver.observe(viewport, { childList: true, subtree: true });
  return () => {
    cancelAnimationFrame(frame);
    stopColumn?.();
    stopViewport();
    rowObserver.disconnect();
  };
}

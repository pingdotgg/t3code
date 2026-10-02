/** Measure the currently mounted column and follow replacements made by virtualization. */
export function observeTimelineColumn(
  viewport: HTMLElement,
  onMeasure: (viewportWidth: number, contentWidth: number) => void,
) {
  let observedColumn: HTMLElement | null = null;
  const measure = () => {
    const candidate = viewport.querySelector<HTMLElement>("[data-timeline-root]");
    const column = candidate?.isConnected ? candidate : null;
    if (column !== observedColumn) {
      if (observedColumn) observer.unobserve(observedColumn);
      observedColumn = column;
      if (column) observer.observe(column);
    }
    const viewportWidth = viewport.getBoundingClientRect().width;
    // No mounted row means no usable gutter; the hit strip must stay inert.
    onMeasure(viewportWidth, column?.getBoundingClientRect().width ?? viewportWidth);
  };
  const observer = new ResizeObserver(measure);
  observer.observe(viewport);
  const frame = requestAnimationFrame(measure);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

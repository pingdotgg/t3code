const PDF_PAGE_GAP = 16;
export const PDF_MIN_ZOOM = 0.25;
export const PDF_MAX_ZOOM = 3;
const PDF_ZOOM_STEP = 0.25;

export function pdfPageWidth(viewportWidth: number, pageWidth: number, zoom: number | null) {
  const fitWidth = Math.max(1, viewportWidth - 2 * PDF_PAGE_GAP);
  return {
    scale: zoom ?? fitWidth / pageWidth,
    width: zoom === null ? fitWidth : pageWidth * zoom,
  };
}

export function stepPdfZoom(scale: number, direction: 1 | -1) {
  return direction > 0
    ? Math.min(PDF_MAX_ZOOM, scale + PDF_ZOOM_STEP)
    : Math.max(PDF_MIN_ZOOM, scale - PDF_ZOOM_STEP);
}

/** Top offset of each page plus the end of the last one; ratios are height / width. */
export function pdfPageOffsets(ratios: readonly number[], width: number) {
  const result = [PDF_PAGE_GAP];
  for (const ratio of ratios)
    result.push(result[result.length - 1]! + width * ratio + PDF_PAGE_GAP);
  return result;
}

export function currentPdfPage(offsets: readonly number[], pageCount: number, scrollTop: number) {
  for (let index = 0; index < pageCount; index++)
    if (offsets[index + 1]! > scrollTop + PDF_PAGE_GAP + 1) return index;
  return 0;
}

/** Pages within one viewport above and two below the visible area stay mounted. */
export function visiblePdfPages(
  ratios: readonly number[],
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
) {
  return ratios.flatMap((ratio, index) =>
    offsets[index + 1]! >= scrollTop - viewportHeight &&
    offsets[index]! <= scrollTop + viewportHeight * 2
      ? [{ index, ratio }]
      : [],
  );
}

export function pdfPageScrollTop(offsets: readonly number[], index: number) {
  return Math.max(0, (offsets[index] ?? PDF_PAGE_GAP) - PDF_PAGE_GAP);
}

export function pdfPageText(
  items: readonly ({ str: string; hasEOL: boolean } | { type: string })[],
) {
  return items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
}

/** Which text runs hold part of a case-insensitive match, when pdf.js splits words across spans. */
export function pdfFindMatchRuns(runs: readonly string[], query: string) {
  const texts = runs.map((run) => run.toLowerCase());
  const text = texts.join("");
  const needle = query.toLowerCase();
  let match = needle.trim() ? text.indexOf(needle) : -1;
  let offset = 0;
  return texts.map((run) => {
    while (match !== -1 && match + needle.length <= offset)
      match = text.indexOf(needle, match + needle.length);
    const hit = match !== -1 && match < offset + run.length;
    offset += run.length;
    return hit;
  });
}

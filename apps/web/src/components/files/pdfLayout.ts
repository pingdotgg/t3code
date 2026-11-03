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

/**
 * Lowercased search text with each whitespace run, line ends included, read as one space, and a
 * hyphen that ends a line between letters dropped, as pdf.js's own find does. `owner` maps each
 * character back to the run it came from.
 */
function pdfFindText(runs: readonly string[]) {
  const chars = runs.flatMap((run, index) =>
    Array.from(run.toLowerCase(), (char) => ({ char, run: index })),
  );
  let text = "";
  let last = "";
  const owner: number[] = [];
  for (let index = 0; index < chars.length; index++) {
    const { char, run } = chars[index]!;
    if (/\s/.test(char)) {
      if (!text.endsWith(" ")) {
        text += " ";
        last = " ";
        owner.push(run);
      }
    } else if (
      char === "-" &&
      chars[index + 1]?.char === "\n" &&
      /\p{L}/u.test(last) &&
      /\p{L}/u.test(chars[index + 2]?.char ?? "")
    ) {
      index++;
    } else {
      text += char;
      last = char;
      for (let unit = 0; unit < char.length; unit++) owner.push(run);
    }
  }
  return { text, owner };
}

/** Whether a page's text holds the query, under the same rules as `pdfFindMatchRuns`, without
 * mapping characters back to runs: the page scan checks every page on each query. */
export function pdfFindIncludes(text: string, query: string) {
  const needle = query.toLowerCase().replace(/\s+/g, " ");
  if (!needle.trim()) return false;
  return text
    .toLowerCase()
    .replace(/(\p{L})-\n(?=\p{L})/gu, "$1")
    .replace(/\s+/g, " ")
    .includes(needle);
}

/** Which text runs hold part of a case-insensitive match, when pdf.js splits words across spans. */
export function pdfFindMatchRuns(runs: readonly string[], query: string) {
  const { text, owner } = pdfFindText(runs);
  const needle = query.toLowerCase().replace(/\s+/g, " ");
  const hits = runs.map(() => false);
  if (!needle.trim()) return hits;
  for (
    let match = text.indexOf(needle);
    match !== -1;
    match = text.indexOf(needle, match + needle.length)
  )
    for (let index = match; index < match + needle.length; index++) hits[owner[index]!] = true;
  return hits;
}

import { parseXcodeMarks, type XcodeMark } from "@t3tools/shared/xcodeMarks";

const XCODE_MARK_ATTRIBUTE = "data-xcode-mark";
const XCODE_MARK_SEPARATOR_ATTRIBUTE = "data-xcode-mark-separator";
const XCODE_MARK_KIND_ATTRIBUTE = "data-xcode-mark-kind";

/**
 * MARK chrome matched to an Xcode Default Dark screenshot:
 * separator rgb(62,63,68) on editor rgb(41,42,48) = 10% fg into bg, 1 CSS px,
 * full editor width; MARK glyphs rgb(163,177,191).
 */
export const XCODE_MARK_UNSAFE_CSS = `
  [${XCODE_MARK_SEPARATOR_ATTRIBUTE}]:is([data-line], [data-column-number]) {
    position: relative;
  }

  [${XCODE_MARK_SEPARATOR_ATTRIBUTE}]:is([data-line], [data-column-number])::before {
    content: "";
    position: absolute;
    inset-inline: 0;
    top: 0;
    height: 1px;
    background: color-mix(
      in srgb,
      var(--diffs-fg, var(--foreground)) 10%,
      var(--diffs-bg, var(--background))
    );
    pointer-events: none;
    z-index: 2;
  }

  /* Bridge Pierre's 2px gutter/content seam so the rule reads continuous. */
  [${XCODE_MARK_SEPARATOR_ATTRIBUTE}][data-column-number]::after {
    content: "";
    position: absolute;
    top: 0;
    right: -2px;
    width: 2px;
    height: 1px;
    background: color-mix(
      in srgb,
      var(--diffs-fg, var(--foreground)) 10%,
      var(--diffs-bg, var(--background))
    );
    pointer-events: none;
    z-index: 2;
  }

  /* Cool silver from Xcode MARK glyphs; 700 so SF Mono actually boldens. */
  [${XCODE_MARK_ATTRIBUTE}="mark"][data-line] span {
    color: light-dark(#5a6470, #a3b1bf) !important;
    font-weight: 700 !important;
    font-style: normal !important;
    font-synthesis: weight;
  }

  [${XCODE_MARK_ATTRIBUTE}="todo"][data-line] span {
    color: light-dark(#b45309, #e8b84a) !important;
    font-weight: 700 !important;
    font-style: normal !important;
    font-synthesis: weight;
  }

  [${XCODE_MARK_ATTRIBUTE}="fixme"][data-line] span {
    color: light-dark(#be123c, #f07178) !important;
    font-weight: 700 !important;
    font-style: normal !important;
    font-synthesis: weight;
  }
`;

export function collectXcodeMarks(source: string | null | undefined): XcodeMark[] {
  if (!source) return [];
  return parseXcodeMarks(source);
}

export function updateXcodeMarkDecorations(
  fileContainer: HTMLElement,
  marks: ReadonlyArray<XcodeMark>,
): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${XCODE_MARK_ATTRIBUTE}]`)) {
    element.removeAttribute(XCODE_MARK_ATTRIBUTE);
    element.removeAttribute(XCODE_MARK_SEPARATOR_ATTRIBUTE);
    element.removeAttribute(XCODE_MARK_KIND_ATTRIBUTE);
  }

  for (const mark of marks) {
    const line = root.querySelector<HTMLElement>(`[data-line="${mark.line}"]`);
    if (line) {
      line.setAttribute(XCODE_MARK_ATTRIBUTE, mark.kind);
      line.setAttribute(XCODE_MARK_KIND_ATTRIBUTE, mark.kind);
      if (mark.separator) line.setAttribute(XCODE_MARK_SEPARATOR_ATTRIBUTE, "");
    }
    if (!mark.separator) continue;
    const gutter = root.querySelector<HTMLElement>(`[data-column-number="${mark.line}"]`);
    if (!gutter) continue;
    gutter.setAttribute(XCODE_MARK_ATTRIBUTE, mark.kind);
    gutter.setAttribute(XCODE_MARK_KIND_ATTRIBUTE, mark.kind);
    gutter.setAttribute(XCODE_MARK_SEPARATOR_ATTRIBUTE, "");
  }
}

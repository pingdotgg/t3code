import {
  readAloudSourceAtShown,
  readAloudTapAtShown,
  type ReadAloudShownOptions,
} from "@t3tools/shared/read-aloud";
import type { RenderedTextChangeEvent, TextPressEvent } from "react-native-enriched-markdown";

/**
 * Where `text`, at `index` of one of the view's blocks, sits in the whole text the view shows.
 * Taps and selections report places in the block they are in, which is found first.
 */
function shownOffset(shown: RenderedTextChangeEvent, text: string, index: number) {
  const block = shown.blocks.find((entry) => shown.text.slice(entry.start, entry.end) === text);
  const start = block ? block.start : shown.text.indexOf(text);
  return start === -1 ? null : start + index;
}

/**
 * Where a tap on a reply reads from: the tapped word, or the block of a line whose tapped part
 * matches no word, such as a formula. Null when nothing on the line is read.
 */
export function readAloudTapSource(
  markdown: string,
  shown: RenderedTextChangeEvent,
  tap: TextPressEvent,
  options: ReadAloudShownOptions = {},
) {
  if (!tap.text) return null;
  const at = shownOffset(shown, tap.text, tap.index);
  return at === null ? null : readAloudTapAtShown(markdown, shown.text, at, options);
}

/** The markdown offset a selection reads from: the first word at or after its start, or null. */
export function readAloudSelectionSource(
  markdown: string,
  shown: RenderedTextChangeEvent,
  selection: { readonly text: string; readonly start: number },
  options: ReadAloudShownOptions = {},
) {
  if (!selection.text) return null;
  // The selection is reported within its block, so the block it is in is the one holding it there.
  const block = shown.blocks.find(
    (entry) =>
      shown.text.slice(entry.start + selection.start).startsWith(selection.text) &&
      entry.start + selection.start < entry.end,
  );
  const at = block ? block.start + selection.start : shown.text.indexOf(selection.text);
  return at === -1 ? null : readAloudSourceAtShown(markdown, shown.text, at, options);
}

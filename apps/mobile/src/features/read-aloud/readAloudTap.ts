import { readAloudSourceAtShown } from "@t3tools/shared/read-aloud";
import type { RenderedTextChangeEvent, TextPressEvent } from "react-native-enriched-markdown";

/**
 * The markdown offset a tap on a reply reads from, or null. A tap reports its place in the tapped
 * block's text, so that block is found in the whole text the view shows first.
 */
export function readAloudTapSource(
  markdown: string,
  shown: RenderedTextChangeEvent,
  tap: TextPressEvent,
) {
  if (!tap.text) return null;
  const block = shown.blocks.find((entry) => shown.text.slice(entry.start, entry.end) === tap.text);
  const start = block ? block.start : shown.text.indexOf(tap.text);
  return start === -1 ? null : readAloudSourceAtShown(markdown, shown.text, start + tap.index);
}

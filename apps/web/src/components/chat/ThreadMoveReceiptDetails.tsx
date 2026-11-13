import { Fragment } from "react";

import { splitInlineCode } from "./composerSend.logic";

/**
 * The lines of a move receipt under its heading, with each folder as its full path. Markdown
 * would show a path as a file chip with only its last segment, which hides where the thread was.
 */
export function ThreadMoveReceiptDetails({ text }: { readonly text: string }) {
  const lines: Array<{ readonly offset: number; readonly text: string }> = [];
  for (const line of text.split("\n")) {
    const previous = lines.at(-1);
    const offset = previous === undefined ? 0 : previous.offset + previous.text.length + 1;
    lines.push({ offset, text: line });
  }
  return lines.map((line) => (
    <p key={line.offset} className="text-sm leading-relaxed text-foreground/80">
      {splitInlineCode(line.text).map((part) =>
        part.code ? (
          <code key={part.offset} className="wrap-anywhere font-mono text-xs">
            {part.text}
          </code>
        ) : (
          <Fragment key={part.offset}>{part.text}</Fragment>
        ),
      )}
    </p>
  ));
}

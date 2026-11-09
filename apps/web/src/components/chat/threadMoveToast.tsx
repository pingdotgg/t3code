import { Fragment, type ReactNode } from "react";

import { splitInlineCode } from "./composerSend.logic";

/** A move toast's text, with each path as code at the start of its own line. */
export function threadMoveToastDescription(text: string): ReactNode {
  const parts = splitInlineCode(text);
  if (parts.every((part) => !part.code)) return text;
  return parts.map((part) =>
    part.code ? (
      <Fragment key={part.offset}>
        {part.offset > 0 ? <br /> : null}
        <code className="wrap-anywhere font-mono text-xs">{part.text}</code>
      </Fragment>
    ) : (
      <span key={part.offset}>{part.text}</span>
    ),
  );
}

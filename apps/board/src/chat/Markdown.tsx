import { memo } from "react";

import { MarkdownBlock } from "./MarkdownBlock";
import { splitMarkdownBlocks } from "./markdownBlocks";

/** Chat text as T3's web renders it. While it streams, the text is cut into blocks and only the last one redraws. */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  streaming = false,
  untrusted = false,
}: {
  text: string;
  streaming?: boolean;
  /** Set for text other people wrote, whose images must not load from the machine's own services. */
  untrusted?: boolean;
}) {
  const blocks = (streaming ? splitMarkdownBlocks(text) : null) ?? [text];
  return (
    <div className="chat-markdown min-w-0">
      {blocks.map((source, index) => (
        <MarkdownBlock
          // Streamed blocks only change at the end, so an index identifies one for its whole life.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          index={index}
          text={source}
          streaming={streaming && index === blocks.length - 1}
          untrusted={untrusted}
        />
      ))}
    </div>
  );
});

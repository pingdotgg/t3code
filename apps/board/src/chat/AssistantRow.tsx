import { useLayoutEffect } from "react";

import { ChatMarkdown } from "./Markdown";
import { MARK_TOKENS, markPainted } from "./tokenMarks";

/** The orchestrator's reply as T3 draws it: plain markdown on the panel, with no bubble. */
export function AssistantRow({ text, streaming }: { text: string; streaming: boolean }) {
  useLayoutEffect(() => {
    if (MARK_TOKENS && streaming) markPainted(text.length);
  }, [text, streaming]);
  return (
    <div className="min-w-0 break-words text-fg" data-streaming={streaming}>
      {text === "" ? <span className="text-faint">Thinking</span> : <ChatMarkdown text={text} />}
    </div>
  );
}

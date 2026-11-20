import { useLayoutEffect } from "react";

import { ChatMarkdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { MARK_TOKENS, markPainted } from "./tokenMarks";

/** The orchestrator's reply as T3 draws it: plain markdown on the panel, with no bubble, and its copy button and time beneath. */
export function AssistantRow({
  text,
  streaming,
  at,
  turnStartedAt,
}: {
  text: string;
  streaming: boolean;
  at: number | null;
  turnStartedAt: number | null;
}) {
  useLayoutEffect(() => {
    if (MARK_TOKENS && streaming) markPainted(text.length);
  }, [text, streaming]);
  return (
    <div className="group/message min-w-0 break-words text-fg" data-streaming={streaming}>
      {text === "" ? (
        <span className="text-faint">Thinking</span>
      ) : (
        <ChatMarkdown text={text} streaming={streaming} />
      )}
      <MessageActions text={text} at={at} runningSince={streaming ? turnStartedAt : null} />
    </div>
  );
}

import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useAssistantMessageText } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { markdownPreviewText } from "./pendingUserInputContext.logic";

const CLAMP_LINES = 3;
const LINE_HEIGHT_PX = 20;

const TEXT_CLASS = "text-sm leading-5 text-muted-foreground";

/**
 * What the agent wrote just before asking, from the same turn: muted, three lines, with an inline
 * "… Show more" that opens the whole message as markdown (all of it muted).
 */
export function ComposerPendingUserInputContext(props: {
  threadRef: ScopedThreadRef;
  messageId: string | undefined;
  cwd: string | undefined;
}) {
  const text = useAssistantMessageText(props.threadRef, props.messageId)?.trim() ?? "";
  if (text === "") return null;
  return <ContextText markdown={text} threadRef={props.threadRef} cwd={props.cwd} />;
}

function ContextText(props: {
  markdown: string;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const preview = markdownPreviewText(props.markdown);
  const meterRef = useRef<HTMLDivElement>(null);
  // undefined: not measured; null: it fits in three lines; a string: the text that fits with "… Show more".
  const [clamped, setClamped] = useState<string | null | undefined>(undefined);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the wrapped text in the DOM
  useLayoutEffect(() => {
    const meter = meterRef.current;
    if (!meter) return;
    const fits = (candidate: string, withMore: boolean) => {
      const more = document.createElement("span");
      more.textContent = gt("Show more");
      more.className = "font-medium";
      meter.replaceChildren(
        document.createTextNode(candidate),
        ...(withMore ? [document.createTextNode("… "), more] : []),
      );
      return meter.scrollHeight <= LINE_HEIGHT_PX * CLAMP_LINES + 1;
    };
    if (fits(preview, false)) {
      setClamped(null);
      return;
    }
    let low = 0;
    let high = preview.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(preview.slice(0, mid).trimEnd(), true)) low = mid;
      else high = mid - 1;
    }
    // End on a whole word with no dangling punctuation: "trade-off… Show more", never "off:…".
    const cut = preview.slice(0, low);
    const atWord = /\s/.test(preview.charAt(low)) ? cut : cut.replace(/\s+\S*$/, "");
    setClamped(atWord.trimEnd().replace(/[\s:;,.\-–—]+$/, ""));
  }, [gt, preview]);

  if (expanded || clamped === null) {
    return (
      <div className="relative">
        <ChatMarkdown
          text={props.markdown}
          cwd={props.cwd}
          threadRef={props.threadRef}
          lineBreaks
          className="**:text-muted-foreground"
        />
        {expanded && clamped !== null ? (
          <button
            type="button"
            className="mt-1 cursor-pointer text-sm leading-5 font-medium text-foreground outline-none hover:underline"
            onClick={() => setExpanded(false)}
          >
            {gt("Show less")}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="relative">
      <div
        ref={meterRef}
        aria-hidden
        className={`pointer-events-none invisible absolute inset-x-0 top-0 whitespace-pre-line [overflow-wrap:anywhere] ${TEXT_CLASS}`}
      />
      <div className={`whitespace-pre-line [overflow-wrap:anywhere] ${TEXT_CLASS}`}>
        {clamped ?? preview}
        {clamped !== undefined ? (
          <>
            {"… "}
            <button
              type="button"
              className="inline cursor-pointer font-medium text-foreground outline-none hover:underline"
              onClick={() => setExpanded(true)}
            >
              {gt("Show more")}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

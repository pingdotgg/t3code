import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  TERMINAL_PALETTES,
  terminalOutputSpans,
  type TerminalSpanStyle,
} from "@t3tools/shared/terminalOutput";
import { type CSSProperties, useLayoutEffect, useMemo, useRef } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

// Within this many pixels of the end still counts as following the output.
const FOLLOW_SLACK_PX = 8;

function spanCss(style: TerminalSpanStyle): CSSProperties {
  const decorations =
    style.underline && style.strike
      ? "underline line-through"
      : style.underline
        ? "underline"
        : style.strike
          ? "line-through"
          : undefined;
  return {
    ...(style.color === undefined ? {} : { color: style.color }),
    ...(style.backgroundColor === undefined ? {} : { backgroundColor: style.backgroundColor }),
    ...(style.bold ? { fontWeight: 600 } : {}),
    ...(style.dim ? { opacity: 0.65 } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(decorations === undefined ? {} : { textDecorationLine: decorations }),
  };
}

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Subscribes only while mounted, so collapsed rows and
 * other threads receive nothing.
 */
export function CommandOutputPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}) {
  const supported =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.commandOutputStreaming ===
    true;
  const { data } = useEnvironmentQuery(
    supported
      ? orchestrationEnvironment.v2.commandOutput({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, itemId: props.itemId },
        })
      : null,
  );
  const scrollRef = useRef<HTMLPreElement>(null);
  // Follow new output until the reader scrolls up; scrolling back down resumes.
  const followRef = useRef(true);
  const text = data?.output.text ?? "";
  const { resolvedTheme } = useTheme();
  const spans = useMemo(
    () => terminalOutputSpans(text, TERMINAL_PALETTES[resolvedTheme === "dark" ? "dark" : "light"]),
    [text, resolvedTheme],
  );

  // This panel only re-renders when its output changes, so keep the end in view after each.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  });

  if (text.length === 0) return null;
  return (
    <div data-command-output={data?.running ? "running" : "final"}>
      <p className="mb-1 text-3xs font-medium tracking-wide uppercase text-muted-foreground">
        Output
      </p>
      {data?.output.truncated ? (
        <p className="mb-1 text-3xs text-muted-foreground">Earlier output not shown</p>
      ) : null}
      <pre
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
        }}
        className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background/60 p-2 font-mono text-2xs leading-relaxed text-muted-foreground select-text"
      >
        {spans.map((span, index) =>
          span.style === null ? (
            span.text
          ) : (
            // Spans are rebuilt from scratch on every update and never reorder.
            // oxlint-disable-next-line react/no-array-index-key
            <span key={index} style={spanCss(span.style)}>
              {span.text}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}

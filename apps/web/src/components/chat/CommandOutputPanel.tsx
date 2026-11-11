import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@t3tools/shared/terminalOutput";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useInitialOutputReady, type TurnItemSource } from "./timelineRowContext";

const FOLLOW_SLACK_PX = 8;

export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Mount it only when `useCommandOutputStreaming` holds
 * or a `source` serves the output.
 * It subscribes only while mounted, so collapsed rows and other threads receive nothing.
 */
export function CommandOutputPanel(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly source?: TurnItemSource["commandOutput"] | undefined;
}) {
  const input = { threadId: props.threadId, itemId: props.itemId };
  return (
    <CommandOutputBody
      query={
        props.source
          ? props.source(input)
          : orchestrationEnvironment.v2.commandOutput({ environmentId: props.environmentId, input })
      }
      onInitialOutputReady={props.onInitialOutputReady}
    />
  );
}

/** Follows a command the agent left running; mount only while its details are open. */
export function BackgroundTaskOutputPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly compact?: boolean;
}) {
  // A task runs until it leaves the roster, so a quiet one says so rather than showing nothing.
  return (
    <CommandOutputBody
      query={orchestrationEnvironment.v2.backgroundTaskOutput({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, taskId: props.taskId },
      })}
      compact={props.compact}
      runningEmpty={<div className="text-muted-foreground italic">No output yet.</div>}
    />
  );
}

function CommandOutputBody(props: {
  readonly query: Parameters<typeof useEnvironmentQuery<CommandOutputView, unknown>>[0];
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly compact?: boolean | undefined;
  readonly runningEmpty?: ReactNode;
}) {
  const { data, error } = useEnvironmentQuery<CommandOutputView, unknown>(props.query);
  useInitialOutputReady(data === null && !error, props.onInitialOutputReady);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const text = data?.output.text ?? "";
  const { resolvedTheme } = useTheme();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pins the output scroller's scrollTop to the bottom after each commit while the user follows
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  });

  if (text.length === 0) {
    if (error) return <div className="text-destructive">Couldn&apos;t load output: {error}</div>;
    if (data === null) return <div className="text-muted-foreground italic">Loading output…</div>;
    return data.running ? (
      (props.runningEmpty ?? null)
    ) : (
      <div className="text-muted-foreground italic">No output.</div>
    );
  }
  // Parse after all hooks to preserve the text/theme compiler cache.
  const spans = terminalOutputSpans(text, TERMINAL_PALETTES[resolvedTheme]);
  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
      }}
      className={`${props.compact ? "max-h-48" : "max-h-80"} overflow-auto text-muted-foreground`}
    >
      {data?.output.truncated ? <div className="italic">Earlier output not shown</div> : null}
      {spans.map((span, index) =>
        span.style === null ? (
          span.text
        ) : (
          // Spans never reorder and are rebuilt on each update.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} style={span.style}>
            {span.text}
          </span>
        ),
      )}
    </div>
  );
}

import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import * as React from "react";

import type { PendingApproval } from "../approvals.ts";
import type { OrchestrationThread } from "../connection.ts";
import { clip } from "../format.ts";
import { ansi, relativeTime, sessionStatusColor, usePalette } from "../theme.ts";

// The conversation pane (mirrors apps/web/src/components/chat/MessagesTimeline.tsx).
// A sticky-to-bottom scrollbox of per-message streaming <markdown>, with a header
// (title + session status) and an inline approval panel.

function statusLabel(thread: { session: OrchestrationThread["session"] }): string {
  return thread.session?.status ?? "idle";
}

export const MessagesTimeline = React.memo(function MessagesTimeline({
  detail,
  approvals,
  projectHint,
  width,
  height,
  syntaxStyle,
  scrollRef,
}: {
  readonly detail: OrchestrationThread | null;
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly projectHint: string | null;
  readonly width: number;
  readonly height: number;
  readonly syntaxStyle: SyntaxStyle;
  readonly scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
}): React.ReactNode {
  const palette = usePalette();
  const headerHeight = 1;
  const approvalHeight = approvals.length > 0 ? approvals.length + 2 : 0;
  const bodyHeight = Math.max(1, height - headerHeight - approvalHeight - 2);

  if (!detail) {
    return (
      <box
        flexGrow={1}
        height={height}
        border
        borderStyle="rounded"
        borderColor={palette.dim}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={palette.dim}>
          {projectHint
            ? `${projectHint} — Enter to expand, then ↑/↓ to pick a thread.`
            : "Select a thread to view its conversation."}
        </text>
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      height={height}
      border
      borderStyle="rounded"
      borderColor={palette.dim}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" width="100%">
        <box flexGrow={1}>
          <text fg={palette.text}>
            <strong>{clip(detail.title, Math.max(8, width - 28))}</strong>
          </text>
        </box>
        <text>
          <span fg={approvals.length > 0 ? ansi("red") : ansi(sessionStatusColor(detail.session?.status))}>
            {approvals.length > 0 ? "pending approval" : statusLabel(detail)}
          </span>
          <span fg={palette.dim}>{`  ·  ${detail.runtimeMode}  ·  ${relativeTime(detail.updatedAt)}`}</span>
        </text>
      </box>

      <scrollbox
        ref={scrollRef}
        height={bodyHeight}
        stickyScroll
        stickyStart="bottom"
        style={{ rootOptions: { backgroundColor: "transparent" } }}
      >
        {detail.messages.map((message) => {
          const roleColor =
            message.role === "user"
              ? ansi("yellow")
              : message.role === "assistant"
                ? palette.accent
                : palette.dim;
          const who = message.role === "user" ? "you" : message.role;
          const body = message.text.trim().length > 0 ? message.text : "…";
          return (
            <box key={message.id} flexDirection="column" marginBottom={1}>
              <text>
                <span fg={roleColor}>{who}</span>
                {message.streaming ? <span fg={palette.dim}> ⟳</span> : null}
              </text>
              <markdown content={body} syntaxStyle={syntaxStyle} streaming={message.streaming} />
            </box>
          );
        })}
      </scrollbox>

      {approvals.length > 0 ? (
        <box flexDirection="column" border borderStyle="rounded" borderColor={ansi("red")} paddingLeft={1} paddingRight={1}>
          <text>
            <span fg={ansi("red")}>Approval required</span>
          </text>
          {approvals.map((approval) => (
            <text key={approval.requestId}>
              {`${approval.requestKind}${approval.detail ? `: ${approval.detail}` : ""}`}
            </text>
          ))}
          <text fg={palette.dim}>^A approve   ^R deny</text>
        </box>
      ) : null}
    </box>
  );
});

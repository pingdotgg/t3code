import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import type { OrchestrationCheckpointSummary } from "@t3tools/contracts";
import * as React from "react";

import type { PendingApproval } from "../approvals.ts";
import type { OrchestrationThread } from "../connection.ts";
import { clip } from "../format.ts";
import { type ActionableProposedPlan, latestActionableProposedPlan } from "../proposedPlan.ts";
import {
  buildTimeline,
  changedFilesByMessage,
  diffStat,
  isWorking,
  workingElapsedSeconds,
  workingStartedAt,
} from "../timeline.ts";
import { ansi, type Palette, relativeTime, sessionStatusColor, usePalette } from "../theme.ts";
import {
  workLogIcon,
  workLogLabel,
  workLogPreview,
  workLogStatusKind,
  type WorkLogEntry,
} from "../worklog.ts";

// The conversation pane (mirrors apps/web/src/components/chat/MessagesTimeline.tsx).
// A sticky-to-bottom scrollbox interleaving streaming <markdown> messages with the
// derived work log (tool calls / thinking), each message's changed-files summary,
// and a live "Working…" indicator while a turn runs.

function statusLabel(thread: { session: OrchestrationThread["session"] }): string {
  return thread.session?.status ?? "idle";
}

/** A compact tool-call / thinking row: icon · label · muted preview · status glyph. */
function ToolRow({
  entry,
  palette,
  width,
}: {
  readonly entry: WorkLogEntry;
  readonly palette: Palette;
  readonly width: number;
}): React.ReactNode {
  const icon = workLogIcon(entry);
  const label = workLogLabel(entry);
  const preview = workLogPreview(entry);
  const status = workLogStatusKind(entry);
  const iconColor = entry.tone === "error" ? ansi("red") : palette.accent;
  const statusGlyph =
    status === "success" ? "✓" : status === "failure" ? "✗" : status === "progress" ? "⟳" : null;
  const statusColor =
    status === "success" ? ansi("green") : status === "failure" ? ansi("red") : palette.dim;
  const previewRoom = Math.max(8, width - label.length - 8);
  return (
    <text>
      <span fg={iconColor}>{`${icon} `}</span>
      <span fg={palette.text}>{label}</span>
      {statusGlyph ? <span fg={statusColor}>{` ${statusGlyph}`}</span> : null}
      {preview ? <span fg={palette.dim}>{`  ${clip(preview, previewRoom)}`}</span> : null}
    </text>
  );
}

/** The per-message "changed files (N)  +A -D" summary, with each file's own +/-. */
function ChangedFiles({
  checkpoint,
  palette,
  width,
}: {
  readonly checkpoint: OrchestrationCheckpointSummary;
  readonly palette: Palette;
  readonly width: number;
}): React.ReactNode {
  const { additions, deletions } = diffStat(checkpoint.files);
  return (
    <box flexDirection="column" marginTop={1}>
      <text>
        <span fg={palette.dim}>{`changed files (${checkpoint.files.length})  `}</span>
        <span fg={ansi("green")}>{`+${additions}`}</span>
        <span fg={palette.dim}>{" "}</span>
        <span fg={ansi("red")}>{`-${deletions}`}</span>
      </text>
      {checkpoint.files.slice(0, 12).map((file) => (
        <text key={file.path}>
          <span fg={palette.text}>{`  ${clip(file.path, Math.max(8, width - 16))}`}</span>
          <span fg={ansi("green")}>{`  +${file.additions}`}</span>
          <span fg={ansi("red")}>{` -${file.deletions}`}</span>
        </text>
      ))}
      {checkpoint.files.length > 12 ? (
        <text fg={palette.dim}>{`  +${checkpoint.files.length - 12} more`}</text>
      ) : null}
    </box>
  );
}

/** The proposed-plan card shown after a plan-mode turn (mirrors ProposedPlanCard). */
function ProposedPlanCard({
  plan,
  palette,
  syntaxStyle,
}: {
  readonly plan: ActionableProposedPlan;
  readonly palette: Palette;
  readonly syntaxStyle: SyntaxStyle;
}): React.ReactNode {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={palette.accent}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
    >
      <text>
        <span fg={palette.accent}>{"◆ "}</span>
        <strong>{plan.title}</strong>
      </text>
      <markdown content={plan.body} syntaxStyle={syntaxStyle} />
      <text fg={palette.dim}>proposed plan · ^B to build mode, then reply to refine</text>
    </box>
  );
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

  const working = detail ? isWorking(detail) : false;
  const startedAt = detail ? workingStartedAt(detail) : null;
  // Tick once a second while a turn runs so the elapsed counter advances.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!working) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [working]);

  const timeline = React.useMemo(
    () => (detail ? buildTimeline(detail.messages, detail.activities) : []),
    [detail],
  );
  const checkpointByMessage = React.useMemo(
    () => (detail ? changedFilesByMessage(detail.checkpoints) : new Map()),
    [detail],
  );
  const proposedPlan = React.useMemo(
    () => (detail ? latestActionableProposedPlan(detail) : null),
    [detail],
  );

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

  const elapsed = working ? workingElapsedSeconds(startedAt, nowMs) : null;
  const workingLabel = elapsed !== null ? `Working… ${elapsed}s` : "Working…";

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
          <span fg={detail.interactionMode === "plan" ? palette.accent : palette.dim}>
            {`  ·  ${detail.interactionMode === "plan" ? "plan" : "build"}`}
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
        {timeline.map((row) => {
          if (row.kind === "tool") {
            return (
              <box key={row.id} marginBottom={1}>
                <ToolRow entry={row.entry} palette={palette} width={width} />
              </box>
            );
          }
          const message = row.message;
          const roleColor =
            message.role === "user"
              ? ansi("yellow")
              : message.role === "assistant"
                ? palette.accent
                : palette.dim;
          const who = message.role === "user" ? "you" : message.role;
          const body = message.text.trim().length > 0 ? message.text : "…";
          const checkpoint = checkpointByMessage.get(message.id);
          return (
            <box key={message.id} flexDirection="column" marginBottom={1}>
              <text>
                <span fg={roleColor}>{who}</span>
                {message.streaming ? <span fg={palette.dim}> ⟳</span> : null}
              </text>
              <markdown content={body} syntaxStyle={syntaxStyle} streaming={message.streaming} />
              {checkpoint ? (
                <ChangedFiles checkpoint={checkpoint} palette={palette} width={width} />
              ) : null}
            </box>
          );
        })}
        {proposedPlan ? (
          <ProposedPlanCard plan={proposedPlan} palette={palette} syntaxStyle={syntaxStyle} />
        ) : null}
        {working ? (
          <box marginBottom={1}>
            <text>
              <span fg={palette.accent}>{"⟳ "}</span>
              <span fg={palette.dim}>{workingLabel}</span>
            </text>
          </box>
        ) : null}
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

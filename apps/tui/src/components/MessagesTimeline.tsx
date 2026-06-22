import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import type { OrchestrationCheckpointSummary } from "@t3tools/contracts";
import * as React from "react";

import type { PendingApproval } from "../approvals.ts";
import type { OrchestrationThread } from "../connection.ts";
import {
  type ContextWindowSnapshot,
  deriveContextWindow,
  formatContextWindow,
} from "../contextWindow.ts";
import { buildFileTree, collectDirPaths, flattenFileTree } from "../fileTree.ts";
import { clip } from "../format.ts";
import { fileTypeColor, STATUS_ICONS, TOOL_ICONS } from "../icons.ts";
import { type ActionableProposedPlan, latestActionableProposedPlan } from "../proposedPlan.ts";
import { WorkingIndicator } from "./WorkingIndicator.tsx";
import {
  changedFilesByMessage,
  deriveTimelineEntries,
  diffStat,
  type FoldableRow,
  isWorking,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
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
    status === "success" || status === "failure" || status === "progress"
      ? STATUS_ICONS[status].glyph
      : null;
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

/**
 * A group of consecutive tool calls (mirrors the web's WorkGroupSection): only the
 * most recent MAX_VISIBLE_WORK_LOG_ENTRIES are shown, with a clickable
 * "+N previous tool calls" expander; clicking reveals the rest ("Show fewer tool
 * calls"). Each group keeps its own collapse state.
 */
function WorkGroupSection({
  groupedEntries,
  palette,
  width,
}: {
  readonly groupedEntries: ReadonlyArray<WorkLogEntry>;
  readonly palette: Palette;
  readonly width: number;
}): React.ReactNode {
  const [expanded, setExpanded] = React.useState(false);
  if (groupedEntries.length === 0) return null;
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !expanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  return (
    <box flexDirection="column" marginBottom={1}>
      {visibleEntries.map((entry) => (
        <ToolRow key={entry.id} entry={entry} palette={palette} width={width} />
      ))}
      {hasOverflow ? (
        <box onMouseDown={() => setExpanded((value) => !value)}>
          <text fg={palette.dim}>
            {expanded
              ? "  ⌃ Show fewer tool calls"
              : `  ⌄ +${hiddenCount} previous tool call${hiddenCount === 1 ? "" : "s"}`}
          </text>
        </box>
      ) : null}
    </box>
  );
}

/** Everything a foldable row needs to paint, threaded through from the timeline. */
interface RowRenderContext {
  readonly palette: Palette;
  readonly width: number;
  readonly syntaxStyle: SyntaxStyle;
  readonly mdClient: Record<string, never>;
  readonly checkpointByMessage: Map<string, OrchestrationCheckpointSummary>;
  readonly onOpenDiff?: (turnCount: number, filePath?: string) => void;
  /** Resolve a message image attachment to a URL (until OpenTUI renders images inline). */
  readonly getAttachmentUrl?: (attachmentId: string) => Promise<string | null>;
  /** Surface a resolved attachment URL (e.g. in the status line) when clicked. */
  readonly onOpenUrl?: (url: string) => void;
}

/**
 * An image attachment shown as a link until OpenTUI can render images inline.
 * Resolves the asset URL on mount; clicking surfaces the full URL (the terminal
 * linkifies it / the status line makes it copyable).
 */
function AttachmentLink({
  attachment,
  ctx,
}: {
  readonly attachment: { readonly id: string; readonly name: string; readonly sizeBytes: number };
  readonly ctx: RowRenderContext;
}): React.ReactNode {
  const { palette, width, getAttachmentUrl, onOpenUrl } = ctx;
  const [link, setLink] = React.useState<"pending" | "failed" | string>(
    getAttachmentUrl ? "pending" : "failed",
  );
  React.useEffect(() => {
    if (!getAttachmentUrl) return;
    let cancelled = false;
    void getAttachmentUrl(attachment.id).then((resolved) => {
      if (!cancelled) setLink(resolved ?? "failed");
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, getAttachmentUrl]);

  const url = link !== "pending" && link !== "failed" ? link : null;
  const sizeKb = Math.max(1, Math.round(attachment.sizeBytes / 1024));
  const label = `${TOOL_ICONS.imageView.glyph} ${attachment.name} · ${sizeKb} KB`;
  const tail = url ?? (link === "pending" ? "  (resolving link…)" : "  (link unavailable)");
  const click = url && onOpenUrl ? () => onOpenUrl(url) : undefined;
  return (
    <box {...(click ? { onMouseDown: click } : {})}>
      <text>
        <span fg={palette.accent}>{label}</span>
        <span fg={palette.dim}>{`  ${clip(tail, Math.max(8, width - label.length - 4))}`}</span>
      </text>
    </box>
  );
}

/**
 * Render one foldable row (a message or a work group). User text sits in an
 * accent-bordered rounded box on the right; the assistant (and any other role)
 * renders plain on the left — mirroring the web chat layout. The bubble needs a
 * DEFINITE width for <markdown> to render (it reports no intrinsic width), so it
 * is sized to its longest line + chrome, capped at ~72% of the pane.
 */
function FoldableRowView({
  row,
  ctx,
}: {
  readonly row: FoldableRow;
  readonly ctx: RowRenderContext;
}): React.ReactNode {
  const { palette, width, syntaxStyle, mdClient, checkpointByMessage, onOpenDiff } = ctx;
  if (row.kind === "work") {
    return <WorkGroupSection groupedEntries={row.groupedEntries} palette={palette} width={width} />;
  }
  const message = row.message;
  const body = message.text.trim().length > 0 ? message.text : "…";
  const checkpoint = checkpointByMessage.get(message.id);
  // Image attachments (until OpenTUI renders images inline) — shown as links.
  const images = (message.attachments ?? []).filter((a) => a.type === "image");
  const attachmentsNode =
    images.length > 0 ? (
      <box flexDirection="column" marginTop={1}>
        {images.map((attachment) => (
          <AttachmentLink key={attachment.id} attachment={attachment} ctx={ctx} />
        ))}
      </box>
    ) : null;
  if (message.role === "user") {
    const maxBubble = Math.max(16, Math.floor(width * 0.72));
    const longestLine = body.split("\n").reduce((max, line) => Math.max(max, line.length), 1);
    const bubbleWidth = Math.min(maxBubble, longestLine + 4);
    // Right-align by putting the bubble in a row whose width is the DEFINITE
    // scrollbox content width (= the `width` prop). Inside a scrollbox the
    // cross-size is auto, so "100%"/alignSelf/marginLeft:auto all collapse —
    // only a concrete width gives flex-end a reference to push against.
    return (
      <box flexDirection="column" marginTop={1} marginBottom={1}>
        <box flexDirection="row" width={width} justifyContent="flex-end">
          <box
            flexDirection="column"
            width={bubbleWidth}
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={palette.accent}
            paddingLeft={1}
            paddingRight={1}
          >
            <markdown
              content={body}
              syntaxStyle={syntaxStyle}
              streaming={message.streaming}
              {...mdClient}
            />
          </box>
        </box>
        {attachmentsNode}
      </box>
    );
  }
  return (
    <box flexDirection="column" marginTop={1} marginBottom={1}>
      <markdown content={body} syntaxStyle={syntaxStyle} streaming={message.streaming} {...mdClient} />
      {attachmentsNode}
      {checkpoint ? (
        <ChangedFilesTree
          checkpoint={checkpoint}
          palette={palette}
          width={width}
          {...(onOpenDiff ? { onOpenDiff } : {})}
        />
      ) : null}
    </box>
  );
}

/**
 * A settled turn's commentary + tool work, folded behind a clickable
 * "Worked for <duration>" row (mirrors the web turn fold). Clicking reveals the
 * hidden rows in place; the turn's final assistant message stays visible below.
 */
function TurnFoldSection({
  label,
  hiddenRows,
  ctx,
}: {
  readonly label: string;
  readonly hiddenRows: ReadonlyArray<FoldableRow>;
  readonly ctx: RowRenderContext;
}): React.ReactNode {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <box flexDirection="column" marginTop={1}>
      <box onMouseDown={() => setExpanded((value) => !value)}>
        <text fg={ctx.palette.dim}>{`${expanded ? "▾" : "▸"} ${label}`}</text>
      </box>
      {expanded
        ? hiddenRows.map((row) => <FoldableRowView key={row.id} row={row} ctx={ctx} />)
        : null}
    </box>
  );
}

const CHANGED_FILES_ROW_CAP = 40;

/**
 * The per-message changed-files summary, rendered as a collapsible directory tree
 * (mirrors the web ChangedFilesTree). The header opens the turn diff; "collapse
 * all / expand all" folds every directory; each directory row toggles on click.
 */
function ChangedFilesTree({
  checkpoint,
  palette,
  width,
  onOpenDiff,
}: {
  readonly checkpoint: OrchestrationCheckpointSummary;
  readonly palette: Palette;
  readonly width: number;
  /** Open the diff viewer scoped to this turn (clicking the header). */
  readonly onOpenDiff?: (turnCount: number, filePath?: string) => void;
}): React.ReactNode {
  const files = checkpoint.files;
  const tree = React.useMemo(() => buildFileTree(files), [files]);
  const allDirs = React.useMemo(() => collectDirPaths(tree), [tree]);
  const [collapsedDirs, setCollapsedDirs] = React.useState<ReadonlySet<string>>(() => new Set());
  const rows = React.useMemo(() => flattenFileTree(tree, collapsedDirs), [tree, collapsedDirs]);
  const { additions, deletions } = diffStat(files);
  const hasDirs = allDirs.length > 0;
  const allCollapsed = hasDirs && allDirs.every((path) => collapsedDirs.has(path));
  const nameRoom = Math.max(8, width - 20);

  const toggleDir = (path: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleAll = () => setCollapsedDirs(allCollapsed ? new Set() : new Set(allDirs));

  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box
          {...(onOpenDiff
            ? { onMouseDown: () => onOpenDiff(checkpoint.checkpointTurnCount) }
            : {})}
        >
          <text>
            <span fg={palette.dim}>{`changed files (${files.length})  `}</span>
            <span fg={ansi("green")}>{`+${additions}`}</span>
            <span fg={palette.dim}>{" "}</span>
            <span fg={ansi("red")}>{`-${deletions}`}</span>
            {onOpenDiff ? <span fg={palette.dim}>{"   ▸ diff"}</span> : null}
          </text>
        </box>
        {hasDirs ? (
          <box onMouseDown={toggleAll}>
            <text fg={palette.dim}>{allCollapsed ? "expand all" : "collapse all"}</text>
          </box>
        ) : null}
      </box>
      {rows.slice(0, CHANGED_FILES_ROW_CAP).map((row) => {
        const indent = "  ".repeat(row.depth + 1);
        if (row.kind === "dir") {
          return (
            <box key={`d:${row.path}`} onMouseDown={() => toggleDir(row.path)}>
              <text>
                <span fg={palette.dim}>{`${indent}${row.collapsed ? "▸" : "▾"} `}</span>
                <span fg={palette.text}>{clip(`${row.name}/`, nameRoom)}</span>
                <span fg={ansi("green")}>{`  +${row.additions}`}</span>
                <span fg={ansi("red")}>{` -${row.deletions}`}</span>
              </text>
            </box>
          );
        }
        // A file row: a type-coloured glyph + name, clickable to open the diff
        // scoped to just this file (the per-file "View diff").
        const typeColor = fileTypeColor(row.path);
        const openThisFile = onOpenDiff
          ? () => onOpenDiff(checkpoint.checkpointTurnCount, row.path)
          : undefined;
        return (
          <box key={`f:${row.path}`} {...(openThisFile ? { onMouseDown: openThisFile } : {})}>
            <text>
              <span fg={typeColor ? ansi(typeColor) : palette.dim}>{`${indent}◦ `}</span>
              <span fg={palette.text}>{clip(row.name, nameRoom)}</span>
              <span fg={ansi("green")}>{`  +${row.additions}`}</span>
              <span fg={ansi("red")}>{` -${row.deletions}`}</span>
            </text>
          </box>
        );
      })}
      {rows.length > CHANGED_FILES_ROW_CAP ? (
        <text fg={palette.dim}>{`  +${rows.length - CHANGED_FILES_ROW_CAP} more`}</text>
      ) : null}
    </box>
  );
}

/** A one-line context-window usage meter under the header. */
function ContextMeter({
  snapshot,
  palette,
}: {
  readonly snapshot: ContextWindowSnapshot;
  readonly palette: Palette;
}): React.ReactNode {
  const pct = snapshot.usedPercentage;
  const color = pct === null ? palette.dim : pct >= 90 ? ansi("red") : pct >= 70 ? ansi("yellow") : ansi("green");
  return (
    <text>
      <span fg={palette.dim}>{"context  "}</span>
      <span fg={color}>{formatContextWindow(snapshot)}</span>
    </text>
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
      <text fg={palette.dim}>proposed plan · ^Y implement · ^B build mode to refine</text>
    </box>
  );
}

export const MessagesTimeline = React.memo(function MessagesTimeline({
  detail,
  approvals,
  approvalIndex,
  projectHint,
  width,
  height,
  syntaxStyle,
  scrollRef,
  onOpenDiff,
  getAttachmentUrl,
  onOpenUrl,
  treeSitterClient,
}: {
  readonly detail: OrchestrationThread | null;
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly approvalIndex: number;
  readonly projectHint: string | null;
  readonly width: number;
  readonly height: number;
  readonly syntaxStyle: SyntaxStyle;
  readonly scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
  /** Open the diff viewer scoped to a turn (clicking its changed-files summary). */
  readonly onOpenDiff?: (turnCount: number, filePath?: string) => void;
  /** Resolve a message image attachment to a URL (shown as a link until inline images land). */
  readonly getAttachmentUrl?: (attachmentId: string) => Promise<string | null>;
  /** Surface a resolved attachment URL when clicked (e.g. in the status line). */
  readonly onOpenUrl?: (url: string) => void;
  /** Test seam: inject a tree-sitter client so <markdown> can paint in tests. */
  readonly treeSitterClient?: unknown;
}): React.ReactNode {
  const mdClient = treeSitterClient ? { treeSitterClient: treeSitterClient as never } : {};
  const palette = usePalette();
  const contextWindow = React.useMemo(
    () => (detail ? deriveContextWindow(detail.activities) : null),
    [detail],
  );
  const headerHeight = 1;
  const metaHeight = contextWindow ? 1 : 0;
  const approvalHeight = approvals.length > 0 ? approvals.length + 2 : 0;
  const bodyHeight = Math.max(1, height - headerHeight - metaHeight - approvalHeight - 2);

  const working = detail ? isWorking(detail) : false;
  const startedAt = detail ? workingStartedAt(detail) : null;

  const timeline = React.useMemo(
    () =>
      detail
        ? deriveTimelineEntries(detail.messages, detail.activities, detail.latestTurn)
        : [],
    [detail],
  );
  const checkpointByMessage = React.useMemo(
    () =>
      detail
        ? changedFilesByMessage(detail.checkpoints)
        : new Map<string, OrchestrationCheckpointSummary>(),
    [detail],
  );
  const proposedPlan = React.useMemo(
    () => (detail ? latestActionableProposedPlan(detail) : null),
    [detail],
  );

  const rowCtx: RowRenderContext = {
    palette,
    width,
    syntaxStyle,
    mdClient,
    checkpointByMessage,
    ...(onOpenDiff ? { onOpenDiff } : {}),
    ...(getAttachmentUrl ? { getAttachmentUrl } : {}),
    ...(onOpenUrl ? { onOpenUrl } : {}),
  };

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
          <span fg={detail.interactionMode === "plan" ? palette.accent : palette.dim}>
            {`  ·  ${detail.interactionMode === "plan" ? "plan" : "build"}`}
          </span>
          <span fg={palette.dim}>{`  ·  ${detail.runtimeMode}  ·  ${relativeTime(detail.updatedAt)}`}</span>
        </text>
      </box>

      {contextWindow ? <ContextMeter snapshot={contextWindow} palette={palette} /> : null}

      <scrollbox
        ref={scrollRef}
        height={bodyHeight}
        stickyScroll
        stickyStart="bottom"
        style={{ rootOptions: { backgroundColor: "transparent" } }}
      >
        {timeline.map((row) => {
          if (row.kind === "turn-fold") {
            return (
              <TurnFoldSection
                key={row.id}
                label={row.label}
                hiddenRows={row.hiddenRows}
                ctx={rowCtx}
              />
            );
          }
          return <FoldableRowView key={row.id} row={row} ctx={rowCtx} />;
        })}
        {proposedPlan ? (
          <ProposedPlanCard plan={proposedPlan} palette={palette} syntaxStyle={syntaxStyle} />
        ) : null}
        {working ? <WorkingIndicator startedAt={startedAt} /> : null}
      </scrollbox>

      {approvals.length > 0 ? (
        <box flexDirection="column" border borderStyle="rounded" borderColor={ansi("red")} paddingLeft={1} paddingRight={1}>
          <text>
            <span fg={ansi("red")}>Approval required</span>
            {approvals.length > 1 ? (
              <span fg={palette.dim}>{`  (${Math.min(approvalIndex, approvals.length - 1) + 1} of ${approvals.length})`}</span>
            ) : null}
          </text>
          {approvals.map((approval, index) => {
            const active = index === Math.min(approvalIndex, approvals.length - 1);
            return (
              <text key={approval.requestId}>
                <span fg={active ? palette.accent : palette.dim}>{active ? "▸ " : "  "}</span>
                <span fg={active ? palette.text : palette.dim}>
                  {`${approval.requestKind}${approval.detail ? `: ${approval.detail}` : ""}`}
                </span>
              </text>
            );
          })}
          <text fg={palette.dim}>
            {approvals.length > 1 ? "↑/↓ select · ^A approve · ^R deny" : "^A approve   ^R deny"}
          </text>
        </box>
      ) : null}
    </box>
  );
});

import {
  filePresentationApi,
  messagesEnrichmentApi,
  orchestrationControlApi,
  orchestrationStatusApi,
  uiKeybindingsApi,
  uiNotificationsApi,
  uiPanelsApi,
  uiThemeApi,
  vcsDiffApi,
  vcsRefsApi,
  vcsRepositoryApi,
  vcsStatusApi,
  type OrchestrationCapabilities,
  type OrchestrationReceipt,
  type VcsCapabilitiesResult,
  type VcsDiffFileContentsResult,
  type VcsDiffPreviewInput,
  type VcsDiffPreviewResult,
  type VcsListRefsResult,
} from "@t3tools/extension-sdk/catalogue";
import {
  defineExtension,
  requireApi,
  type AuthoredExtension,
} from "@t3tools/extension-sdk/authoring";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  bindDiffViewCommands,
  panelTheme,
  stageDiffCommands,
  watchThemeTokens,
  type ThemeTokens,
} from "./uiContracts.js";
import { COMMENT_QUOTE_MAX_CHARS } from "./diffComments.js";
import {
  useCommentBlockReason,
  useCommentTarget,
  useDiffCommentDraft,
  useLineSelection,
  usePostedComments,
  type CommentBuffer,
  type DiffCommentDraft,
  type PostedComment,
} from "./commentSession.js";

import {
  areAllDiffFilesCollapsed,
  buildBaseRefChoices,
  canExpandFile,
  changeTypeLabel,
  CONNECTING_DIFF_STATUS,
  contentsDeliveryKey,
  checkpointRevertInput,
  describePresentation,
  describeRevertReceipt,
  describeSource,
  diffCapabilityState,
  diffTreeRows,
  displayPath,
  fetchDiffPreview,
  fetchFileContents,
  fetchTurnDiff,
  fileContentsInput,
  fileRows,
  fileStatLabel,
  filterBaseRefChoices,
  foldAgentsEvent,
  foldDiffStatusEvent,
  commentSectionFor,
  expansionMatchesPatch,
  orchestrationCapabilityState,
  presentationPath,
  previewDeliveryKey,
  previewState,
  reconcileTurnSelection,
  renderableFromPatch,
  restoreDiffState,
  retainFileSelection,
  revertTarget,
  selectSource,
  splitRows,
  toggleAllDiffFiles,
  toggleCollapsedKey,
  turnChoices,
  CONNECTING_AGENTS,
  type AgentsModel,
  type DiffFileRow,
  type DiffLayout,
  type DiffMode,
  type DiffSplitRow,
  type DiffStatusRefresh,
  type RestoredState,
  type SplitSide,
  type TurnChoice,
  type TurnSelection,
} from "./viewModel.js";

const manifestId = "t3.diff";

/**
 * Parses are pure functions of the delivered diff text, keyed on the
 * source's content hash so re-renders never re-parse unchanged payloads.
 * Module-scoped (not per-view) and bounded — sources are ≤8 per preview.
 */
const patchParseCache = new Map<string, ReturnType<typeof renderableFromPatch>>();

function renderableFor(diffHash: string, diff: string) {
  const cached = patchParseCache.get(diffHash);
  if (cached !== undefined) return cached;
  const value = renderableFromPatch(diff);
  if (patchParseCache.size >= 16) patchParseCache.clear();
  patchParseCache.set(diffHash, value);
  return value;
}

/** One-shot capability read; the repository gate decides what the panel may show. */
function useCapabilities(host: ClientHost, session: ViewSession, visible: boolean, tick: number) {
  const [result, setResult] = useState<{
    key: number;
    capabilities: VcsCapabilitiesResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(vcsRepositoryApi, host, session.context)
      .invoke("getCapabilities", {}, signal)
      .then(
        (capabilities) => {
          if (!signal.aborted) setResult({ key: tick, capabilities, error: null });
        },
        (error) => {
          if (!signal.aborted)
            setResult({
              key: tick,
              capabilities: null,
              error: error instanceof Error ? error.message : "Capabilities unavailable",
            });
        },
      );
    return () => controller.abort();
  }, [host, session, visible, tick]);
  return result?.key === tick ? result : { capabilities: null, error: null };
}

/**
 * The `t3.vcs/status` stream is the only freshness signal — the panel
 * never polls. `closed` frames resubscribe with the same bounded retry
 * the version-control panel uses; errors and unexpected ends surface an
 * honest ended state while manual Refresh keeps working.
 */
function useStatusRefresh(host: ClientHost, session: ViewSession, enabled: boolean) {
  const [model, setModel] = useState<DiffStatusRefresh>(CONNECTING_DIFF_STATUS);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      let status: DiffStatusRefresh = CONNECTING_DIFF_STATUS;
      setModel(status);
      for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt += 1) {
        let closed = false;
        try {
          const stream = bindStreamApi(vcsStatusApi, host, session.context).subscribe(
            "subscribe",
            {},
            signal,
          );
          for await (const frame of stream) {
            if (signal.aborted) return;
            status = foldDiffStatusEvent(status, frame.value);
            setModel(status);
            if (frame.value.kind === "closed") {
              closed = true;
              break;
            }
          }
        } catch (error) {
          if (!signal.aborted)
            setModel({
              ...status,
              stream: "ended",
              detail: error instanceof Error ? error.message : "Status stream unavailable",
            });
          return;
        }
        if (signal.aborted) return;
        if (!closed) {
          setModel({
            ...status,
            stream: "ended",
            detail: "Status stream ended unexpectedly.",
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
      if (!signal.aborted)
        setModel({ ...status, stream: "ended", detail: "Status stream ended repeatedly." });
    })();
    return () => controller.abort();
  }, [host, session, enabled]);
  return model;
}

/**
 * Refs for the base-ref picker via `t3.vcs/refs.list` — local and remote
 * lanes read separately exactly like the native panel, re-read on the
 * same local-status revision so a branch operation refreshes choices.
 */
function useRefs(host: ClientHost, session: ViewSession, enabled: boolean, revision: number) {
  const [result, setResult] = useState<{
    key: number;
    refs: VcsListRefsResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(vcsRefsApi, host, session.context);
    void Promise.all([
      api.invoke("list", { refKind: "local", limit: 200 }, signal),
      api.invoke("list", { refKind: "remote", limit: 200 }, signal),
    ]).then(
      ([local, remote]) => {
        if (!signal.aborted)
          setResult({
            key: revision,
            refs: {
              refs: [...local.refs, ...remote.refs],
              isRepo: local.isRepo,
              hasPrimaryRemote: local.hasPrimaryRemote,
              nextCursor: null,
              totalCount: local.totalCount + remote.totalCount,
            },
            error: null,
          });
      },
      (error) => {
        if (!signal.aborted)
          setResult((prev) => ({
            key: revision,
            refs: prev?.refs ?? null,
            error: error instanceof Error ? error.message : "Refs unavailable",
          }));
      },
    );
    return () => controller.abort();
  }, [host, session, enabled, revision]);
  return result?.key === revision ? result : { refs: null, error: null };
}

/**
 * Preview fetch: unary `getPreview` first (the cheap common case), the
 * named-envelope rejection falls back to `streamPreview` with
 * reassembly + sha256 verification before render. The last-good preview
 * stays displayed across refreshes — a refresh failure is a note, never
 * a blank panel.
 */
function useDiffPreview(
  host: ClientHost,
  session: ViewSession,
  enabled: boolean,
  requestKey: string,
  input: VcsDiffPreviewInput,
) {
  const [result, setResult] = useState<{
    key: string;
    preview: VcsDiffPreviewResult | null;
    error: string | null;
    pending: boolean;
  } | null>(null);
  const streamKeys = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(vcsDiffApi, host, session.context);
    const streams = bindStreamApi(vcsDiffApi, host, session.context);
    void fetchDiffPreview({
      input,
      invoke: (next) => api.invoke("getPreview", next, signal),
      stream: (next) => streams.subscribe("streamPreview", next, signal),
      streamKeys: streamKeys.current,
      signal,
    }).then((outcome) => {
      if (signal.aborted || outcome.kind === "cancelled") return;
      setResult((prev) =>
        outcome.kind === "ready"
          ? { key: requestKey, preview: outcome.result, error: null, pending: false }
          : {
              key: requestKey,
              preview: prev?.preview ?? null,
              error: outcome.detail,
              pending: false,
            },
      );
    });
    return () => controller.abort();
    // requestKey folds tick + status revision + input identity.
  }, [host, session, enabled, requestKey, input]);
  return {
    // Last-good preview stays up across refreshes and key changes.
    preview: result?.preview ?? null,
    error: result?.key === requestKey ? result.error : null,
    pending: result?.key !== requestKey || result.pending,
  };
}

/**
 * Orchestration capabilities — the authority for which turn-mode
 * operations exist on this thread. A missing `t3.orchestration/read`
 * grant surfaces here as the named invocation error, and a missing
 * `t3.orchestration/operate` grant surfaces at the control invoke.
 */
function useOrchestrationCapabilities(
  host: ClientHost,
  session: ViewSession,
  enabled: boolean,
  tick: number,
) {
  const [result, setResult] = useState<{
    key: number;
    capabilities: OrchestrationCapabilities | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(orchestrationStatusApi, host, session.context)
      .invoke("getCapabilities", {}, signal)
      .then(
        (capabilities) => {
          if (!signal.aborted) setResult({ key: tick, capabilities, error: null });
        },
        (error) => {
          if (!signal.aborted)
            setResult({
              key: tick,
              capabilities: null,
              error:
                error instanceof Error ? error.message : "Orchestration capabilities unavailable",
            });
        },
      );
    return () => controller.abort();
  }, [host, session, enabled, tick]);
  return result?.key === tick ? result : { capabilities: null, error: null };
}

/**
 * `subscribeAgents` while turn mode is open — the checkpoint list drives
 * the turn picker and the revision drives turn-diff refetches after a
 * revert. Same bounded-resubscribe discipline as the status stream.
 */
function useAgentsStatus(host: ClientHost, session: ViewSession, enabled: boolean) {
  const [model, setModel] = useState<AgentsModel>(CONNECTING_AGENTS);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      let status: AgentsModel = CONNECTING_AGENTS;
      setModel(status);
      for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt += 1) {
        let closed = false;
        try {
          const stream = bindStreamApi(orchestrationStatusApi, host, session.context).subscribe(
            "subscribeAgents",
            {},
            signal,
          );
          for await (const frame of stream) {
            if (signal.aborted) return;
            status = foldAgentsEvent(status, frame.value);
            setModel(status);
            if (frame.value.kind === "closed") {
              closed = true;
              break;
            }
          }
        } catch (error) {
          if (!signal.aborted)
            setModel({
              ...status,
              stream: "ended",
              detail: error instanceof Error ? error.message : "Orchestration stream unavailable",
            });
          return;
        }
        if (signal.aborted) return;
        if (!closed) {
          setModel({
            ...status,
            stream: "ended",
            detail: "Orchestration stream ended unexpectedly.",
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
      if (!signal.aborted)
        setModel({ ...status, stream: "ended", detail: "Orchestration stream ended repeatedly." });
    })();
    return () => controller.abort();
  }, [host, session, enabled]);
  return model;
}

/**
 * Turn-mode diff fetch: `getTurnDiff`/`getThreadDiff` are finite verified
 * streams (no unary variant), so this subscribes once per requestKey and
 * hands the iterable straight to the shared collector.
 */
function useTurnDiff(
  host: ClientHost,
  session: ViewSession,
  enabled: boolean,
  requestKey: string,
  selection: TurnSelection | null,
) {
  const [result, setResult] = useState<{
    key: string;
    /** Which picker selection produced `preview`; mismatches never render. */
    selection: string;
    preview: VcsDiffPreviewResult | null;
    error: string | null;
  } | null>(null);
  const selectionKey =
    selection === null ? null : selection.kind === "thread" ? "thread" : `turn:${selection.turnId}`;
  const selectionTurnId = selection?.kind === "turn" ? selection.turnId : null;
  useEffect(() => {
    if (!enabled || selectionKey === null) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const streams = bindStreamApi(orchestrationStatusApi, host, session.context);
    const stream =
      selectionTurnId === null
        ? streams.subscribe("getThreadDiff", {}, signal)
        : streams.subscribe("getTurnDiff", { turnId: selectionTurnId }, signal);
    void fetchTurnDiff(stream, signal).then((outcome) => {
      if (signal.aborted || outcome.kind === "cancelled") return;
      setResult((prev) =>
        outcome.kind === "ready"
          ? { key: requestKey, selection: selectionKey, preview: outcome.result, error: null }
          : {
              key: requestKey,
              selection: selectionKey,
              // Last-good data is kept only within the same selection — a
              // reverted checkpoint's patch must never stand in for a
              // survivor's diff.
              preview: prev?.selection === selectionKey ? prev.preview : null,
              error: outcome.detail,
            },
      );
    });
    return () => controller.abort();
    // selectionKey folds turnId/thread identity into requestKey's deps.
  }, [host, session, enabled, requestKey, selectionKey, selectionTurnId]);
  const retained = selectionKey !== null && result?.selection === selectionKey ? result : null;
  return {
    preview: retained?.preview ?? null,
    error: result?.key === requestKey ? result.error : null,
    pending: enabled && selectionKey !== null && result?.key !== requestKey,
  };
}

/** Per-file expansion state; keyed `sourceHash:fileKey` so stale entries can never paint. */
type Expansion =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly detail: string }
  | { readonly status: "loaded"; readonly contents: VcsDiffFileContentsResult };

type PanelTheme = ReturnType<typeof panelTheme>;

/**
 * `t3.ui/theme` over the seam: `getTokens` resolves the effective values
 * (stored preference, session overlay, external preview) and `subscribeState`
 * events re-resolve on change. `null` means the contract is unavailable —
 * every themed value then keeps its static fallback.
 */
function useThemeTokens(host: ClientHost, session: ViewSession, enabled: boolean) {
  const [tokens, setTokens] = useState<ThemeTokens | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    watchThemeTokens(
      host,
      session.context,
      AbortSignal.any([controller.signal, session.signal]),
      setTokens,
    );
    return () => controller.abort();
  }, [host, session, enabled]);
  return tokens;
}

/** The per-row slice of comment state: the row's selection membership + the shared handler. */
interface RowCommentUi {
  readonly selected: boolean;
  /** True while the transport probe blocks the action (its reason rides the toolbar). */
  readonly disabled: boolean;
  readonly reason: string | null;
  readonly onSelect: (extend: boolean) => void;
}

/** The quiet per-row comment affordance; static styles so nothing repaints on hover. */
function commentAffordance(ui: PanelTheme, comment: RowCommentUi, label: string) {
  return (
    <button
      type="button"
      // The blocking reason rides the accessible name — the host Tooltip is
      // not bundleable into an extension, and the toolbar names it visually.
      aria-label={comment.reason !== null ? `${label} — unavailable: ${comment.reason}` : label}
      disabled={comment.disabled}
      onClick={(event) => comment.onSelect(event.shiftKey)}
      style={{
        flexShrink: 0,
        marginLeft: "auto",
        padding: "0 4px",
        border: "none",
        background: "transparent",
        color: ui.muted,
        cursor: comment.disabled ? "default" : "pointer",
        font: "inherit",
        fontSize: 11,
        lineHeight: "18px",
        opacity: 0.7,
      }}
    >
      +
    </button>
  );
}

function DiffRow({
  row,
  wrap,
  ui,
  comment,
}: {
  row: ReturnType<typeof fileRows>[number];
  wrap: boolean;
  ui: PanelTheme;
  comment: RowCommentUi | undefined;
}) {
  if (row.kind === "gap") {
    return (
      <div
        style={{
          ...ui.rowBase,
          justifyContent: "center",
          color: ui.muted,
          background: ui.mutedSurface,
          fontStyle: "italic",
        }}
      >
        {row.count} unmodified line{row.count === 1 ? "" : "s"}
      </div>
    );
  }
  const addition = row.kind === "addition";
  const deletion = row.kind === "deletion";
  const line = addition || row.kind === "context" ? row.newLine : row.oldLine;
  return (
    <div
      style={{
        ...ui.rowBase,
        whiteSpace: wrap ? "pre-wrap" : "pre",
        wordBreak: wrap ? "break-all" : undefined,
        background: addition
          ? // No theme role covers success green; --success is a static host variable.
            "color-mix(in srgb, var(--success, #2da44e) 14%, transparent)"
          : deletion
            ? `color-mix(in srgb, ${ui.destructive} 12%, transparent)`
            : "transparent",
        ...(comment?.selected
          ? { outline: `1px solid ${ui.accentOutline}`, outlineOffset: -1 }
          : {}),
      }}
    >
      <span style={ui.gutter}>{deletion || row.kind === "context" ? (row.oldLine ?? "") : ""}</span>
      <span style={ui.gutter}>{addition || row.kind === "context" ? (row.newLine ?? "") : ""}</span>
      <span style={{ color: ui.muted, userSelect: "none", width: 14 }}>
        {addition ? "+" : deletion ? "−" : " "}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.text}</span>
      {comment !== undefined &&
        commentAffordance(ui, comment, `Select line ${line ?? ""} for a comment`)}
    </div>
  );
}

function SplitCell({
  cell,
  wrap,
  separator,
  ui,
  comment,
}: {
  cell: SplitSide;
  wrap: boolean;
  separator: boolean;
  ui: PanelTheme;
  comment: RowCommentUi | undefined;
}) {
  const addition = cell.kind === "addition";
  const deletion = cell.kind === "deletion";
  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        whiteSpace: wrap ? "pre-wrap" : "pre",
        wordBreak: wrap ? "break-all" : undefined,
        ...(separator ? { borderRight: `1px solid ${ui.border}` } : {}),
        background: addition
          ? // Same success-green mix as unified additions; no theme role covers it.
            "color-mix(in srgb, var(--success, #2da44e) 14%, transparent)"
          : deletion
            ? `color-mix(in srgb, ${ui.destructive} 12%, transparent)`
            : "transparent",
      }}
    >
      <span style={ui.gutter}>{cell.kind === "empty" ? "" : cell.line}</span>
      <span style={{ color: ui.muted, userSelect: "none", width: 14 }}>
        {addition ? "+" : deletion ? "−" : " "}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {cell.kind === "empty" ? "" : cell.text}
      </span>
      {cell.kind !== "empty" &&
        comment !== undefined &&
        commentAffordance(ui, comment, `Select line ${cell.line} for a comment`)}
    </div>
  );
}

/**
 * A split row is one grid row, so paired old/new cells can never drift out of
 * vertical alignment, and the file keeps its single scroll container — the
 * panes cannot horizontally desync because neither pane scrolls on its own.
 * Each pane carries its own comment affordance: a paired row's addition is
 * selectable, not just the deletion it replaced.
 */
function SplitRow({
  row,
  wrap,
  ui,
  comment,
}: {
  row: DiffSplitRow;
  wrap: boolean;
  ui: PanelTheme;
  comment:
    | { readonly old: RowCommentUi | undefined; readonly new: RowCommentUi | undefined }
    | undefined;
}) {
  if (row.kind === "gap") {
    return (
      <div
        style={{
          ...ui.rowBase,
          justifyContent: "center",
          color: ui.muted,
          background: ui.mutedSurface,
          fontStyle: "italic",
        }}
      >
        {row.count} unmodified line{row.count === 1 ? "" : "s"}
      </div>
    );
  }
  return (
    <div
      style={{
        ...ui.rowBase,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        ...(comment !== undefined &&
        (comment.old?.selected === true || comment.new?.selected === true)
          ? { outline: `1px solid ${ui.accentOutline}`, outlineOffset: -1 }
          : {}),
      }}
    >
      <SplitCell cell={row.old} wrap={wrap} separator ui={ui} comment={comment?.old} />
      <SplitCell cell={row.new} wrap={wrap} separator={false} ui={ui} comment={comment?.new} />
    </div>
  );
}

/**
 * The per-file slice of comment state a file section renders. The parent
 * owns the state (pins, submit, posted list); the section derives the
 * selection's built target from its own rows.
 */
interface FileCommentUi {
  /** Why the action cannot run (probe, transport, thread scope); null = available. */
  readonly reason: string | null;
  /** The live selection's ordinals into this file's rows; null when it is another file's. */
  readonly anchor: number | null;
  readonly extent: number | null;
  readonly onRowSelect: (ordinal: number, extend: boolean) => void;
  readonly onClearSelection: () => void;
  readonly draft: DiffCommentDraft | null;
  readonly draftStale: boolean;
  readonly onOpenDraft: (draft: DiffCommentDraft) => void;
  readonly onCloseDraft: () => void;
  readonly body: string;
  readonly onBodyChange: (value: string) => void;
  readonly submit: { readonly busy: boolean; readonly error: string | null };
  readonly onSubmit: () => void;
  readonly posted: readonly PostedComment[];
  readonly removing: string | null;
  readonly removeError: string | null;
  readonly onRemove: (annotationId: string) => void;
}

function FileSection({
  row,
  selected,
  collapsed,
  layout,
  wrap,
  expansion,
  expandable,
  action,
  comment,
  onToggleCollapsed,
  onExpand,
  onOpen,
  onCopy,
  registerSection,
  ui,
}: {
  row: DiffFileRow;
  selected: boolean;
  collapsed: boolean;
  layout: DiffLayout;
  wrap: boolean;
  expansion: Expansion | undefined;
  expandable: boolean;
  action: { key: string; status: string; detail: string } | null;
  comment: FileCommentUi | null;
  onToggleCollapsed: (key: string) => void;
  onExpand: (row: DiffFileRow) => void;
  onOpen: (row: DiffFileRow) => void;
  onCopy: (row: DiffFileRow) => void;
  registerSection: (el: HTMLElement | null) => void;
  ui: PanelTheme;
}) {
  const muted = ui.muted;
  const expanded = expansion?.status === "loaded" ? expansion.contents : undefined;
  const rows = useMemo(
    () => (collapsed || row.binary || row.textless ? [] : fileRows(row, expanded)),
    [collapsed, row, expanded],
  );
  // Pairing is pure and row-count-bounded; memoized so unrelated renders don't re-pair.
  const paired = useMemo(() => (layout === "split" ? splitRows(rows) : null), [layout, rows]);
  // Row 14/D9: the selection's comment target — memoized so theme ticks and
  // wrap flips never re-enumerate the file's review rows.
  const target = useCommentTarget(row.file, rows, comment?.anchor ?? null, comment?.extent ?? null);
  const inSelection = (ordinal: number): boolean =>
    comment !== null &&
    comment.anchor !== null &&
    comment.extent !== null &&
    ordinal >= Math.min(comment.anchor, comment.extent) &&
    ordinal <= Math.max(comment.anchor, comment.extent);
  return (
    <section
      ref={registerSection}
      aria-label={displayPath(row)}
      style={{
        borderBottom: `1px solid ${ui.border}`,
        outline: selected ? `1px solid ${ui.accentOutline}` : undefined,
        outlineOffset: -1,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          fontSize: 12,
          position: "sticky",
          top: 0,
          background: ui.background,
          zIndex: 1,
        }}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${displayPath(row)}`}
          onClick={() => onToggleCollapsed(row.key)}
          style={{ ...ui.iconButton, width: 20, textAlign: "center" }}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {displayPath(row)}
          <span style={{ color: muted }}>
            {" "}
            — {row.binary ? "binary" : changeTypeLabel(row.changeType)}
            {fileStatLabel(row) !== "" ? ` ${fileStatLabel(row)}` : ""}
          </span>
        </span>
        {expandable && canExpandFile(row) && !collapsed && (
          <button
            type="button"
            style={ui.iconButton}
            disabled={expansion?.status === "loading"}
            onClick={() => onExpand(row)}
          >
            {expansion?.status === "loaded" ? "Context loaded" : "Full context"}
          </button>
        )}
        <button type="button" style={ui.iconButton} onClick={() => onOpen(row)}>
          Open
        </button>
        <button type="button" style={ui.iconButton} onClick={() => onCopy(row)}>
          Copy path
        </button>
      </header>
      {action !== null && action.key === row.key && (
        <p
          role={action.status === "error" ? "alert" : "note"}
          style={{ margin: 0, padding: "2px 10px", color: muted, fontSize: 11 }}
        >
          {action.detail}
        </p>
      )}
      {comment !== null && comment.draft !== null && (
        <div
          role="group"
          aria-label={`Comment on ${comment.draft.target.rangeLabel}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "6px 10px",
            borderBottom: `1px solid ${ui.border}`,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11, color: muted }}>
            Comment on {comment.draft.target.rangeLabel}
            {comment.draft.target.truncated
              ? ` — quote truncated to ${COMMENT_QUOTE_MAX_CHARS} characters`
              : ""}
          </span>
          {comment.draftStale && (
            <span role="status" style={{ fontSize: 11, color: muted }}>
              The diff changed since this draft opened — select the lines again to comment on them.
            </span>
          )}
          <textarea
            aria-label="Comment text"
            value={comment.body}
            // The in-flight submit captured this body; edits during the
            // await would be silently wiped by its success path, so the
            // field locks while busy (Cancel and Submit already do).
            readOnly={comment.submit.busy}
            onChange={(event) => comment.onBodyChange(event.target.value)}
            onKeyDown={(event) => {
              // Escape never cancels a pending submit — the in-flight
              // response belongs to this form, not whatever would open next.
              if (event.key === "Escape" && !comment.submit.busy) comment.onCloseDraft();
            }}
            rows={3}
            style={{
              resize: "vertical",
              border: `1px solid ${ui.border}`,
              padding: 6,
              color: "inherit",
              background: "transparent",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          />
          {comment.submit.error !== null && (
            <span role="alert" style={{ fontSize: 11, color: ui.destructive }}>
              {comment.submit.error}
            </span>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              style={ui.iconButton}
              disabled={comment.draftStale || comment.body.trim() === "" || comment.submit.busy}
              onClick={comment.onSubmit}
            >
              {comment.submit.busy ? "Submitting…" : "Submit comment"}
            </button>
            <button
              type="button"
              style={ui.iconButton}
              disabled={comment.submit.busy}
              onClick={comment.onCloseDraft}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {!collapsed && comment !== null && comment.draft === null && comment.anchor !== null && (
        <div
          role="toolbar"
          aria-label="Diff comment"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "4px 10px",
            borderBottom: `1px solid ${ui.border}`,
            flexShrink: 0,
            fontSize: 11,
          }}
        >
          {comment.reason === null && target !== null ? (
            <button
              type="button"
              style={ui.iconButton}
              onClick={() => comment.onOpenDraft({ fileKey: row.key, filePath: row.path, target })}
            >
              Comment on {target.rangeLabel}
            </button>
          ) : (
            <span style={{ color: muted }}>
              Commenting unavailable — {comment.reason ?? "this selection has no anchorable line."}
            </span>
          )}
          <button type="button" style={ui.iconButton} onClick={comment.onClearSelection}>
            Clear selection
          </button>
        </div>
      )}
      {!collapsed && row.binary && (
        <p role="note" style={{ padding: "4px 10px", color: muted, fontSize: 12, margin: 0 }}>
          {row.path} is a binary file — no text diff is available.
        </p>
      )}
      {!collapsed && row.textless && (
        <p role="note" style={{ padding: "4px 10px", color: muted, fontSize: 12, margin: 0 }}>
          No textual changes in the patch for {displayPath(row)}.
        </p>
      )}
      {!collapsed &&
        (layout === "split"
          ? paired?.map((line) => {
              // Each pane anchors its own side's unified row: the addition is
              // selectable, not just the deletion it replaced.
              const cellUi = (ordinal: number | undefined): RowCommentUi | undefined =>
                ordinal === undefined || comment === null
                  ? undefined
                  : {
                      selected: inSelection(ordinal),
                      disabled: comment.reason !== null,
                      reason: comment.reason,
                      onSelect: (extend) => comment.onRowSelect(ordinal, extend),
                    };
              return (
                <SplitRow
                  key={line.ordinal}
                  row={line}
                  wrap={wrap}
                  ui={ui}
                  comment={
                    line.kind === "gap"
                      ? undefined
                      : { old: cellUi(line.oldOrdinal), new: cellUi(line.newOrdinal) }
                  }
                />
              );
            })
          : rows.map((line) => (
              <DiffRow
                key={line.ordinal}
                row={line}
                wrap={wrap}
                ui={ui}
                comment={
                  comment === null || line.kind === "gap"
                    ? undefined
                    : {
                        selected: inSelection(line.ordinal),
                        disabled: comment.reason !== null,
                        reason: comment.reason,
                        onSelect: (extend) => comment.onRowSelect(line.ordinal, extend),
                      }
                }
              />
            )))}
      {!collapsed && expansion?.status === "loading" && (
        <p style={{ padding: "4px 10px", color: muted, fontSize: 11, margin: 0 }}>
          Loading file contents…
        </p>
      )}
      {!collapsed && expansion?.status === "error" && (
        <p role="alert" style={{ padding: "4px 10px", color: muted, fontSize: 11, margin: 0 }}>
          {expansion.detail}
        </p>
      )}
      {!collapsed && expansion?.status === "loaded" && (
        <p style={{ padding: "4px 10px", color: muted, fontSize: 11, margin: 0 }}>
          Full file context loaded via t3.vcs/diff.
        </p>
      )}
      {comment !== null && comment.posted.length > 0 && (
        <section
          aria-label="Review comments added here"
          style={{
            padding: "6px 10px",
            borderTop: `1px solid ${ui.border}`,
            flexShrink: 0,
            fontSize: 11,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {comment.posted.map((entry) => (
            <span
              key={entry.annotationId}
              style={{ display: "flex", gap: 6, alignItems: "baseline" }}
            >
              <span style={{ flex: 1 }}>
                {entry.rangeLabel}
                {entry.text !== null ? ` — ${entry.text}` : ""}
              </span>
              <button
                type="button"
                style={ui.iconButton}
                disabled={comment.removing === entry.annotationId}
                onClick={() => comment.onRemove(entry.annotationId)}
              >
                {comment.removing === entry.annotationId ? "Removing…" : "Remove"}
              </button>
            </span>
          ))}
          {comment.removeError !== null && (
            <span role="alert" style={{ color: ui.destructive }}>
              {comment.removeError}
            </span>
          )}
          <span style={{ color: muted }}>
            Comments sit in the composer draft until sent — removal also works from its chip.
          </span>
        </section>
      )}
    </section>
  );
}

function DiffPanelView(props: { host: ClientHost; session: ViewSession }) {
  const { host, session } = props;
  const [visible, setVisible] = useState(session.visible);
  const [tick, setTick] = useState(0);
  useEffect(() => session.onVisibility(setVisible), [session]);
  const tokens = useThemeTokens(host, session, visible);
  const ui = panelTheme(tokens);

  const restored =
    session.restoreState &&
    typeof session.restoreState === "object" &&
    !Array.isArray(session.restoreState)
      ? (session.restoreState as RestoredState)
      : null;
  const [mode, setMode] = useState<DiffMode>(restored?.mode === "turns" ? "turns" : "workspace");
  const [turnWanted, setTurnWanted] = useState<TurnSelection | null>(
    restored?.mode === "turns"
      ? restored.turnId !== undefined
        ? { kind: "turn", turnId: restored.turnId, turnCount: 0 }
        : { kind: "thread" }
      : null,
  );
  const [sourceId, setSourceId] = useState<string | null>(restored?.sourceId ?? null);
  const [fileKey, setFileKey] = useState<string | null>(restored?.fileKey ?? null);
  const [baseRef, setBaseRef] = useState<string>(restored?.baseRef ?? "");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState<boolean>(
    restored?.ignoreWhitespace ?? false,
  );
  // Per-view layout (the plugin cannot reach the host's client settings);
  // wrap stays session-local — native's wordWrap toggle is unpersisted too.
  const [layout, setLayout] = useState<DiffLayout>(
    restored?.layout === "split" ? "split" : "unified",
  );
  const [wrap, setWrap] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set());
  const [expansions, setExpansions] = useState<ReadonlyMap<string, Expansion>>(new Map());
  const [action, setAction] = useState<{ key: string; status: string; detail: string } | null>(
    null,
  );
  const [revert, setRevert] = useState<{
    /** The checkpoint the dialog named — frozen at confirm-open, never re-resolved. */
    readonly choice: TurnChoice;
    readonly status: "confirming" | "pending" | "resolved" | "error";
    readonly detail: string;
    readonly guards?: {
      readonly expectedEpoch: string;
      readonly expectedRevision: number;
    };
  } | null>(null);
  const expandControllers = useRef(new Map<string, AbortController>());
  const contentStreamKeys = useRef(new Set<string>());
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  const { capabilities, error: capsError } = useCapabilities(host, session, visible, tick);
  const gate = diffCapabilityState(capabilities, capsError);
  const ready = gate.kind === "ready";

  const status = useStatusRefresh(host, session, visible && ready);
  const previewInput = useMemo<VcsDiffPreviewInput>(
    () => ({
      ...(baseRef !== "" ? { baseRef } : {}),
      ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    }),
    [baseRef, ignoreWhitespace],
  );
  const requestKey = `${tick}:${status.revision}:${previewDeliveryKey(previewInput)}`;
  const {
    preview: previewData,
    error: previewError,
    pending,
  } = useDiffPreview(host, session, visible && ready, requestKey, previewInput);
  // A refresh error next to last-good data is a note; only a cold failure
  // replaces the panel with the error state.
  const preview = previewState(previewData, previewData === null ? previewError : null);
  const { refs } = useRefs(host, session, visible && ready, status.revision);

  // --- turn/checkpoint mode: orchestration status drives the picker and
  // capabilities, and the selected turn's diff arrives over the same
  // verified stream family as repository previews.
  const turnsOpen = visible && ready && mode === "turns";
  const orchCaps = useOrchestrationCapabilities(host, session, turnsOpen, tick);
  const orchGate = orchestrationCapabilityState(orchCaps.capabilities, orchCaps.error);
  const agents = useAgentsStatus(
    host,
    session,
    turnsOpen && orchGate.kind === "ready" && orchGate.operations["subscribeAgents"] === true,
  );
  const choices = useMemo(() => turnChoices(agents.checkpoints), [agents.checkpoints]);
  const turnSelection = reconcileTurnSelection(choices, turnWanted);
  const turnDiffOps =
    orchGate.kind === "ready" &&
    orchGate.operations["getTurnDiff"] === true &&
    orchGate.operations["getThreadDiff"] === true;
  const turnRequestKey = `${tick}:${agents.revision}:${
    turnSelection === null
      ? "none"
      : turnSelection.kind === "thread"
        ? "thread"
        : `turn:${turnSelection.turnId}`
  }`;
  const turnDiff = useTurnDiff(
    host,
    session,
    turnsOpen && turnDiffOps,
    turnRequestKey,
    turnSelection,
  );
  const turnPreview = previewState(
    turnDiff.preview,
    turnDiff.preview === null ? turnDiff.error : null,
  );

  // A confirmation is bound to the checkpoint it named: if the projection
  // drops that checkpoint or reconciliation moves the selection to a
  // survivor, the frozen text would lie about what Confirm sends — dismiss
  // it rather than revert a checkpoint the user never saw named.
  const revertChoice = revertTarget(turnSelection, choices);
  if (revert?.status === "confirming" && revert.choice.turnId !== (revertChoice?.turnId ?? null)) {
    setRevert(null);
  }

  const activePreview = mode === "turns" ? turnPreview : preview;
  const activePending = mode === "turns" ? turnDiff.pending : pending;
  const source =
    mode === "turns"
      ? activePreview.kind === "ready"
        ? (activePreview.result.sources[0] ?? null)
        : null
      : selectSource(preview.kind === "ready" ? preview.result : null, sourceId);
  const renderable = source === null ? null : renderableFor(source.diffHash, source.diff);
  const files = renderable?.kind === "files" ? renderable.files : [];
  const selected = retainFileSelection(files, fileKey);
  const treeRows = diffTreeRows(files, collapsedDirs);
  const fileKeys = files.map((row) => row.key);
  const allCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsedFiles);
  const baseRefChoices = useMemo(() => buildBaseRefChoices(refs?.refs ?? []), [refs]);

  // --- Row 14/D9: line comments on diff rows. A comment's buffer is the
  // delivered source plus the file's loaded expansion — selection ordinals
  // and draft payloads are pinned to that buffer at capture, so a refresh
  // or an expansion load that reshapes the rows retires the pin instead of
  // re-arming it over different lines. Submit rides the grant-gated
  // `t3.messages/enrichment.attachAnnotation` seam, the same transport the
  // files panel uses for its line comments.
  const commentThreadId = session.context.resource.threadId;
  const { reason: commentReason, capabilities: commentCapabilities } = useCommentBlockReason(
    host,
    session,
    commentThreadId,
  );
  const [commentFileKey, setCommentFileKey] = useState<string | null>(null);
  const commentRow =
    commentFileKey === null ? null : (files.find((entry) => entry.key === commentFileKey) ?? null);
  const commentBuffer = useMemo<CommentBuffer | null>(() => {
    if (source === null || commentRow === null || commentRow.binary || commentRow.textless)
      return null;
    const expansion = expansions.get(`${source.diffHash}:${commentRow.key}`);
    return {
      diffHash: source.diffHash,
      fileKey: commentRow.key,
      contents:
        expansion?.status === "loaded"
          ? {
              oldContents: expansion.contents.oldContents,
              newContents: expansion.contents.newContents,
            }
          : null,
    };
  }, [source, commentRow, expansions]);
  const lineSelection = useLineSelection(commentBuffer);
  const {
    draft: commentDraft,
    draftStale: commentDraftStale,
    openDraft,
    closeDraft,
  } = useDiffCommentDraft(commentBuffer);
  const commentListable =
    commentCapabilities !== null &&
    commentCapabilities.transport === "client" &&
    commentCapabilities.operations.listAnnotations === true &&
    commentThreadId !== undefined;
  const posted = usePostedComments(host, session, commentThreadId, commentListable);
  const [commentBody, setCommentBody] = useState("");
  const [commentSubmit, setCommentSubmit] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  // The open draft the submit machinery last saw. A submit response must act
  // only on the form it was issued for — a newer draft (or a closed form) must
  // survive a late response.
  const submittedDraftRef = useRef<DiffCommentDraft | null>(null);

  // Row 30/D9: the annotation's section identity must match the native
  // viewer's filter exactly — commentSectionFor owns that mapping.
  const commentSection = useMemo(
    () => commentSectionFor(mode, turnSelection, source),
    [mode, turnSelection, source],
  );

  const selectCommentLines = (row: DiffFileRow, ordinal: number, extend: boolean) => {
    if (source === null || row.binary || row.textless) return;
    const expansion = expansions.get(`${source.diffHash}:${row.key}`);
    // Same construction as `commentBuffer`, built for the file the click
    // landed in — the pin must describe these rows, not the panel's last one.
    const buffer: CommentBuffer = {
      diffHash: source.diffHash,
      fileKey: row.key,
      contents:
        expansion?.status === "loaded"
          ? {
              oldContents: expansion.contents.oldContents,
              newContents: expansion.contents.newContents,
            }
          : null,
    };
    if (commentFileKey !== row.key) setCommentFileKey(row.key);
    // Shift-extend only within the file the held run lives in; across files
    // (or after a drift retired the run) the click starts a new run.
    lineSelection.select(buffer, ordinal, extend && commentFileKey === row.key);
  };
  const clearCommentSelection = () => lineSelection.clear();
  const openCommentDraft = (draft: DiffCommentDraft) => {
    if (commentBuffer === null) return;
    openDraft(commentBuffer, draft);
    submittedDraftRef.current = draft;
    setCommentBody("");
    setCommentSubmit({ busy: false, error: null });
  };
  const closeCommentDraft = () => {
    closeDraft();
    submittedDraftRef.current = null;
    setCommentBody("");
    setCommentSubmit({ busy: false, error: null });
  };
  const postedFor = (row: DiffFileRow): readonly PostedComment[] =>
    posted.entries.filter((entry) =>
      entry.fileKey !== null ? entry.fileKey === row.key : entry.filePath === row.path,
    );
  const submitCommentDraft = () => {
    const draft = commentDraft;
    const body = commentBody.trim();
    // Stale draft = the pinned buffer drifted under the form; the anchor and
    // quote it captured are dead and must never reach attachAnnotation.
    if (draft === null || commentDraftStale || body === "" || commentSubmit.busy) return;
    setCommentSubmit({ busy: true, error: null });
    void bindApi(messagesEnrichmentApi, host, session.context)
      .invoke(
        "attachAnnotation",
        {
          ...(commentThreadId !== undefined ? { threadId: commentThreadId } : {}),
          annotation: {
            kind: "diff",
            filePath: draft.filePath,
            sectionId: commentSection.id,
            sectionTitle: commentSection.title,
            rangeLabel: draft.target.rangeLabel,
            diff: draft.target.quote,
            selection: draft.target.selection,
            startIndex: draft.target.startIndex,
            endIndex: draft.target.endIndex,
            body,
          },
        },
        session.signal,
      )
      .then(
        (result) => {
          // The annotation landed regardless of what the form did meanwhile;
          // only the form itself is draft-scoped.
          posted.post({
            annotationId: result.annotationId,
            filePath: draft.filePath,
            fileKey: draft.fileKey,
            rangeLabel: draft.target.rangeLabel,
            text: body,
            sectionTitle: commentSection.title,
          });
          if (submittedDraftRef.current === draft) closeCommentDraft();
        },
        (error) => {
          // A newer form must not inherit this submit's outcome.
          if (submittedDraftRef.current !== draft) return;
          setCommentSubmit({
            busy: false,
            error: error instanceof Error ? error.message : "Comment could not be attached",
          });
        },
      );
  };
  // commentUi is the per-file slice: null for files with no commentable rows,
  // and a live selection/draft only in the file the pins belong to.
  const commentUiFor = (row: DiffFileRow): FileCommentUi | null =>
    row.binary || row.textless
      ? null
      : {
          reason: commentReason,
          anchor: commentFileKey === row.key ? (lineSelection.selection?.anchor ?? null) : null,
          extent: commentFileKey === row.key ? (lineSelection.selection?.extent ?? null) : null,
          onRowSelect: (ordinal, extend) => selectCommentLines(row, ordinal, extend),
          onClearSelection: clearCommentSelection,
          draft: commentDraft?.fileKey === row.key ? commentDraft : null,
          draftStale: commentDraft?.fileKey === row.key ? commentDraftStale : false,
          onOpenDraft: openCommentDraft,
          onCloseDraft: closeCommentDraft,
          body: commentBody,
          onBodyChange: setCommentBody,
          submit: commentSubmit,
          onSubmit: submitCommentDraft,
          posted: postedFor(row),
          removing: posted.removing,
          removeError: posted.removeError,
          onRemove: posted.remove,
        };

  // A new source payload invalidates in-flight expansion loads; stored
  // expansions are keyed `sourceHash:fileKey` so stale entries never paint.
  const sourceKey = source?.diffHash ?? null;
  useEffect(() => {
    if (sourceKey === null) return;
    const controllers = expandControllers.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, [sourceKey]);

  // Reveal-in-file is one-shot: the request lives in a ref and a tick state
  // re-runs the effect once after the uncollapse commit. Later collapse-set
  // changes (collapse-all, another file toggled) must not yank the scroll
  // back — the cleared ref makes the effect a no-op for them.
  const revealTarget = useRef<string | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => {
    if (revealTick === 0) return;
    const key = revealTarget.current;
    if (key === null || collapsedFiles.has(key)) return;
    sectionRefs.current.get(key)?.scrollIntoView({ block: "start" });
    revealTarget.current = null;
  }, [revealTick, collapsedFiles]);

  const persist = (next: {
    readonly mode: DiffMode;
    readonly sourceId: string | null;
    readonly fileKey: string | null;
    readonly baseRef: string;
    readonly ignoreWhitespace: boolean;
    readonly turnId?: string;
    readonly layout: DiffLayout;
  }) => {
    session.save({
      mode: next.mode,
      ...(next.sourceId !== null ? { sourceId: next.sourceId } : {}),
      ...(next.fileKey !== null ? { fileKey: next.fileKey } : {}),
      ...(next.baseRef !== "" ? { baseRef: next.baseRef } : {}),
      ...(next.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
      ...(next.turnId !== undefined ? { turnId: next.turnId } : {}),
      ...(next.layout === "split" ? { layout: "split" } : {}),
    });
  };
  // Every field the caller just changed is passed explicitly — reading the
  // current render's state here would persist the previous values.
  const persistSelection = (next: {
    readonly mode: DiffMode;
    readonly sourceId: string | null;
    readonly fileKey: string | null;
    readonly baseRef: string;
    readonly ignoreWhitespace: boolean;
    readonly layout: DiffLayout;
  }) =>
    persist({
      mode: next.mode,
      sourceId: next.mode === "turns" ? null : next.sourceId,
      fileKey: next.fileKey,
      baseRef: next.baseRef,
      ignoreWhitespace: next.ignoreWhitespace,
      turnId:
        next.mode === "turns" && turnSelection?.kind === "turn" ? turnSelection.turnId : undefined,
      layout: next.layout,
    });
  const chooseMode = (nextMode: DiffMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setFileKey(null);
    setRevert(null);
    setCommentFileKey(null);
    persistSelection({
      mode: nextMode,
      sourceId: source?.id ?? null,
      fileKey: null,
      baseRef,
      ignoreWhitespace,
      layout,
    });
  };
  const chooseTurn = (selection: TurnSelection) => {
    setTurnWanted(selection);
    setFileKey(null);
    setRevert(null);
    setCommentFileKey(null);
    persist({
      mode: "turns",
      sourceId: null,
      fileKey: null,
      baseRef,
      ignoreWhitespace,
      turnId: selection.kind === "turn" ? selection.turnId : undefined,
      layout,
    });
  };
  const chooseSource = (id: string) => {
    setSourceId(id);
    setFileKey(null);
    setCommentFileKey(null);
    persistSelection({ mode, sourceId: id, fileKey: null, baseRef, ignoreWhitespace, layout });
  };
  const revealFile = (row: DiffFileRow) => {
    setCollapsedFiles((current) => {
      const next = new Set(current);
      next.delete(row.key);
      return next;
    });
    setFileKey(row.key);
    revealTarget.current = row.key;
    setRevealTick((tick) => tick + 1);
    persistSelection({
      mode,
      sourceId: source?.id ?? null,
      fileKey: row.key,
      baseRef,
      ignoreWhitespace,
      layout,
    });
  };
  const chooseBaseRef = (value: string) => {
    setBaseRef(value);
    persistSelection({
      mode,
      sourceId: source?.id ?? null,
      fileKey,
      baseRef: value,
      ignoreWhitespace,
      layout,
    });
  };
  const chooseWhitespace = (value: boolean) => {
    setIgnoreWhitespace(value);
    persistSelection({
      mode,
      sourceId: source?.id ?? null,
      fileKey,
      baseRef,
      ignoreWhitespace: value,
      layout,
    });
  };
  const chooseLayout = (value: DiffLayout) => {
    if (value === layout) return;
    setLayout(value);
    persistSelection({
      mode,
      sourceId: source?.id ?? null,
      fileKey,
      baseRef,
      ignoreWhitespace,
      layout: value,
    });
  };

  const confirmRevert = (choice: TurnChoice) => {
    setRevert({
      choice,
      status: "confirming",
      detail: `Restore the workspace to ${choice.label}? Checkpoints from later turns are discarded.`,
      // Guards freeze with the target: a world that moved on while the
      // dialog sat open rejects by name instead of reverting a surprise.
      // Before the agents stream delivers an epoch there is nothing honest
      // to compare against, so they stay omitted.
      ...(agents.streamEpoch !== null
        ? {
            guards: {
              expectedEpoch: agents.streamEpoch,
              expectedRevision: agents.revision,
            },
          }
        : {}),
    });
  };
  const runRevert = () => {
    if (revert === null || revert.status !== "confirming") return;
    const confirmed = revert;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    setRevert({ ...confirmed, status: "pending", detail: "Reverting…" });
    void bindApi(orchestrationControlApi, host, session.context)
      .invoke(
        "checkpoint.revert",
        checkpointRevertInput(confirmed.choice, {
          commandId: crypto.randomUUID(),
          ...confirmed.guards,
        }),
        signal,
      )
      .then(
        (receipt: OrchestrationReceipt) => {
          if (!signal.aborted)
            setRevert({
              ...confirmed,
              status: "resolved",
              detail: describeRevertReceipt(receipt),
            });
        },
        (error) => {
          if (!signal.aborted)
            setRevert({
              ...confirmed,
              status: "error",
              detail: error instanceof Error ? error.message : "Revert unavailable",
            });
        },
      );
  };

  const expandFile = (row: DiffFileRow) => {
    // Checkpoint diffs carry no repository refs — `getFileContents` only
    // serves workspace/branch sources, so turn mode never expands.
    if (source === null || mode === "turns") return;
    const key = `${source.diffHash}:${row.key}`;
    // A failed expansion retries: contents that moved under the diff leave
    // an error entry the user must be able to clear by trying again — and
    // a reverted mutation restores the same diffHash, so the entry cannot
    // be keyed away by refreshing. Loading/loaded entries stay sticky.
    const existing = expansions.get(key);
    if (existing !== undefined && existing.status !== "error") return;
    const controller = new AbortController();
    expandControllers.current.set(key, controller);
    const signal = AbortSignal.any([controller.signal, session.signal]);
    setExpansions((prev) => {
      const next = new Map(prev);
      if (next.size > 64) next.clear();
      return next.set(key, { status: "loading" });
    });
    const input = fileContentsInput(source, row);
    const api = bindApi(vcsDiffApi, host, session.context);
    const streams = bindStreamApi(vcsDiffApi, host, session.context);
    void fetchFileContents({
      input,
      deliveryKey: contentsDeliveryKey(source, row),
      invoke: (next) => api.invoke("getFileContents", next, signal),
      stream: (next) => streams.subscribe("streamFileContents", next, signal),
      streamKeys: contentStreamKeys.current,
      signal,
    }).then((outcome) => {
      expandControllers.current.delete(key);
      if (signal.aborted || outcome.kind === "cancelled") return;
      setExpansions((prev) =>
        new Map(prev).set(
          key,
          outcome.kind === "ready"
            ? expansionMatchesPatch(row, outcome.result)
              ? { status: "loaded", contents: outcome.result }
              : {
                  status: "error",
                  detail:
                    "Loaded contents do not match this diff — the file changed while loading. Refresh the diff to try again.",
                }
            : { status: "error", detail: outcome.detail },
        ),
      );
    });
  };

  const openInEditor = (row: DiffFileRow) => {
    const path = presentationPath(row.path);
    if (path === null) {
      setAction({
        key: row.key,
        status: "error",
        detail: `${displayPath(row)} cannot be opened — not a workspace-relative path.`,
      });
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    setAction({ key: row.key, status: "loading", detail: "Resolving presentation…" });
    void bindApi(filePresentationApi, host, session.context)
      .invoke("open", { relativePath: path }, signal)
      .then(
        (result) => {
          if (!signal.aborted)
            setAction({ key: row.key, status: "resolved", detail: describePresentation(result) });
        },
        (error) => {
          if (!signal.aborted)
            setAction({
              key: row.key,
              status: "error",
              detail: error instanceof Error ? error.message : "Presentation unavailable",
            });
        },
      );
  };

  const copyPath = (row: DiffFileRow) => {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setAction({ key: row.key, status: "error", detail: "Clipboard unavailable" });
      return;
    }
    void navigator.clipboard.writeText(row.path).then(
      () => setAction({ key: row.key, status: "copied", detail: `Copied ${row.path}` }),
      (error) =>
        setAction({
          key: row.key,
          status: "error",
          detail: error instanceof Error ? error.message : "Copy failed",
        }),
    );
  };

  const muted = ui.muted;
  const sources = preview.kind === "ready" ? preview.result.sources : [];
  const filteredBaseChoices = filterBaseRefChoices(baseRefChoices, baseRef);
  const revertCapable =
    orchGate.kind === "ready" && orchGate.operations["checkpoint.revert"] === true;
  return (
    <section
      aria-label="Diff"
      data-t3-diff-panel
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        color: ui.foreground,
        background: ui.background,
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: 13,
      }}
    >
      {/* Native focus treatment (cert diff-1): the host draws a 2px accent
          ring with a 1px canvas gap on focus-visible, not the browser
          default 1px auto outline. */}
      <style>
        {`[data-t3-diff-panel] :is(button,input,select,textarea):focus-visible{outline:none;box-shadow:0 0 0 1px ${ui.background},0 0 0 3px ${ui.focusRing}}`}
      </style>
      <header
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderBottom: `1px solid ${ui.border}`,
          flexShrink: 0,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button type="button" onClick={() => setTick((value) => value + 1)} style={ui.control}>
          Refresh
        </button>
        {(["workspace", "turns"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-current={mode === value ? "true" : undefined}
            onClick={() => chooseMode(value)}
            style={{
              ...ui.control,
              fontWeight: mode === value ? 600 : 400,
              background: mode === value ? ui.accent : "transparent",
            }}
          >
            {value === "workspace" ? "Workspace" : "Turns"}
          </button>
        ))}
        {mode === "workspace" &&
          sources.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={source?.id === item.id ? "true" : undefined}
              onClick={() => chooseSource(item.id)}
              style={{
                ...ui.control,
                fontWeight: source?.id === item.id ? 600 : 400,
                background: source?.id === item.id ? ui.accent : "transparent",
              }}
            >
              {describeSource(item)}
            </button>
          ))}
        {mode === "turns" && (
          <>
            {choices.map((choice) => (
              <button
                key={choice.turnId}
                type="button"
                aria-current={
                  turnSelection?.kind === "turn" && turnSelection.turnId === choice.turnId
                    ? "true"
                    : undefined
                }
                onClick={() =>
                  chooseTurn({
                    kind: "turn",
                    turnId: choice.turnId,
                    turnCount: choice.turnCount,
                  })
                }
                style={{
                  ...ui.control,
                  fontWeight:
                    turnSelection?.kind === "turn" && turnSelection.turnId === choice.turnId
                      ? 600
                      : 400,
                  background:
                    turnSelection?.kind === "turn" && turnSelection.turnId === choice.turnId
                      ? ui.accent
                      : "transparent",
                }}
              >
                {choice.label}
                {choice.detail !== "" && (
                  <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{choice.detail}</span>
                )}
              </button>
            ))}
            {choices.length > 0 && (
              <button
                type="button"
                aria-current={turnSelection?.kind === "thread" ? "true" : undefined}
                onClick={() => chooseTurn({ kind: "thread" })}
                style={{
                  ...ui.control,
                  fontWeight: turnSelection?.kind === "thread" ? 600 : 400,
                  background: turnSelection?.kind === "thread" ? ui.accent : "transparent",
                }}
              >
                All turns
              </button>
            )}
            {revertChoice !== null && revertCapable && (
              <button
                type="button"
                style={{ ...ui.control, color: ui.destructive }}
                disabled={revert?.status === "pending"}
                onClick={() => confirmRevert(revertChoice)}
              >
                Revert to {revertChoice.label}
              </button>
            )}
          </>
        )}
        {mode === "workspace" && (
          <>
            <input
              type="text"
              aria-label="Base ref"
              placeholder="Base ref (automatic)"
              list="t3-diff-base-refs"
              value={baseRef}
              onChange={(event) => chooseBaseRef(event.target.value)}
              style={{ ...ui.control, width: 140 }}
            />
            <datalist id="t3-diff-base-refs">
              {filteredBaseChoices.map((choice) => (
                <option key={choice.id} value={choice.refName}>
                  {choice.label}
                </option>
              ))}
            </datalist>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={ignoreWhitespace}
                onChange={(event) => chooseWhitespace(event.target.checked)}
              />
              Ignore whitespace
            </label>
          </>
        )}
        <div role="group" aria-label="Diff layout" style={{ display: "flex" }}>
          {(["unified", "split"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={layout === value}
              onClick={() => chooseLayout(value)}
              style={{
                ...ui.control,
                fontWeight: layout === value ? 600 : 400,
                background: layout === value ? ui.accent : "transparent",
              }}
            >
              {value === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={wrap}
            onChange={(event) => setWrap(event.target.checked)}
          />
          Wrap
        </label>
        {files.length > 0 && (
          <button
            type="button"
            style={ui.control}
            onClick={() => setCollapsedFiles(toggleAllDiffFiles(fileKeys, collapsedFiles))}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
        {mode === "workspace" && status.stream === "ended" && (
          <span role="note" style={{ color: muted, fontSize: 11 }}>
            {status.detail ?? "Status stream ended"} — refresh is manual.
          </span>
        )}
        {mode === "turns" && agents.stream === "ended" && (
          <span role="note" style={{ color: muted, fontSize: 11 }}>
            {agents.detail ?? "Orchestration stream ended"} — refresh is manual.
          </span>
        )}
      </header>

      {gate.kind === "loading" && (
        <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          Reading repository capabilities…
        </p>
      )}
      {gate.kind === "unavailable" && (
        <p role="alert" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          Repository status unavailable — {gate.detail}
        </p>
      )}
      {gate.kind === "no-repository" && (
        <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          This workspace is not a repository
          {gate.detail ? ` — ${gate.detail}` : ""}.
        </p>
      )}
      {gate.kind === "unsupported" && (
        <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          Unsupported repository driver: {gate.driverKind}. {gate.detail}
        </p>
      )}

      {ready && mode === "turns" && orchGate.kind === "loading" && (
        <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          Reading orchestration capabilities…
        </p>
      )}
      {ready && mode === "turns" && orchGate.kind === "unavailable" && (
        <p role="alert" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          Turn diffs unavailable — {orchGate.detail}
        </p>
      )}
      {ready && mode === "turns" && orchGate.kind === "ready" && !turnDiffOps && (
        <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          This thread's orchestration status does not offer turn or thread diffs.
        </p>
      )}
      {ready &&
        mode === "turns" &&
        orchGate.kind === "ready" &&
        turnDiffOps &&
        agents.stream === "live" &&
        choices.length === 0 && (
          <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
            No checkpoints recorded for this thread yet — turn diffs appear after a completed turn.
          </p>
        )}

      {ready && mode === "turns" && revert !== null && (
        <div
          role={revert.status === "error" ? "alert" : "note"}
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            padding: "6px 10px",
            color: revert.status === "error" ? ui.destructive : muted,
            fontSize: 12,
            margin: 0,
            borderBottom: `1px solid ${ui.border}`,
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1 }}>{revert.detail}</span>
          {revert.status === "confirming" && (
            <>
              <button type="button" style={ui.iconButton} onClick={runRevert}>
                Confirm revert
              </button>
              <button type="button" style={ui.iconButton} onClick={() => setRevert(null)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {ready &&
        (mode !== "turns" || turnSelection !== null) &&
        activePreview.kind === "loading" && (
          <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
            Loading diff…
          </p>
        )}
      {ready && activePreview.kind === "error" && (
        <p role="alert" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          {activePreview.detail}
        </p>
      )}
      {ready && mode === "workspace" && activePreview.kind === "empty" && (
        <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          No diff sources reported for this workspace.
        </p>
      )}
      {ready && mode === "workspace" && previewData !== null && previewError !== null && (
        <p role="alert" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          Refresh failed — {previewError}
        </p>
      )}
      {ready && mode === "turns" && turnDiff.preview !== null && turnDiff.error !== null && (
        <p role="alert" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          Refresh failed — {turnDiff.error}
        </p>
      )}

      {ready && activePreview.kind === "ready" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {activePending && (
            <p role="note" style={{ padding: "2px 10px", color: muted, fontSize: 11, margin: 0 }}>
              Refreshing…
            </p>
          )}
          {source?.truncated === true && (
            <p
              role="note"
              style={{
                margin: 0,
                padding: "6px 10px",
                fontSize: 11,
                color: muted,
                borderBottom: `1px solid ${ui.border}`,
                flexShrink: 0,
              }}
            >
              This diff was truncated because it exceeded the preview limit. The changes shown are
              incomplete.
            </p>
          )}
          {renderable === null && (
            <p style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
              No net changes in this selection.
            </p>
          )}
          {renderable?.kind === "raw" && (
            <div style={{ padding: 8, overflow: "auto", flex: 1, minHeight: 0 }}>
              <p style={{ color: muted, fontSize: 11, margin: "0 0 6px" }}>{renderable.reason}</p>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  fontSize: 11,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  border: `1px solid ${ui.border}`,
                  borderRadius: 6,
                  overflow: "auto",
                }}
              >
                {renderable.text}
              </pre>
            </div>
          )}
          {renderable?.kind === "files" && (
            <>
              {posted.listError !== null && (
                <p
                  role="alert"
                  style={{ padding: "2px 10px", color: muted, fontSize: 11, margin: 0 }}
                >
                  Earlier comments could not be listed — {posted.listError}
                </p>
              )}
              <ul
                aria-label="Changed files"
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 4,
                  overflow: "auto",
                  flexShrink: 0,
                  maxHeight: "34%",
                  borderBottom: `1px solid ${ui.border}`,
                }}
              >
                {treeRows.map((row) =>
                  row.kind === "dir" ? (
                    <li key={row.path}>
                      <button
                        type="button"
                        aria-expanded={!row.collapsed}
                        onClick={() =>
                          setCollapsedDirs(toggleCollapsedKey(collapsedDirs, row.path))
                        }
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          font: "inherit",
                          fontSize: 12,
                          padding: "3px 6px",
                          paddingLeft: 6 + row.depth * 14,
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          color: muted,
                        }}
                      >
                        {row.collapsed ? "▸" : "▾"} {row.name}/<span> ({row.fileCount})</span>
                      </button>
                    </li>
                  ) : (
                    <li key={row.row.key}>
                      <button
                        type="button"
                        aria-current={selected?.key === row.row.key ? "true" : undefined}
                        onClick={() => revealFile(row.row)}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          font: "inherit",
                          fontSize: 12,
                          padding: "4px 6px",
                          paddingLeft: 6 + row.depth * 14 + 14,
                          border: "1px solid transparent",
                          borderRadius: 5,
                          cursor: "pointer",
                          color: ui.foreground,
                          background: selected?.key === row.row.key ? ui.accent : "transparent",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {row.name}
                        <span style={{ color: muted }}>
                          {" "}
                          — {row.row.binary ? "binary" : changeTypeLabel(row.row.changeType)}
                          {fileStatLabel(row.row) !== "" ? ` ${fileStatLabel(row.row)}` : ""}
                        </span>
                      </button>
                    </li>
                  ),
                )}
              </ul>

              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }} aria-label="File diffs">
                {files.length === 0 && (
                  <p style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
                    Select a file to inspect its changes.
                  </p>
                )}
                {source !== null &&
                  files.map((row) => (
                    <FileSection
                      key={row.key}
                      row={row}
                      selected={selected?.key === row.key}
                      collapsed={collapsedFiles.has(row.key)}
                      layout={layout}
                      wrap={wrap}
                      expansion={expansions.get(`${source.diffHash}:${row.key}`)}
                      expandable={mode === "workspace"}
                      action={action}
                      comment={commentUiFor(row)}
                      ui={ui}
                      onToggleCollapsed={(key) =>
                        setCollapsedFiles(toggleCollapsedKey(collapsedFiles, key))
                      }
                      onExpand={expandFile}
                      onOpen={openInEditor}
                      onCopy={copyPath}
                      registerSection={(el) => {
                        if (el !== null) sectionRefs.current.set(row.key, el);
                        else sectionRefs.current.delete(row.key);
                      }}
                    />
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      <output
        aria-label="Slice notice"
        style={{
          padding: "6px 10px",
          color: muted,
          fontSize: 11,
          borderTop: `1px solid ${ui.border}`,
          flexShrink: 0,
        }}
      >
        Read-only diff on t3.vcs/diff 1.1 + t3.orchestration: unary small previews, sha256-verified
        streams for large payloads and turn diffs, status-driven refresh. Checkpoint diffs are
        view-only — revert runs through t3.orchestration/control. Line comments ride
        t3.messages/enrichment into the composer draft.
      </output>
    </section>
  );
}

const authored = defineExtension({
  id: manifestId,
  version: "0.5.0",
  requires: [
    requireApi(vcsDiffApi),
    requireApi(vcsRepositoryApi),
    requireApi(vcsStatusApi),
    requireApi(vcsRefsApi),
    requireApi(filePresentationApi),
    requireApi(orchestrationStatusApi),
    requireApi(orchestrationControlApi),
    requireApi(messagesEnrichmentApi),
    requireApi(uiThemeApi),
    requireApi(uiKeybindingsApi),
    requireApi(uiPanelsApi),
    requireApi(uiNotificationsApi),
  ],
  surfaces: [
    {
      name: "view",
      title: "Diff",
      scope: "thread",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      // SurfaceDescriptor.capabilities declares consumed host services; the
      // installed path exposes none, so this stays empty.
      capabilities: [],
      stateVersion: 1,
      validateRestore: restoreDiffState,
      createView(host, session) {
        bindDiffViewCommands(host, session);
        return { renderer: () => <DiffPanelView host={host} session={session} /> };
      },
    },
  ],
});

export default {
  ...authored,
  // The factory stages the installation-scoped `ext.t3.diff.toggle` set; the
  // seam flushes it once the installation commits on a live provider
  // connection. Absent `registerGlobalCommands` means a host without the seam.
  client(host: ClientHost) {
    stageDiffCommands(host);
    return authored.client!(host);
  },
} satisfies AuthoredExtension;

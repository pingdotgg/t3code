import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import { DEFAULT_TERMINAL_ID, type RuntimeMode } from "@t3tools/contracts";
import { useTerminalDimensions } from "@opentui/react";
import * as React from "react";

import { derivePendingApprovals } from "../approvals.ts";
import type { TuiClient } from "../connection.ts";
import { useKeyBindings } from "../hooks/useKeyBindings.ts";
import { createStore } from "../store.ts";
import { usePalette } from "../theme.ts";
import { buildRows, selectionEquals } from "./Sidebar.logic.ts";
import { ChatComposer } from "./ChatComposer.tsx";
import { MessagesTimeline } from "./MessagesTimeline.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { type TerminalInfo, ThreadTerminalDrawer } from "./ThreadTerminalDrawer.tsx";

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

/** Default width of the thread-list pane. */
const LIST_PANE_WIDTH = 34;
/** Conversation lines scrolled per page key. */
const SCROLL_STEP = 8;

// Top-level layout + state wiring (mirrors apps/web/src/components/ChatView.tsx):
// owns the external store + UI state, derives the row window and pane heights,
// routes key bindings to actions, and composes Sidebar / MessagesTimeline /
// ChatComposer / ThreadTerminalDrawer.

export function ChatView({
  client,
  onExit,
}: {
  readonly client: TuiClient;
  readonly onExit: () => void;
}): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const palette = usePalette();
  const store = React.useMemo(() => createStore(client), [client]);
  const syntaxStyle = React.useMemo(() => SyntaxStyle.create(), []);
  const state = React.useSyncExternalStore(store.subscribe, store.getState);

  React.useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const [focus, setFocus] = React.useState<"compose" | "new">("compose");
  const [reply, setReply] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [projectIndex, setProjectIndex] = React.useState(0);
  const [activeTerminal, setActiveTerminal] = React.useState<TerminalInfo | null>(null);
  const [listWidth] = React.useState(LIST_PANE_WIDTH);
  const scrollRef = React.useRef<ScrollBoxRenderable | null>(null);

  const projects = state.shell?.projects ?? [];
  const selectedThreadId = state.selection?.kind === "thread" ? state.selection.id : null;
  const rows = React.useMemo(
    () => buildRows(state.shell, state.expanded, state.loadedInFull, selectedThreadId),
    [state.shell, state.expanded, state.loadedInFull, selectedThreadId],
  );
  const detail = state.detail;
  const approvals = React.useMemo(
    () => (detail ? derivePendingApprovals(detail.activities) : []),
    [detail],
  );
  const selectedProjectTitle =
    state.selection?.kind === "project"
      ? (projects.find((project) => project.id === state.selection?.id)?.title ?? null)
      : null;

  // Deterministic viewport heights.
  const composerHeight = focus === "new" ? 6 : 5;
  const terminalDrawerHeight = activeTerminal
    ? Math.min(Math.max(Math.floor(height * 0.62), 6), Math.max(6, height - 6))
    : 0;
  const bottomReserve = activeTerminal ? terminalDrawerHeight + 1 : composerHeight + 1;
  const panesHeight = Math.max(4, height - bottomReserve);
  const listViewport = Math.max(1, panesHeight - 3);
  const termCols = Math.max(2, width - 4);
  const termRows = Math.max(2, terminalDrawerHeight - 3);
  const chatWidth = Math.max(20, width - listWidth - 4);

  // Window the list around the selection so the highlighted row stays on screen.
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => selectionEquals(state.selection, row)),
  );
  const listStart =
    rows.length <= listViewport
      ? 0
      : Math.min(
          Math.max(0, selectedIndex - Math.floor(listViewport / 2)),
          rows.length - listViewport,
        );
  // Memoized so the (memoized) Sidebar doesn't re-render while the conversation
  // streams — listRows is stable unless the shell/selection/window actually moves.
  const listRows = React.useMemo(
    () => rows.slice(listStart, listStart + listViewport),
    [rows, listStart, listViewport],
  );
  const moreAbove = listStart > 0;
  const moreBelow = listStart + listViewport < rows.length;

  const sendReply = () => {
    const text = reply.trim();
    if (text.length === 0) {
      // Empty prompt → Enter activates the highlighted row.
      if (state.selection?.kind === "project") store.toggleProject(state.selection.id);
      else if (state.selection?.kind === "more") store.loadMore(state.selection.id);
      return;
    }
    if (!detail) {
      store.setStatus("Select a thread (↑/↓) to send a message.");
      return;
    }
    void client
      .sendReply(detail, text)
      .catch((error) => store.setStatus(`send failed: ${String(error)}`));
    store.setStatus("Reply sent.");
    setReply("");
  };

  const submitNewThread = () => {
    const project = projects[projectIndex];
    const message = draft.trim();
    if (project && message.length > 0) {
      if (!project.defaultModelSelection) {
        store.setStatus("Project has no default model — set one in the web UI first.");
      } else {
        void client
          .createThread({
            projectId: project.id,
            title: message.slice(0, 60),
            modelSelection: project.defaultModelSelection,
            firstMessage: message,
          })
          .catch((error) => store.setStatus(`create failed: ${String(error)}`));
        store.setStatus("Creating thread…");
      }
    }
    setDraft("");
    setFocus("compose");
  };

  const openTerminal = () => {
    if (!detail) return;
    const project = projects.find((p) => p.id === detail.projectId);
    const cwd = detail.worktreePath ?? project?.workspaceRoot ?? process.cwd();
    setActiveTerminal({
      threadId: detail.id,
      terminalId: DEFAULT_TERMINAL_ID,
      title: detail.title,
      cwd,
      worktreePath: detail.worktreePath,
    });
  };

  useKeyBindings({
    mode: activeTerminal ? "terminal" : focus === "new" ? "new" : "compose",
    onExit,
    onTerminalKey: (sequence) => {
      if (activeTerminal) {
        void client
          .terminalWrite(activeTerminal.threadId, activeTerminal.terminalId, sequence)
          .catch(() => {});
      }
    },
    onCloseTerminal: () => setActiveTerminal(null),
    onCancelNew: () => {
      setDraft("");
      setFocus("compose");
    },
    onProjectPrev: () =>
      setProjectIndex((index) => (index > 0 ? index - 1 : Math.max(projects.length - 1, 0))),
    onProjectNext: () => setProjectIndex((index) => (index + 1) % Math.max(projects.length, 1)),
    onSubmitNew: submitNewThread,
    onNavUp: () => store.moveSelection(-1),
    onNavDown: () => store.moveSelection(1),
    onScrollUp: () => scrollRef.current?.scrollBy({ x: 0, y: -SCROLL_STEP }),
    onScrollDown: () => scrollRef.current?.scrollBy({ x: 0, y: SCROLL_STEP }),
    onNewThread: () => {
      setProjectIndex(0);
      setFocus("new");
    },
    onOpenTerminal: openTerminal,
    onInterrupt: () => {
      if (!detail) return;
      void client.interrupt(detail.id).catch(() => {});
      store.setStatus("Interrupt sent.");
    },
    onApprove: () => {
      if (!detail || !approvals[0]) return;
      void client.approve(detail.id, approvals[0].requestId, "accept").catch(() => {});
      store.setStatus("Approved.");
    },
    onDecline: () => {
      if (!detail || !approvals[0]) return;
      void client.approve(detail.id, approvals[0].requestId, "decline").catch(() => {});
      store.setStatus("Declined.");
    },
    onCycleMode: () => {
      if (!detail) return;
      const current = RUNTIME_MODES.indexOf(detail.runtimeMode);
      const nextMode = RUNTIME_MODES[(current + 1) % RUNTIME_MODES.length] ?? "full-access";
      void client.setRuntimeMode(detail.id, nextMode).catch(() => {});
      store.setStatus(`Mode → ${nextMode}`);
    },
    onSend: sendReply,
    onEscape: () => {
      if (reply.length > 0) {
        setReply("");
        return;
      }
      if (detail) {
        void client.interrupt(detail.id).catch(() => {});
        store.setStatus("Interrupt sent.");
      }
    },
  });

  const placeholder = detail
    ? "Type a reply, Enter to send"
    : state.selection?.kind === "project"
      ? "Enter to expand · ↑/↓ to move"
      : "Select a thread with ↑/↓";

  const hint =
    "↑/↓ threads · PgUp/PgDn scroll · Enter send · ^N new · ^E term · ^G stop · ^A/^R approve · ^O mode · ^C quit";

  return (
    <box flexDirection="column" width={width} height={height}>
      <box height={panesHeight} flexShrink={0} flexDirection="row">
        <Sidebar
          rows={listRows}
          selection={state.selection}
          moreAbove={moreAbove}
          moreBelow={moreBelow}
          width={listWidth}
          height={panesHeight}
          store={store}
        />
        <MessagesTimeline
          detail={detail}
          approvals={approvals}
          projectHint={selectedProjectTitle}
          width={chatWidth}
          height={panesHeight}
          syntaxStyle={syntaxStyle}
          scrollRef={scrollRef}
        />
      </box>

      {activeTerminal ? (
        <box flexDirection="column" flexShrink={0}>
          <ThreadTerminalDrawer client={client} info={activeTerminal} cols={termCols} rows={termRows} />
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text fg={palette.dim}>keys → shell · Ctrl+Q to return</text>
          </box>
        </box>
      ) : (
        <ChatComposer
          mode={focus}
          reply={reply}
          draft={draft}
          placeholder={placeholder}
          projectName={projects[projectIndex]?.title ?? "(none)"}
          onReplyInput={setReply}
          onDraftInput={setDraft}
        />
      )}

      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={palette.dim}>{hint}</text>
        <text fg={palette.dim}>{` ${state.status}`}</text>
      </box>
    </box>
  );
}

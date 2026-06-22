import { type ScrollBoxRenderable, type SelectOption, SyntaxStyle } from "@opentui/core";
import {
  type GitStackedAction,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as React from "react";

import { derivePendingApprovals } from "../approvals.ts";
import { normalizeEditedPrompt, resolveEditorCommand } from "../promptEditor.ts";
import type { TuiClient } from "../connection.ts";
import { useKeyBindings } from "../hooks/useKeyBindings.ts";
import { latestActionableProposedPlan } from "../proposedPlan.ts";
import { createStore } from "../store.ts";
import { statusGlyphColor, usePalette } from "../theme.ts";
import { currentModelIndex } from "../models.ts";
import { isWorking, revertableCheckpoints } from "../timeline.ts";
import { buildUserInputAnswers, derivePendingUserInputs } from "../userInput.ts";
import { buildRows, selectionEquals } from "./Sidebar.logic.ts";
import { ChatComposer } from "./ChatComposer.tsx";
import { type DiffStatus, type DiffView, DiffViewer } from "./DiffViewer.tsx";
import { type Command, filterCommands } from "../commands.ts";
import { buildFileTree, flattenFileTree } from "../fileTree.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { FilesView, type FilesStatus, type ViewingFile } from "./FilesView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { MessagesTimeline } from "./MessagesTimeline.tsx";
import { RightPanel } from "./RightPanel.tsx";
import { SelectOverlay, type SelectStatus } from "./SelectOverlay.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ConfirmDeleteMenu, RevertMenu } from "./ThreadOverlays.tsx";
import { type TerminalInfo, ThreadTerminalDrawer } from "./ThreadTerminalDrawer.tsx";
import {
  composerControls,
  getReasoningEffort,
  RUNTIME_MODE_META,
  RUNTIME_MODES,
  runtimeModeLabel,
} from "../controls.ts";
import { gitActionNeedsCommitMessage } from "../gitActions.logic.ts";
import {
  addTab,
  closeTab,
  cycleActiveId,
  initialTabs,
  type ThreadTabs,
} from "../terminalTabs.ts";

/** Default width of the thread-list pane. */
const LIST_PANE_WIDTH = 34;
/** Width of the source-control panel, and the terminal width below which it auto-hides. */
const RIGHT_PANEL_WIDTH = 32;
const RIGHT_PANEL_MIN_TERMINAL_WIDTH = 100;
/** Conversation lines scrolled per page key. */
const SCROLL_STEP = 8;
/** Cap on terminals per thread (mirrors the web's per-group limit). */
const MAX_TERMINALS_PER_THREAD = 6;

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
  const renderer = useRenderer();
  const palette = usePalette();
  const store = React.useMemo(() => createStore(client), [client]);
  const syntaxStyle = React.useMemo(() => SyntaxStyle.create(), []);
  const state = React.useSyncExternalStore(store.subscribe, store.getState);

  React.useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const [focus, setFocus] = React.useState<"compose" | "new" | "rename" | "filter" | "commit">(
    "compose",
  );
  // Transient key-driven overlay over the composer (thread actions / delete confirm / revert).
  const [overlay, setOverlay] = React.useState<"none" | "command" | "confirmDelete" | "revert">(
    "none",
  );
  const [revertIndex, setRevertIndex] = React.useState(0);
  // The command palette (^K): its filter query and highlighted row.
  const [commandQuery, setCommandQuery] = React.useState("");
  const [commandIndex, setCommandIndex] = React.useState(0);
  // Turn diff viewer (^K → g): which checkpoint's diff, its fetch state, the text.
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [diffIndex, setDiffIndex] = React.useState(0);
  const [diffStatus, setDiffStatus] = React.useState<DiffStatus>("loading");
  const [diffText, setDiffText] = React.useState("");
  const [diffView, setDiffView] = React.useState<DiffView>("unified");
  // When a single changed file was clicked, scope the diff to it (cleared on turn nav).
  const [diffFocusPath, setDiffFocusPath] = React.useState<string | null>(null);
  const diffScrollRef = React.useRef<ScrollBoxRenderable | null>(null);
  // The workspace file browser (palette → Browse files): the entry index, the
  // selected row, collapsed dirs, and the currently-open file's contents.
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [filesStatus, setFilesStatus] = React.useState<FilesStatus>("loading");
  const [fileEntries, setFileEntries] = React.useState<
    ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }>
  >([]);
  const [filesIndex, setFilesIndex] = React.useState(0);
  const [filesCollapsedDirs, setFilesCollapsedDirs] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [viewingFile, setViewingFile] = React.useState<ViewingFile | null>(null);
  const filesScrollRef = React.useRef<ScrollBoxRenderable | null>(null);
  // The settings / reference overlay (palette → Settings).
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const settingsScrollRef = React.useRef<ScrollBoxRenderable | null>(null);
  // Model picker (^K → m): fetched lazily on open.
  // A native-<select> picker for the composer controls (model / runtime / reasoning).
  const [picker, setPicker] = React.useState<{
    readonly kind: "model" | "runtime" | "reasoning";
    readonly title: string;
    readonly status: SelectStatus;
    readonly options: ReadonlyArray<SelectOption>;
    readonly selectedIndex: number;
  } | null>(null);
  // Pending user-input form state.
  const [userInputDeferred, setUserInputDeferred] = React.useState(false);
  const [uiQuestionIndex, setUiQuestionIndex] = React.useState(0);
  const [uiOptionIndex, setUiOptionIndex] = React.useState(0);
  const [uiSelections, setUiSelections] = React.useState<Record<string, string[]>>({});
  // A free-text answer typed into the composer while a question is pending (the
  // web's "Type your own answer, or leave blank to use the selected option").
  const [customAnswer, setCustomAnswer] = React.useState("");
  const [reply, setReply] = React.useState("");
  // Bumped to remount (clear) the uncontrolled multiline reply editor.
  const [composerEpoch, setComposerEpoch] = React.useState(0);
  const [draft, setDraft] = React.useState("");
  const [renameDraft, setRenameDraft] = React.useState("");
  // The commit-message dialog: the draft + which commit-bearing action to run on submit.
  const [commitDraft, setCommitDraft] = React.useState("");
  const [pendingCommitAction, setPendingCommitAction] =
    React.useState<GitStackedAction | null>(null);
  const [projectIndex, setProjectIndex] = React.useState(0);
  // Options for the new-thread dialog (^O cycles runtime, ^B toggles plan/build).
  const [newRuntimeMode, setNewRuntimeMode] = React.useState<RuntimeMode>("full-access");
  const [newInteractionMode, setNewInteractionMode] =
    React.useState<ProviderInteractionMode>("default");
  const [newBranch, setNewBranch] = React.useState("");
  const [newWorktree, setNewWorktree] = React.useState("");
  // Which text field the new-thread dialog is editing (Tab cycles).
  const [newField, setNewField] = React.useState<"message" | "branch" | "worktree">("message");
  // Which pending approval ^A/^R act on; ↑/↓ move it while an approval is up.
  const [approvalIndex, setApprovalIndex] = React.useState(0);
  // The right-side source-control panel (^L), auto-hidden on narrow terminals.
  const [rightPanelOpen, setRightPanelOpen] = React.useState(false);
  // User-set prompt height in editor rows; null = auto-grow with content.
  const [promptHeight, setPromptHeight] = React.useState<number | null>(null);
  // Multiple terminals per thread (the TUI form of the web's terminal groups):
  // each thread keeps a list of client-chosen terminal ids + the active one; the
  // drawer shows the selected thread's active terminal with a tab bar.
  const [terminalOpen, setTerminalOpen] = React.useState(false);
  const [terminalTabs, setTerminalTabs] = React.useState<ReadonlyMap<string, ThreadTabs>>(
    () => new Map(),
  );
  // The terminal drawer coexists with the prompt; this tracks which one keystrokes go to.
  const [terminalFocused, setTerminalFocused] = React.useState(false);
  // User-set terminal-drawer height in rows; null = the default proportion.
  const [terminalHeight, setTerminalHeight] = React.useState<number | null>(null);
  const [listWidth] = React.useState(LIST_PANE_WIDTH);
  const scrollRef = React.useRef<ScrollBoxRenderable | null>(null);
  // Filled by the terminal drawer with a getter for its viewport text (for ^O copy).
  const terminalCopyRef = React.useRef<(() => string) | null>(null);

  const projects = state.shell?.projects ?? [];
  // projectIndex is held across shell updates; clamp it so a shrinking project
  // list can't leave it pointing past the end (projects[projectIndex] = undefined).
  const activeProjectIndex = projects.length > 0 ? Math.min(projectIndex, projects.length - 1) : 0;
  const selectedThreadId = state.selection?.kind === "thread" ? state.selection.id : null;
  const rows = React.useMemo(
    () => buildRows(state.shell, state.expanded, state.loadedInFull, selectedThreadId, state.filter),
    [state.shell, state.expanded, state.loadedInFull, selectedThreadId, state.filter],
  );
  const detail = state.detail;
  // The selected thread's terminal tabs + the single active terminal the drawer
  // renders (derived so the existing single-terminal usages keep working).
  const terminalCwd = detail
    ? (detail.worktreePath ??
      projects.find((p) => p.id === detail.projectId)?.workspaceRoot ??
      process.cwd())
    : process.cwd();
  const detailTabs = detail ? (terminalTabs.get(detail.id) ?? null) : null;
  const activeTerminal: TerminalInfo | null =
    terminalOpen && detail && detailTabs
      ? {
          threadId: detail.id,
          terminalId: detailTabs.activeId,
          title: detail.title,
          cwd: terminalCwd,
          worktreePath: detail.worktreePath,
        }
      : null;
  const controls = composerControls(detail);
  // The agent is actively running a turn — show the red stop affordance (mirrors
  // the web composer swapping its send button for a stop button while running).
  const working = !!detail && isWorking(detail);

  const detailId = detail?.id ?? null;
  React.useEffect(() => {
    // Terminal focus is global but tabs are per-thread: dropping focus on a
    // thread switch stops keystrokes routing to whichever shell the new thread
    // happens to have, until the user re-focuses it (^P) explicitly.
    setTerminalFocused(false);
  }, [detailId]);
  const actionablePlan = React.useMemo(
    () => (detail ? latestActionableProposedPlan(detail) : null),
    [detail],
  );
  const checkpoints = React.useMemo(
    () => (detail ? revertableCheckpoints(detail.checkpoints) : []),
    [detail],
  );
  // Diff viewer entries: index 0 = "all changes" (the cumulative full-thread diff,
  // matching the web's default), 1..N = the per-turn checkpoint diffs.
  const diffEntryCount = checkpoints.length + 1;
  const latestTurnCount = checkpoints.reduce(
    (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
    0,
  );
  const diffCheckpoint =
    diffOpen && diffIndex > 0 ? checkpoints[Math.min(diffIndex - 1, checkpoints.length - 1)] : null;
  const diffScopeLabel =
    diffIndex === 0 ? "all changes" : `turn ${diffCheckpoint?.checkpointTurnCount ?? "?"}`;
  // Fetch the selected scope's diff whenever the viewer opens or the selection changes.
  const diffSelectedTurnCount = diffCheckpoint?.checkpointTurnCount ?? null;
  React.useEffect(() => {
    if (!diffOpen || !detail) return;
    const fetchDiff =
      diffIndex === 0
        ? client.getFullThreadDiff(detail.id, latestTurnCount)
        : diffSelectedTurnCount !== null
          ? client.getTurnDiff(detail.id, diffSelectedTurnCount)
          : null;
    if (!fetchDiff) return;
    let cancelled = false;
    setDiffStatus("loading");
    setDiffText("");
    void fetchDiff
      .then((diff) => {
        if (cancelled) return;
        setDiffText(diff);
        setDiffStatus(diff.trim().length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (!cancelled) setDiffStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [client, diffOpen, detail?.id, diffIndex, diffSelectedTurnCount, latestTurnCount]);

  // Open the diff viewer scoped to a specific turn (clicking a changed-files row).
  const openDiffAtTurn = (turnCount: number, filePath?: string) => {
    const index = checkpoints.findIndex(
      (checkpoint) => checkpoint.checkpointTurnCount === turnCount,
    );
    setOverlay("none");
    setDiffIndex(index >= 0 ? index + 1 : 0);
    setDiffFocusPath(filePath ?? null);
    setDiffOpen(true);
  };

  const togglePlanMode = () => {
    if (!detail) return;
    const next = detail.interactionMode === "plan" ? "default" : "plan";
    void client.setInteractionMode(detail.id, next).catch(() => {});
    store.setStatus(next === "plan" ? "Plan mode." : "Build mode.", "success");
  };

  // Right-panel git actions: commit-bearing ones open the commit-message dialog
  // first, then run with the typed message; the rest run immediately. When there
  // is nothing to commit, drop the commit step (don't prompt for a message on a
  // pure push) — run the push/PR part, or hint for a bare "commit".
  const onRunGitAction = (action: GitStackedAction) => {
    if (gitActionNeedsCommitMessage(action)) {
      if (!state.vcsStatus?.hasWorkingTreeChanges) {
        if (action === "commit_push") store.runGitAction("push");
        else if (action === "commit_push_pr") store.runGitAction("create_pr");
        else store.setStatus("Nothing to commit.");
        return;
      }
      setPendingCommitAction(action);
      setCommitDraft("");
      setFocus("commit");
      return;
    }
    store.runGitAction(action);
  };

  const openNewThread = () => {
    setProjectIndex(0);
    setNewRuntimeMode(detail?.runtimeMode ?? "full-access");
    setNewInteractionMode("default");
    setNewBranch("");
    setNewWorktree("");
    setNewField("message");
    setFocus("new");
  };

  const implementPlan = () => {
    if (!detail || !actionablePlan) return;
    void client
      .implementPlan(detail, actionablePlan.id)
      .catch((error) => store.setStatus(`implement failed: ${String(error)}`, "error"));
    store.setStatus("Implementing plan…", "busy");
  };

  // Interrupt the running turn — the red stop button and Esc both call this.
  const stopTurn = () => {
    if (!detail) return;
    void client.interrupt(detail.id).catch(() => {});
    store.setStatus("Interrupt sent.", "success");
  };

  const openRuntimePicker = () => {
    if (!detail) return;
    setPicker({
      kind: "runtime",
      title: "access",
      status: "ready",
      options: RUNTIME_MODES.map((mode) => ({
        name: RUNTIME_MODE_META[mode].label,
        description: RUNTIME_MODE_META[mode].description,
        value: mode,
      })),
      selectedIndex: Math.max(0, RUNTIME_MODES.indexOf(detail.runtimeMode)),
    });
  };

  const openModelPicker = () => {
    if (!detail) return;
    setPicker({ kind: "model", title: "model", status: "loading", options: [], selectedIndex: 0 });
    void client
      .listModels()
      .then((models) =>
        setPicker((current) => {
          if (!current || current.kind !== "model") return current;
          return {
            ...current,
            status: models.length > 0 ? "ready" : "empty",
            options: models.map((model) => ({
              name: model.label,
              description: model.providerLabel,
              value: `${model.instanceId} ${model.model}`,
            })),
            selectedIndex: currentModelIndex(models, detail.modelSelection ?? null),
          };
        }),
      )
      .catch(() =>
        setPicker((current) =>
          current && current.kind === "model" ? { ...current, status: "error" } : current,
        ),
      );
  };

  const openReasoningPicker = () => {
    const selection = detail?.modelSelection;
    if (!detail || !selection) {
      store.setStatus("Select a model first.", "info");
      return;
    }
    setPicker({ kind: "reasoning", title: "reasoning", status: "loading", options: [], selectedIndex: 0 });
    void client
      .getReasoningChoices(selection.instanceId, selection.model)
      .then((result) =>
        setPicker((current) => {
          if (!current || current.kind !== "reasoning") return current;
          if (!result || result.choices.length === 0) return { ...current, status: "empty" };
          const currentEffort = getReasoningEffort(selection);
          return {
            ...current,
            status: "ready",
            options: result.choices.map((choice) => ({
              name: choice.label,
              description: choice.description ?? result.descriptorId,
              value: `${result.descriptorId} ${choice.id}`,
            })),
            selectedIndex: Math.max(
              0,
              result.choices.findIndex((choice) => choice.id === currentEffort),
            ),
          };
        }),
      )
      .catch(() =>
        setPicker((current) =>
          current && current.kind === "reasoning" ? { ...current, status: "error" } : current,
        ),
      );
  };

  const movePicker = (delta: number) =>
    setPicker((current) => {
      if (!current || current.options.length === 0) return current;
      const count = current.options.length;
      return { ...current, selectedIndex: (current.selectedIndex + delta + count) % count };
    });

  const applyPicker = (index: number) => {
    const current = picker;
    setPicker(null);
    if (!current || !detail) return;
    const option = current.options[index];
    const value = typeof option?.value === "string" ? option.value : null;
    const kind = current.kind;
    if (!value) return;
    if (kind === "runtime") {
      const mode = value as RuntimeMode;
      void client
        .setRuntimeMode(detail.id, mode)
        .catch((error) => store.setStatus(`access change failed: ${String(error)}`, "error"));
      store.setStatus(`Access → ${runtimeModeLabel(mode)}`, "success");
    } else if (kind === "model") {
      const [instanceId, model] = value.split(" ");
      if (instanceId && model) {
        void client
          .setModel(detail.id, instanceId, model)
          .catch((error) => store.setStatus(`model change failed: ${String(error)}`, "error"));
        store.setStatus(`Model → ${model}`, "success");
      }
    } else if (kind === "reasoning") {
      const [descriptorId, choiceId] = value.split(" ");
      if (descriptorId && choiceId) {
        void client
          .setReasoning(detail, descriptorId, choiceId)
          .catch((error) => store.setStatus(`reasoning change failed: ${String(error)}`, "error"));
        store.setStatus(`Reasoning → ${choiceId}`, "success");
      }
    }
  };

  const pendingUserInput = React.useMemo(
    () => (detail ? (derivePendingUserInputs(detail.activities)[0] ?? null) : null),
    [detail],
  );
  // Reset the answer draft whenever a different request comes in (or it clears).
  const pendingRequestId = pendingUserInput?.requestId ?? null;
  React.useEffect(() => {
    setUserInputDeferred(false);
    setUiQuestionIndex(0);
    setUiOptionIndex(0);
    setUiSelections({});
    setCustomAnswer("");
  }, [pendingRequestId]);
  const userInputActive = pendingUserInput !== null && !userInputDeferred;
  const uiQuestion = pendingUserInput?.questions[uiQuestionIndex] ?? null;
  const uiSelectedLabels = uiQuestion ? (uiSelections[uiQuestion.id] ?? []) : [];
  const approvals = React.useMemo(
    () => (detail ? derivePendingApprovals(detail.activities) : []),
    [detail],
  );
  // Held across re-derivations; clamp so a shrinking queue can't point past the end.
  const activeApprovalIndex =
    approvals.length > 0 ? Math.min(approvalIndex, approvals.length - 1) : 0;
  const selectedProjectTitle =
    state.selection?.kind === "project"
      ? (projects.find((project) => project.id === state.selection?.id)?.title ?? null)
      : null;

  // Deterministic viewport heights. The terminal drawer (when open) and the
  // composer are both shown, so the top panes shrink to fit both. The reply editor
  // auto-grows with its line count (up to a cap), or uses a height the user set
  // with ^↑/^↓; content beyond that scrolls within the editor.
  const maxPromptLines = Math.max(3, Math.floor(height * 0.6));
  const autoPromptLines = Math.min(Math.max(reply.split("\n").length, 1), 8);
  const promptLines = Math.min(promptHeight ?? autoPromptLines, maxPromptLines);
  // A popover (picker / palette / revert / confirm) floats ABOVE the composer,
  // which stays visible (unfocused, compact) below — mirroring the web, where a
  // dropdown opens over the still-present composer rather than replacing it.
  const popoverOpen =
    !!picker || overlay === "command" || overlay === "revert" || overlay === "confirmDelete";
  // A pending question renders a panel inside the composer (header + question +
  // options + hint + spacer), so the composer grows to fit it.
  const pendingPanelHeight =
    userInputActive && uiQuestion ? uiQuestion.options.length + 4 : 0;
  const composerHeight =
    focus === "new"
      ? 9
      : focus === "rename" || focus === "filter" || focus === "commit"
        ? 5
        : popoverOpen
          ? 5 // compact: a one-line static input + the footer, under the popover
          : promptLines + 4 + pendingPanelHeight;
  const defaultTerminalHeight = Math.floor(height * 0.4);
  const maxTerminalHeight = Math.max(6, height - composerHeight - 6);
  const terminalDrawerHeight = activeTerminal
    ? Math.min(Math.max(terminalHeight ?? defaultTerminalHeight, 6), maxTerminalHeight)
    : 0;
  // Each popover grows UP into the space above (the panes shrink) instead of
  // overflowing off-screen; capped so the panes keep at least a few rows.
  const pickerWanted = picker ? Math.max(picker.options.length, 1) * 2 + 3 : 0;
  const commandWanted = overlay === "command" ? Math.floor(height * 0.5) : 0;
  const revertWanted = overlay === "revert" ? Math.min(checkpoints.length, 8) + 3 : 0;
  const confirmWanted = overlay === "confirmDelete" ? 4 : 0;
  const popoverCap = Math.max(0, height - terminalDrawerHeight - composerHeight - 6);
  const popoverHeight = Math.min(
    pickerWanted + commandWanted + revertWanted + confirmWanted,
    popoverCap,
  );
  const pickerContentRows = Math.max(2, popoverHeight - 3);
  const bottomReserve = terminalDrawerHeight + popoverHeight + composerHeight + 1;
  const panesHeight = Math.max(4, height - bottomReserve);
  const listViewport = Math.max(1, panesHeight - 3);
  const termCols = Math.max(2, width - 4);
  // header + tab bar + frame + border(2) = frame rows + 4.
  const termRows = Math.max(2, terminalDrawerHeight - 4);
  const rightPanelVisible =
    rightPanelOpen &&
    width >= RIGHT_PANEL_MIN_TERMINAL_WIDTH &&
    !diffOpen &&
    !filesOpen &&
    !settingsOpen;
  const rightWidth = rightPanelVisible ? RIGHT_PANEL_WIDTH : 0;
  const chatWidth = Math.max(20, width - listWidth - rightWidth - 4);

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

  const clearReply = () => {
    setReply("");
    setComposerEpoch((epoch) => epoch + 1);
  };

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
      .catch((error) => store.setStatus(`send failed: ${String(error)}`, "error"));
    store.setStatus("Reply sent.", "success");
    clearReply();
  };

  // Submit the active pending question (Enter, or the composer's Submit-answer
  // action): advance to the next question, or respond when it's the last.
  const submitUserInput = () => {
    if (!detail || !pendingUserInput || !uiQuestion) return;
    // A typed custom answer wins; otherwise a single-select Enter picks the
    // highlighted option.
    const custom = customAnswer.trim();
    let selections = uiSelections;
    if (!uiQuestion.multiSelect && custom.length > 0) {
      selections = { ...uiSelections, [uiQuestion.id]: [custom] };
    } else if (!uiQuestion.multiSelect) {
      const option = uiQuestion.options[uiOptionIndex];
      if (option) selections = { ...uiSelections, [uiQuestion.id]: [option.label] };
    }
    if ((selections[uiQuestion.id]?.length ?? 0) === 0) {
      store.setStatus("Pick an option or type an answer first.");
      return;
    }
    setCustomAnswer("");
    const isLast = uiQuestionIndex >= pendingUserInput.questions.length - 1;
    if (!isLast) {
      setUiSelections(selections);
      setUiQuestionIndex((index) => index + 1);
      setUiOptionIndex(0);
      return;
    }
    const answers = buildUserInputAnswers(pendingUserInput.questions, selections);
    void client
      .respondUserInput(detail.id, pendingUserInput.requestId, answers)
      .catch((error) => store.setStatus(`answer failed: ${String(error)}`, "error"));
    store.setStatus("Answer sent.", "success");
    setUiSelections({});
    setUiQuestionIndex(0);
    setUiOptionIndex(0);
  };

  const submitNewThread = () => {
    const project = projects[activeProjectIndex];
    const message = draft.trim();
    // Keep the dialog open (and the typed message) when the project can't accept
    // it yet, so the user doesn't lose what they wrote.
    if (project && message.length > 0 && !project.defaultModelSelection) {
      store.setStatus("Project has no default model — set one in the web UI first.");
      return;
    }
    if (project && message.length > 0 && project.defaultModelSelection) {
      void client
        .createThread({
          projectId: project.id,
          title: message.slice(0, 60),
          modelSelection: project.defaultModelSelection,
          firstMessage: message,
          runtimeMode: newRuntimeMode,
          interactionMode: newInteractionMode,
          branch: newBranch,
          worktreePath: newWorktree,
        })
        .catch((error) => store.setStatus(`create failed: ${String(error)}`, "error"));
      store.setStatus("Creating thread…", "busy");
    }
    setDraft("");
    setNewBranch("");
    setNewWorktree("");
    setNewField("message");
    setFocus("compose");
  };

  // Update one thread's tabs from the LATEST map (functional, so rapid tab ops
  // — fast key-repeat close/cycle — serialize correctly instead of each reading
  // the same render-captured snapshot). The updater returns the same map to
  // no-op when the thread/id is gone.
  const updateThreadTabs = (
    threadId: string,
    update: (tabs: ThreadTabs | null) => ThreadTabs | null,
  ) =>
    setTerminalTabs((prev) => {
      const nextTabs = update(prev.get(threadId) ?? null);
      if (nextTabs === (prev.get(threadId) ?? null)) return prev;
      const next = new Map(prev);
      if (nextTabs) next.set(threadId, nextTabs);
      else next.delete(threadId);
      return next;
    });

  // ^E shows/hides the drawer (opening focuses it); ^P flips focus between the
  // prompt and the terminal. Opening seeds a default terminal tab for the thread.
  const toggleTerminal = () => {
    if (terminalOpen) {
      setTerminalOpen(false);
      setTerminalFocused(false);
      return;
    }
    if (!detail) return;
    updateThreadTabs(detail.id, (tabs) => tabs ?? initialTabs());
    setTerminalOpen(true);
    setTerminalFocused(true);
  };

  // Open a fresh terminal tab on the selected thread (server creates it on attach).
  const newTerminal = () => {
    if (!detail) return;
    setTerminalOpen(true);
    setTerminalFocused(true);
    updateThreadTabs(detail.id, (tabs) => {
      if ((tabs?.ids.length ?? 0) >= MAX_TERMINALS_PER_THREAD) {
        store.setStatus(`At most ${MAX_TERMINALS_PER_THREAD} terminals per thread.`);
        return tabs; // surface the existing terminals without adding another.
      }
      return addTab(tabs);
    });
  };

  const selectTerminal = (id: string) => {
    if (!detail) return;
    updateThreadTabs(detail.id, (tabs) =>
      tabs && tabs.ids.includes(id) ? { ids: tabs.ids, activeId: id } : tabs,
    );
    setTerminalFocused(true);
  };

  const cycleTerminal = (delta: 1 | -1) => {
    if (!detail) return;
    updateThreadTabs(detail.id, (tabs) =>
      tabs ? { ids: tabs.ids, activeId: cycleActiveId(tabs, delta) } : tabs,
    );
    setTerminalFocused(true);
  };

  // Close a terminal tab: free its server session, drop it, and fall back to a
  // neighbour (or close the drawer when it was the last one).
  const closeTerminal = (id: string) => {
    if (!detail) return;
    void client.terminalClose(detail.id, id).catch(() => {});
    const willBeEmpty = (detailTabs?.ids.length ?? 0) <= 1;
    updateThreadTabs(detail.id, (tabs) =>
      tabs && tabs.ids.includes(id) ? closeTab(tabs, id) : tabs,
    );
    if (willBeEmpty) {
      setTerminalOpen(false);
      setTerminalFocused(false);
    }
  };

  // ── Workspace file browser ─────────────────────────────────────────────────
  // The flattened, collapse-aware tree built from the file entries (dirs inferred
  // from paths; reuses the changed-files tree machinery).
  const fileRows = React.useMemo(
    () =>
      flattenFileTree(
        buildFileTree(
          fileEntries
            .filter((entry) => entry.kind === "file")
            .map((entry) => ({ path: entry.path, additions: 0, deletions: 0 })),
        ),
        filesCollapsedDirs,
      ),
    [fileEntries, filesCollapsedDirs],
  );

  const openFiles = () => {
    setFilesOpen(true);
    setViewingFile(null);
    setFilesIndex(0);
    setFilesCollapsedDirs(new Set());
    setFilesStatus("loading");
    setFileEntries([]);
    void client
      .listEntries(terminalCwd)
      .then((entries) => {
        setFileEntries(entries);
        setFilesStatus(entries.length === 0 ? "empty" : "ready");
      })
      .catch(() => setFilesStatus("error"));
  };
  const closeFiles = () => {
    setFilesOpen(false);
    setViewingFile(null);
  };
  const filesScroll = (dir: 1 | -1) =>
    filesScrollRef.current?.scrollBy({ x: 0, y: dir * SCROLL_STEP });
  const filesMove = (delta: 1 | -1) => {
    if (viewingFile) {
      filesScroll(delta);
      return;
    }
    setFilesIndex((index) => Math.min(Math.max(0, index + delta), Math.max(0, fileRows.length - 1)));
  };
  const filesActivate = () => {
    if (viewingFile) return;
    const row = fileRows[filesIndex];
    if (!row) return;
    if (row.kind === "dir") {
      setFilesCollapsedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(row.path)) next.delete(row.path);
        else next.add(row.path);
        return next;
      });
      return;
    }
    setViewingFile({ path: row.path, status: "loading", content: "" });
    void client
      .readFile(terminalCwd, row.path)
      .then((content) =>
        setViewingFile(
          content === null
            ? { path: row.path, status: "error", content: "" }
            : { path: row.path, status: "ready", content },
        ),
      )
      .catch(() => setViewingFile({ path: row.path, status: "error", content: "" }));
  };
  const filesBack = () => {
    if (viewingFile) setViewingFile(null);
    else closeFiles();
  };

  const toggleFocus = () => {
    if (activeTerminal) setTerminalFocused((focused) => !focused);
  };

  const resizeTerminal = (delta: number) => {
    if (!activeTerminal) return;
    setTerminalHeight((current) =>
      Math.min(Math.max((current ?? defaultTerminalHeight) + delta, 6), maxTerminalHeight),
    );
  };

  const resizePrompt = (delta: number) => {
    setPromptHeight((current) =>
      Math.min(Math.max((current ?? autoPromptLines) + delta, 1), maxPromptLines),
    );
  };

  // ^G: edit the current draft in $EDITOR. Release the terminal (suspend), run the
  // editor on a temp file, then read it back into the prompt and re-take the screen.
  const editInEditor = () => {
    if (terminalFocused) return;
    const draftText = reply;
    void (async () => {
      let dir: string | null = null;
      try {
        dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-prompt-"));
        const file = NodePath.join(dir, "prompt.md");
        await NodeFSP.writeFile(file, draftText, "utf8");
        const { cmd, args } = resolveEditorCommand({
          VISUAL: process.env.VISUAL,
          EDITOR: process.env.EDITOR,
        });
        renderer.suspend();
        try {
          await new Promise<void>((resolve) => {
            const child = NodeChildProcess.spawn(cmd, [...args, file], { stdio: "inherit" });
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
          });
        } finally {
          renderer.resume();
        }
        const edited = normalizeEditedPrompt(await NodeFSP.readFile(file, "utf8"));
        setReply(edited);
        setComposerEpoch((epoch) => epoch + 1);
        store.setStatus("Prompt updated from $EDITOR.", "success");
      } catch {
        store.setStatus("Could not open $EDITOR.", "error");
      } finally {
        if (dir) await NodeFSP.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    })();
  };

  // Run a palette command: close the palette, then perform the action (the action
  // may open its own sub-overlay, e.g. delete → confirm, which wins over "none").
  const runCommand = (action: () => void) => {
    setOverlay("none");
    action();
  };

  // The command palette's command list, built from current context + handlers
  // (mirrors the web CommandPalette). ChatView owns the handlers, so commands are
  // assembled here and fuzzy-filtered by commandQuery.
  const paletteCommands = React.useMemo<Command[]>(() => {
    const list: Command[] = [];
    list.push({ id: "new", title: "New thread", hint: "^N", run: () => runCommand(openNewThread) });
    if (detail) {
      list.push({
        id: "plan",
        title: detail.interactionMode === "plan" ? "Switch to build mode" : "Switch to plan mode",
        hint: "^B",
        keywords: "interaction mode",
        run: () => runCommand(togglePlanMode),
      });
      list.push({
        id: "rename",
        title: "Rename thread",
        run: () =>
          runCommand(() => {
            setRenameDraft(detail.title);
            setFocus("rename");
          }),
      });
      list.push({
        id: "archive",
        title: detail.archivedAt ? "Unarchive thread" : "Archive thread",
        run: () =>
          runCommand(() => {
            const archived = detail.archivedAt !== null;
            void (archived
              ? client.unarchiveThread(detail.id)
              : client.archiveThread(detail.id)
            ).catch(() => {});
            store.setStatus(archived ? "Unarchived." : "Archived.", "success");
          }),
      });
      list.push({
        id: "delete",
        title: "Delete thread",
        run: () => runCommand(() => setOverlay("confirmDelete")),
      });
      list.push({
        id: "stop",
        title: "Stop session",
        run: () =>
          runCommand(() => {
            void client.stopSession(detail.id).catch(() => {});
            store.setStatus("Session stopped.", "success");
          }),
      });
      if (checkpoints.length > 0) {
        list.push({
          id: "diff",
          title: "View all changes",
          keywords: "diff",
          run: () =>
            runCommand(() => {
              setDiffFocusPath(null);
              setDiffIndex(0);
              setDiffOpen(true);
            }),
        });
        list.push({
          id: "revert",
          title: "Revert to checkpoint…",
          run: () =>
            runCommand(() => {
              setRevertIndex(0);
              setOverlay("revert");
            }),
        });
      }
      list.push({ id: "model", title: "Change model", run: () => runCommand(openModelPicker) });
      list.push({
        id: "reasoning",
        title: "Change reasoning effort",
        run: () => runCommand(openReasoningPicker),
      });
      list.push({
        id: "runtime",
        title: "Change runtime access",
        hint: "^O",
        run: () => runCommand(openRuntimePicker),
      });
      if (actionablePlan) {
        list.push({ id: "implement", title: "Implement plan", hint: "^Y", run: () => runCommand(implementPlan) });
      }
    }
    list.push({
      id: "terminal",
      title: activeTerminal ? "Hide terminal" : "Show terminal",
      hint: "^E",
      run: () => runCommand(toggleTerminal),
    });
    if (detail) {
      list.push({ id: "terminal-new", title: "New terminal", keywords: "shell group tab", run: () => runCommand(newTerminal) });
    }
    if (detailTabs && detailTabs.ids.length > 1) {
      list.push({ id: "terminal-next", title: "Next terminal", keywords: "tab", run: () => runCommand(() => cycleTerminal(1)) });
      list.push({ id: "terminal-prev", title: "Previous terminal", keywords: "tab", run: () => runCommand(() => cycleTerminal(-1)) });
    }
    if (terminalOpen && detailTabs) {
      list.push({
        id: "terminal-close",
        title: "Close terminal",
        keywords: "tab",
        run: () => runCommand(() => closeTerminal(detailTabs.activeId)),
      });
    }
    list.push({
      id: "panel",
      title: rightPanelOpen ? "Hide source-control panel" : "Show source-control panel",
      hint: "^L",
      keywords: "git",
      run: () => runCommand(() => setRightPanelOpen((open) => !open)),
    });
    list.push({
      id: "filter",
      title: "Filter threads",
      hint: "^F",
      keywords: "search",
      run: () => runCommand(() => setFocus("filter")),
    });
    if (detail) {
      list.push({
        id: "files",
        title: "Browse files",
        keywords: "workspace open file",
        run: () => runCommand(openFiles),
      });
    }
    list.push({
      id: "settings",
      title: "Settings",
      keywords: "keybindings reference help providers",
      run: () => runCommand(() => setSettingsOpen(true)),
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, checkpoints.length, activeTerminal, detailTabs, terminalOpen, rightPanelOpen, actionablePlan]);

  const filteredCommands = React.useMemo(
    () => filterCommands(paletteCommands, commandQuery),
    [paletteCommands, commandQuery],
  );
  // Clamp at use: the command list can shrink while the palette is open (a turn
  // finishes, a tab closes), which would otherwise leave commandIndex past the
  // end — no highlight, Enter no-ops.
  const safeCommandIndex = Math.min(commandIndex, Math.max(0, filteredCommands.length - 1));

  const keyMode =
    activeTerminal && terminalFocused
      ? "terminal"
      : settingsOpen
        ? "settings"
        : filesOpen
        ? "files"
        : diffOpen
        ? "diff"
        : picker
          ? "select"
          : overlay === "command"
        ? "command"
        : overlay === "confirmDelete"
          ? "confirmDelete"
          : overlay === "revert"
            ? "revert"
            : focus === "new"
            ? "new"
            : focus === "rename"
              ? "rename"
              : focus === "filter"
                ? "filter"
                : focus === "commit"
                  ? "commit"
                  : userInputActive
                    ? "userInput"
                    : "compose";

  useKeyBindings({
    mode: keyMode,
    onExit,
    onTerminalKey: (sequence) => {
      if (activeTerminal) {
        void client
          .terminalWrite(activeTerminal.threadId, activeTerminal.terminalId, sequence)
          .catch(() => {});
      }
    },
    onToggleFocus: toggleFocus,
    onCancelNew: () => {
      setDraft("");
      setNewBranch("");
      setNewWorktree("");
      setNewField("message");
      setFocus("compose");
    },
    onProjectPrev: () =>
      setProjectIndex((index) => (index > 0 ? index - 1 : Math.max(projects.length - 1, 0))),
    onProjectNext: () => setProjectIndex((index) => (index + 1) % Math.max(projects.length, 1)),
    onNewCycleRuntime: () =>
      setNewRuntimeMode((mode) => {
        const current = RUNTIME_MODES.indexOf(mode);
        return RUNTIME_MODES[(current + 1) % RUNTIME_MODES.length] ?? "full-access";
      }),
    onNewTogglePlan: () =>
      setNewInteractionMode((mode) => (mode === "plan" ? "default" : "plan")),
    onNewCycleField: () =>
      setNewField((field) =>
        field === "message" ? "branch" : field === "branch" ? "worktree" : "message",
      ),
    onSubmitNew: submitNewThread,
    // ↑/↓ move the approval cursor while a pending approval is up (and the reply is
    // empty), otherwise navigate the sidebar — yielding to a multiline reply editor
    // so the cursor can move vertically within the prompt.
    onNavUp: () => {
      if (approvals.length > 1 && reply.length === 0) {
        setApprovalIndex((index) => (index <= 0 ? approvals.length - 1 : index - 1));
        return;
      }
      if (reply.includes("\n")) return;
      store.moveSelection(-1);
    },
    onNavDown: () => {
      if (approvals.length > 1 && reply.length === 0) {
        setApprovalIndex((index) => (index + 1) % approvals.length);
        return;
      }
      if (reply.includes("\n")) return;
      store.moveSelection(1);
    },
    onScrollUp: () => scrollRef.current?.scrollBy({ x: 0, y: -SCROLL_STEP }),
    onScrollDown: () => scrollRef.current?.scrollBy({ x: 0, y: SCROLL_STEP }),
    onNewThread: openNewThread,
    onToggleTerminal: toggleTerminal,
    onGrowTerminal: () => resizeTerminal(2),
    onShrinkTerminal: () => resizeTerminal(-2),
    onTerminalCopy: () => {
      const text = terminalCopyRef.current?.() ?? "";
      if (text.length === 0) {
        store.setStatus("Terminal is empty.", "info");
        return;
      }
      renderer.copyToClipboardOSC52(text);
      const supported = renderer.isOsc52Supported();
      store.setStatus(
        supported ? "Terminal copied to clipboard." : "Clipboard not supported by this terminal.",
        supported ? "success" : "error",
      );
    },
    onGrowPrompt: () => resizePrompt(2),
    onShrinkPrompt: () => resizePrompt(-2),
    onEditInEditor: editInEditor,
    onTogglePlanMode: togglePlanMode,
    onToggleRightPanel: () => setRightPanelOpen((open) => !open),
    onThreadPrev: () => store.moveThreadSelection(-1),
    onThreadNext: () => store.moveThreadSelection(1),
    onThreadJump: (index) => store.selectThreadByIndex(index),
    onImplementPlan: implementPlan,
    onOpenCommandPalette: () => {
      setCommandQuery("");
      setCommandIndex(0);
      setOverlay("command");
    },
    onCommandPrev: () =>
      setCommandIndex((index) =>
        filteredCommands.length === 0 ? 0 : (index - 1 + filteredCommands.length) % filteredCommands.length,
      ),
    onCommandNext: () =>
      setCommandIndex((index) =>
        filteredCommands.length === 0 ? 0 : (index + 1) % filteredCommands.length,
      ),
    onCommandRun: () => filteredCommands[safeCommandIndex]?.run(),
    onCommandClose: () => setOverlay("none"),
    onFilesUp: () => filesMove(-1),
    onFilesDown: () => filesMove(1),
    onFilesActivate: filesActivate,
    onFilesBack: filesBack,
    onFilesScrollUp: () => filesScroll(-1),
    onFilesScrollDown: () => filesScroll(1),
    onSettingsScrollUp: () => settingsScrollRef.current?.scrollBy({ x: 0, y: -SCROLL_STEP }),
    onSettingsScrollDown: () => settingsScrollRef.current?.scrollBy({ x: 0, y: SCROLL_STEP }),
    onSettingsClose: () => setSettingsOpen(false),
    onRevertPrev: () =>
      setRevertIndex((index) => (index <= 0 ? checkpoints.length - 1 : index - 1)),
    onRevertNext: () => setRevertIndex((index) => (index + 1) % Math.max(checkpoints.length, 1)),
    onRevertConfirm: () => {
      const checkpoint = checkpoints[Math.min(revertIndex, checkpoints.length - 1)];
      setOverlay("none");
      if (!detail || !checkpoint) return;
      void client
        .revertCheckpoint(detail.id, checkpoint.checkpointTurnCount)
        .catch((error) => store.setStatus(`revert failed: ${String(error)}`, "error"));
      store.setStatus(`Reverted to turn ${checkpoint.checkpointTurnCount}.`, "success");
    },
    onUserInputPrev: () => {
      const count = uiQuestion?.options.length ?? 0;
      if (count === 0) return;
      setUiOptionIndex((index) => (index <= 0 ? count - 1 : index - 1));
    },
    onUserInputNext: () => {
      const count = uiQuestion?.options.length ?? 0;
      if (count === 0) return;
      setUiOptionIndex((index) => (index + 1) % count);
    },
    answerTyping: userInputActive && uiQuestion !== null && !uiQuestion.multiSelect,
    onUserInputToggle: () => {
      if (!uiQuestion) return;
      const option = uiQuestion.options[uiOptionIndex];
      if (!option) return;
      setUiSelections((prev) => {
        const current = prev[uiQuestion.id] ?? [];
        if (uiQuestion.multiSelect) {
          const next = current.includes(option.label)
            ? current.filter((label) => label !== option.label)
            : [...current, option.label];
          return { ...prev, [uiQuestion.id]: next };
        }
        return { ...prev, [uiQuestion.id]: [option.label] };
      });
    },
    onUserInputConfirm: submitUserInput,
    onUserInputDefer: () => setUserInputDeferred(true),
    onReopenUserInput: () => {
      if (pendingUserInput) setUserInputDeferred(false);
    },
    onDiffPrev: () => {
      setDiffFocusPath(null);
      setDiffIndex((index) => (index <= 0 ? diffEntryCount - 1 : index - 1));
    },
    onDiffNext: () => {
      setDiffFocusPath(null);
      setDiffIndex((index) => (index + 1) % Math.max(diffEntryCount, 1));
    },
    onDiffScrollUp: () => diffScrollRef.current?.scrollBy({ x: 0, y: -SCROLL_STEP }),
    onDiffScrollDown: () => diffScrollRef.current?.scrollBy({ x: 0, y: SCROLL_STEP }),
    onDiffToggleView: () => setDiffView((view) => (view === "unified" ? "split" : "unified")),
    onDiffClose: () => setDiffOpen(false),
    onOpenRuntime: openRuntimePicker,
    onSelectPrev: () => movePicker(-1),
    onSelectNext: () => movePicker(1),
    onSelectConfirm: () => {
      if (picker) applyPicker(picker.selectedIndex);
    },
    onCloseSelect: () => setPicker(null),
    onCloseOverlay: () => setOverlay("none"),
    onConfirmDelete: () => {
      if (!detail) {
        setOverlay("none");
        return;
      }
      void client.deleteThread(detail.id).catch(() => {});
      setOverlay("none");
      store.setStatus("Deleted.", "success");
    },
    onSubmitRename: () => {
      const title = renameDraft.trim();
      if (detail && title.length > 0 && title !== detail.title) {
        void client.renameThread(detail.id, title).catch(() => {});
        store.setStatus("Renamed.", "success");
      }
      setRenameDraft("");
      setFocus("compose");
    },
    onCancelRename: () => {
      setRenameDraft("");
      setFocus("compose");
    },
    onOpenFilter: () => setFocus("filter"),
    onCommitFilter: () => setFocus("compose"),
    onCancelFilter: () => {
      store.setFilter("");
      setFocus("compose");
    },
    onSubmitCommit: () => {
      const message = commitDraft.trim();
      const action = pendingCommitAction;
      if (action && message.length > 0) store.runGitAction(action, message);
      setCommitDraft("");
      setPendingCommitAction(null);
      setFocus("compose");
    },
    onCancelCommit: () => {
      setCommitDraft("");
      setPendingCommitAction(null);
      setFocus("compose");
    },
    onInterrupt: stopTurn,
    onApprove: () => {
      const approval = approvals[activeApprovalIndex];
      if (!detail || !approval) return;
      void client.approve(detail.id, approval.requestId, "accept").catch(() => {});
      store.setStatus("Approved.", "success");
    },
    onDecline: () => {
      const approval = approvals[activeApprovalIndex];
      if (!detail || !approval) return;
      void client.approve(detail.id, approval.requestId, "decline").catch(() => {});
      store.setStatus("Declined.", "success");
    },
    onSend: sendReply,
    onEscape: () => {
      if (reply.length > 0) {
        clearReply();
        return;
      }
      stopTurn();
    },
  });

  const placeholder = detail
    ? "Type a reply, Enter to send"
    : state.selection?.kind === "project"
      ? "Enter to expand · ↑/↓ to move"
      : "Select a thread with ↑/↓";

  // Contextual footer: only show keys that apply now (^Y with a plan, ^A/^R with
  // approvals). The persistent state (^B/^O/model/reasoning) lives in the controls
  // row, so it isn't duplicated here.
  const composeHint = [
    "↑/↓",
    "Enter send",
    "^G editor",
    "^↑/^↓ size",
    "^N new",
    "^E term",
    ...(actionablePlan ? ["^Y implement"] : []),
    ...(approvals.length > 0 ? [approvals.length > 1 ? "^A/^R approve (↑/↓)" : "^A/^R approve"] : []),
    "^K commands",
    "^F find",
    ...(width >= RIGHT_PANEL_MIN_TERMINAL_WIDTH ? [`^L panel ${rightPanelOpen ? "▾" : "▸"}`] : []),
    ...(working ? ["Esc stop"] : []),
    "^C quit",
  ].join(" · ");
  const hint =
    pendingUserInput && userInputDeferred
      ? "⚠ question pending — ^U to answer · ^C quit"
      : activeTerminal
        ? "^P prompt · ^E close term · ^↑/^↓ size term · keys → shell"
        : composeHint;

  const statusStyle = statusGlyphColor(state.statusKind);

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
          filter={state.filter}
          searchFocused={focus === "filter" && !terminalFocused && !diffOpen && !picker}
          onSearchInput={store.setFilter}
          onFocusSearch={() => setFocus("filter")}
        />
        {settingsOpen ? (
          <SettingsView
            controls={controls}
            vcsStatus={state.vcsStatus}
            width={chatWidth}
            height={panesHeight}
            scrollRef={settingsScrollRef}
          />
        ) : filesOpen ? (
          <FilesView
            cwdLabel={terminalCwd}
            status={filesStatus}
            rows={fileRows}
            selectedIndex={filesIndex}
            viewing={viewingFile}
            width={chatWidth}
            height={panesHeight}
            syntaxStyle={syntaxStyle}
            scrollRef={filesScrollRef}
          />
        ) : diffOpen ? (
          <DiffViewer
            scopeLabel={diffScopeLabel}
            status={diffStatus}
            diff={diffText}
            view={diffView}
            height={panesHeight}
            syntaxStyle={syntaxStyle}
            scrollRef={diffScrollRef}
            {...(diffFocusPath ? { focusPath: diffFocusPath } : {})}
          />
        ) : (
          <MessagesTimeline
            detail={detail}
            approvals={approvals}
            approvalIndex={activeApprovalIndex}
            projectHint={selectedProjectTitle}
            width={chatWidth}
            height={panesHeight}
            syntaxStyle={syntaxStyle}
            scrollRef={scrollRef}
            onOpenDiff={openDiffAtTurn}
            getAttachmentUrl={client.getAttachmentUrl}
            onOpenUrl={(url) => store.setStatus(url, "info")}
          />
        )}
        {rightPanelVisible ? (
          <RightPanel
            status={state.vcsStatus}
            busy={state.gitBusy}
            width={rightWidth}
            height={panesHeight}
            onRunAction={onRunGitAction}
            onPull={store.pullGit}
            onOpenUrl={(url) => store.setStatus(url, "info")}
          />
        ) : null}
      </box>

      {activeTerminal && detailTabs ? (
        <ThreadTerminalDrawer
          client={client}
          info={activeTerminal}
          cols={termCols}
          rows={termRows}
          focused={terminalFocused}
          copyRef={terminalCopyRef}
          tabIds={detailTabs.ids}
          activeTabId={detailTabs.activeId}
          onSelectTab={selectTerminal}
          onNewTab={newTerminal}
          onCloseTab={closeTerminal}
        />
      ) : null}

      {/* Popovers float ABOVE the still-present composer (mirroring the web's
          dropdowns), rather than replacing it. */}
      {picker ? (
        <SelectOverlay
          title={picker.title}
          status={picker.status}
          options={picker.options}
          selectedIndex={picker.selectedIndex}
          width={width - 4}
          maxRows={pickerContentRows}
          onSelect={(index) => applyPicker(index)}
        />
      ) : overlay === "command" ? (
        <CommandPalette
          commands={filteredCommands}
          selectedIndex={safeCommandIndex}
          query={commandQuery}
          width={width - 4}
          maxRows={Math.max(1, pickerContentRows - 1)}
          onInput={(value) => {
            setCommandQuery(value);
            setCommandIndex(0);
          }}
          onRun={(index) => filteredCommands[index]?.run()}
        />
      ) : overlay === "revert" && detail ? (
        <RevertMenu checkpoints={checkpoints} selected={Math.min(revertIndex, checkpoints.length - 1)} />
      ) : overlay === "confirmDelete" && detail ? (
        <ConfirmDeleteMenu title={detail.title} />
      ) : null}

      <ChatComposer
          // Search/filter now lives in the sidebar; the composer never owns it.
          mode={focus === "filter" ? "compose" : focus}
          reply={reply}
          draft={draft}
          auxValue={focus === "rename" ? renameDraft : focus === "commit" ? commitDraft : ""}
          placeholder={placeholder}
          projectName={projects[activeProjectIndex]?.title ?? "(none)"}
          interactionMode={focus === "new" ? newInteractionMode : (detail?.interactionMode ?? "default")}
          newRuntimeMode={newRuntimeMode}
          newBranch={newBranch}
          newWorktree={newWorktree}
          newField={newField}
          editorRows={promptLines}
          inputFocused={
            !terminalFocused &&
            !diffOpen &&
            !filesOpen &&
            !settingsOpen &&
            !popoverOpen &&
            focus !== "filter"
          }
          composerEpoch={composerEpoch}
          controls={controls}
          working={working}
          width={chatWidth}
          pendingUserInput={userInputActive ? pendingUserInput : null}
          uiQuestionIndex={uiQuestionIndex}
          uiOptionIndex={uiOptionIndex}
          uiSelectedLabels={uiSelectedLabels}
          answerDraft={customAnswer}
          onAnswerInput={setCustomAnswer}
          onReplyInput={setReply}
          onReplySubmit={sendReply}
          onDraftInput={(value) => setDraft(value.replace(/\t/g, ""))}
          onBranchInput={(value) => setNewBranch(value.replace(/\t/g, ""))}
          onWorktreeInput={(value) => setNewWorktree(value.replace(/\t/g, ""))}
          onAuxInput={focus === "commit" ? setCommitDraft : setRenameDraft}
          onTogglePlan={togglePlanMode}
          onOpenAccess={openRuntimePicker}
          onOpenModel={openModelPicker}
          onOpenReasoning={openReasoningPicker}
          onStop={stopTurn}
          onSend={sendReply}
          onSubmitAnswer={submitUserInput}
        />

      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={palette.dim}>{hint}</text>
        <text>
          <span fg={statusStyle.color}>{` ${statusStyle.glyph} `}</span>
          <span fg={statusStyle.color}>{state.status}</span>
        </text>
      </box>
    </box>
  );
}

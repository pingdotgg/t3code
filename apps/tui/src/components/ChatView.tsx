import {
  CliRenderEvents,
  type ScrollBoxRenderable,
  type SelectOption,
  SyntaxStyle,
} from "@opentui/core";
import {
  DEFAULT_SERVER_SETTINGS,
  type GitStackedAction,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderInteractionMode,
  type RuntimeMode,
  type VcsRef,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { getKittyClipboardManager, getKittyImageManager } from "@t3tools/opentui-image";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as React from "react";

import { derivePendingApprovals } from "../approvals.ts";
import {
  type ComposerImageAttachment,
  imageExtensionForMimeType,
  isSupportedImagePath,
  prepareComposerImage,
  prepareComposerImageBytes,
  removeComposerImage,
} from "../composerAttachments.ts";
import { normalizeEditedPrompt, resolveEditorCommand } from "../promptEditor.ts";
import type { TuiClient } from "../connection.ts";
import {
  type NewThreadWorkspaceMode,
  newThreadValidationMessage,
  resolveInitialBranch,
  resolveNewThreadBranchSelection,
  resolveNewThreadContext,
  validateNewThread,
} from "../newThread.logic.ts";
import { useKeyBindings } from "../hooks/useKeyBindings.ts";
import { useKittyGraphicsSupport } from "../hooks/useKittyGraphicsSupport.ts";
import { latestActionableProposedPlan } from "../proposedPlan.ts";
import { createStore } from "../store.ts";
import { statusGlyphColor, usePalette } from "../theme.ts";
import {
  currentModelIndex,
  type ModelOption,
  modelSelectionForOption,
  reasoningChoicesForSelection,
  resolveModelSelection,
  withModelSelectionOption,
} from "../models.ts";
import { isWorking, revertableCheckpoints } from "../timeline.ts";
import { buildUserInputAnswers, derivePendingUserInputs } from "../userInput.ts";
import { buildRows, selectionEquals } from "./Sidebar.logic.ts";
import { ChatComposer } from "./ChatComposer.tsx";
import {
  COMPOSER_MAX_EDITOR_ROWS,
  COMPOSER_MIN_EDITOR_ROWS,
  countWrappedComposerLines,
  resolveChatColumnLayout,
  resolveChatVerticalLayout,
  resolveSidebarListViewport,
} from "./ChatView.layout.ts";
import { type DiffStatus, type DiffView, DiffViewer } from "./DiffViewer.tsx";
import { type Command, filterCommands } from "../commands.ts";
import { buildFileTree, flattenFileTree } from "../fileTree.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { ComposerDock, type ComposerDockContext } from "./ComposerDock.tsx";
import { FilesView, type FilesStatus, type ViewingFile } from "./FilesView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { MessagesTimeline } from "./MessagesTimeline.tsx";
import { ImageLightbox, type ExpandedImagePreview } from "./ImageLightbox.tsx";
import { RightPanel } from "./RightPanel.tsx";
import { SelectOverlay, type SelectStatus } from "./SelectOverlay.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ConfirmDeleteMenu, RevertMenu } from "./ThreadOverlays.tsx";
import { type TerminalInfo, ThreadTerminalDrawer } from "./ThreadTerminalDrawer.tsx";
import {
  composerControls,
  RUNTIME_MODE_META,
  RUNTIME_MODES,
  runtimeModeLabel,
} from "../controls.ts";
import {
  buildGitPanelActions,
  gitActionNeedsCommitMessage,
  type GitPanelAction,
} from "../gitActions.logic.ts";
import {
  addTab,
  closeTab,
  cycleActiveId,
  initialTabs,
  reduceKnownTerminals,
  tabsWithDiscovered,
  type ThreadTabs,
} from "../terminalTabs.ts";
import { clip } from "../format.ts";

const COMPOSER_MAX_WIDTH = 96;
/** Conversation lines scrolled per page key. */
const SCROLL_STEP = 8;
/** Cap on terminals per thread (mirrors the web's per-group limit). */
const MAX_TERMINALS_PER_THREAD = 6;
const IMAGE_ONLY_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

function branchPickerOptions(refs: ReadonlyArray<VcsRef>): ReadonlyArray<SelectOption> {
  return refs.map((ref) => {
    const badges = [
      ref.current ? "current" : null,
      ref.isDefault ? "default" : null,
      ref.worktreePath ? "worktree" : null,
      ref.isRemote ? "remote" : null,
    ].filter((badge): badge is string => badge !== null);
    return {
      name: ref.name,
      description: badges.length > 0 ? badges.join(" · ") : "local branch",
      value: ref.name,
    };
  });
}

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
  const inlineImagesSupported = useKittyGraphicsSupport();
  const palette = usePalette();
  const store = React.useMemo(() => createStore(client), [client]);
  const syntaxStyle = React.useMemo(() => SyntaxStyle.create(), []);
  const state = React.useSyncExternalStore(store.subscribe, store.getState);
  const [modelOptions, setModelOptions] = React.useState<ReadonlyArray<ModelOption>>([]);

  React.useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  React.useEffect(() => {
    let cancelled = false;
    void client
      .getServerConfig()
      .then((config) => {
        if (!cancelled) setNewThreadSettings(config.settings);
      })
      .catch(() => {
        // Defaults remain usable while disconnected or on an older server.
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  React.useEffect(() => {
    let cancelled = false;
    void client.listModels().then(
      (models) => {
        if (!cancelled) setModelOptions(models);
      },
      () => {
        // The pickers retry on demand; the rest of the TUI remains usable.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

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
  const [filesPurpose, setFilesPurpose] = React.useState<"browse" | "attach-image">("browse");
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
  // Shared popover picker for composer controls and new-thread checkout context.
  const [picker, setPicker] = React.useState<{
    readonly kind: "model" | "runtime" | "reasoning" | "workspace" | "branch";
    readonly target: "thread" | "new";
    readonly title: string;
    readonly status: SelectStatus;
    readonly options: ReadonlyArray<SelectOption>;
    readonly selectedIndex: number;
  } | null>(null);
  // Model and effort are composer drafts, just like the web UI. They are sent
  // together with the next turn instead of mutating a live session out of band.
  const [threadModelSelections, setThreadModelSelections] = React.useState<
    ReadonlyMap<string, ModelSelection>
  >(() => new Map());
  // Build/Plan is a composer choice in the web UI. Keep an optimistic value per
  // thread so the control responds immediately while persistence round-trips.
  const [threadInteractionModes, setThreadInteractionModes] = React.useState<
    ReadonlyMap<string, ProviderInteractionMode>
  >(() => new Map());
  const [newModelSelection, setNewModelSelection] = React.useState<ModelSelection | null>(null);
  // Pending user-input form state.
  const [userInputDeferred, setUserInputDeferred] = React.useState(false);
  const [uiQuestionIndex, setUiQuestionIndex] = React.useState(0);
  const [uiOptionIndex, setUiOptionIndex] = React.useState(0);
  const [uiSelections, setUiSelections] = React.useState<Record<string, string[]>>({});
  // A free-text answer typed into the composer while a question is pending (the
  // web's "Type your own answer, or leave blank to use the selected option").
  const [customAnswer, setCustomAnswer] = React.useState("");
  const [reply, setReply] = React.useState("");
  const [composerImages, setComposerImages] = React.useState<
    ReadonlyArray<ComposerImageAttachment>
  >([]);
  const [newComposerImages, setNewComposerImages] = React.useState<
    ReadonlyArray<ComposerImageAttachment>
  >([]);
  const clipboardImageSequenceRef = React.useRef(0);
  const clipboardImageLoadsRef = React.useRef(0);
  // These refs close the same-event gap before React can paint a pending state:
  // rapid Enter presses must never start the same mutation twice.
  const replySubmissionPendingRef = React.useRef(false);
  const [replySubmissionPending, setReplySubmissionPending] = React.useState(false);
  const userInputSubmissionRequestRef = React.useRef<string | null>(null);
  const [expandedImage, setExpandedImage] = React.useState<ExpandedImagePreview | null>(null);
  const expandedImageScrollTopRef = React.useRef<number | null>(null);
  const pendingImageScrollRestoreRef = React.useRef<number | null>(null);
  // Bumped to remount (clear) the uncontrolled multiline reply editor.
  const [composerEpoch, setComposerEpoch] = React.useState(0);
  const [draft, setDraft] = React.useState("");
  const [renameDraft, setRenameDraft] = React.useState("");
  // The commit-message dialog: the draft + which commit-bearing action to run on submit.
  const [commitDraft, setCommitDraft] = React.useState("");
  const [pendingCommitAction, setPendingCommitAction] = React.useState<GitStackedAction | null>(
    null,
  );
  const [projectIndex, setProjectIndex] = React.useState(0);
  // Composer options for the local new-thread draft. The draft uses the same
  // prompt surface as an existing thread and is created atomically on first send.
  const [newRuntimeMode, setNewRuntimeMode] = React.useState<RuntimeMode>("full-access");
  const [newInteractionMode, setNewInteractionMode] =
    React.useState<ProviderInteractionMode>("default");
  const [newWorkspaceMode, setNewWorkspaceMode] = React.useState<NewThreadWorkspaceMode>("current");
  const [newBranch, setNewBranch] = React.useState<string | null>(null);
  const newBranchRef = React.useRef<string | null>(newBranch);
  newBranchRef.current = newBranch;
  const [newContextWorktreePath, setNewContextWorktreePath] = React.useState<string | null>(null);
  const [newBranchRefs, setNewBranchRefs] = React.useState<ReadonlyArray<VcsRef>>([]);
  const [newBranchRefsStatus, setNewBranchRefsStatus] = React.useState<SelectStatus>("loading");
  const newContextMutationPendingRef = React.useRef(false);
  const newContextMutationTokenRef = React.useRef(0);
  const [newContextMutationPending, setNewContextMutationPending] = React.useState(false);
  const newSubmissionPendingRef = React.useRef(false);
  const newDraftOriginSelectionRef = React.useRef<string | null>(null);
  const [newSubmissionPending, setNewSubmissionPending] = React.useState(false);
  const [newThreadSettings, setNewThreadSettings] = React.useState(DEFAULT_SERVER_SETTINGS);
  // Which pending approval ^A/^R act on; ↑/↓ move it while an approval is up.
  const [approvalIndex, setApprovalIndex] = React.useState(0);
  // The source-control panel (^L): docked when wide, main-pane when narrow.
  const [rightPanelOpen, setRightPanelOpen] = React.useState(false);
  const [rightPanelFocused, setRightPanelFocused] = React.useState(false);
  const [rightPanelIndex, setRightPanelIndex] = React.useState(0);
  // User-set prompt height in editor rows; null = auto-grow with content.
  const [promptHeight, setPromptHeight] = React.useState<number | null>(null);
  // Multiple terminals per thread (the TUI form of the web's terminal groups):
  // each thread keeps a list of client-chosen terminal ids + the active one; the
  // drawer shows the selected thread's active terminal with a tab bar.
  const [terminalOpen, setTerminalOpen] = React.useState(false);
  const [terminalTabs, setTerminalTabs] = React.useState<ReadonlyMap<string, ThreadTabs>>(
    () => new Map(),
  );
  // Terminal ids the server knows about per thread (agent-spawned, web-created,
  // or from a prior run), streamed from the terminal-metadata subscription so the
  // tab bar reflects reality rather than only the tabs this TUI opened.
  const [knownTerminals, setKnownTerminals] = React.useState<
    ReadonlyMap<string, ReadonlyArray<string>>
  >(() => new Map());
  // The terminal drawer coexists with the prompt; this tracks which one keystrokes go to.
  const [terminalFocused, setTerminalFocused] = React.useState(false);
  // User-set terminal-drawer height in rows; null = the default proportion.
  const [terminalHeight, setTerminalHeight] = React.useState<number | null>(null);
  const scrollRef = React.useRef<ScrollBoxRenderable | null>(null);
  // Filled by the terminal drawer with a getter for its viewport text (for ^O copy).
  const terminalCopyRef = React.useRef<(() => string) | null>(null);
  // Routes key-driven scrollback navigation to the active terminal pane.
  const terminalScrollRef = React.useRef<
    ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
  >(null);

  const projects = state.shell?.projects ?? [];
  // projectIndex is held across shell updates; clamp it so a shrinking project
  // list can't leave it pointing past the end (projects[projectIndex] = undefined).
  const activeProjectIndex = projects.length > 0 ? Math.min(projectIndex, projects.length - 1) : 0;
  const selectedThreadId = state.selection?.kind === "thread" ? state.selection.id : null;
  const selectionKey = state.selection ? `${state.selection.kind}:${state.selection.id}` : "none";
  const rows = React.useMemo(
    () =>
      buildRows(state.shell, state.expanded, state.loadedInFull, selectedThreadId, state.filter),
    [state.shell, state.expanded, state.loadedInFull, selectedThreadId, state.filter],
  );
  const detail = state.detail;
  const threadInteractionMode = detail
    ? (threadInteractionModes.get(detail.id) ?? detail.interactionMode)
    : "default";
  const threadModelSelection = React.useMemo(
    () =>
      detail
        ? (threadModelSelections.get(detail.id) ??
          resolveModelSelection(modelOptions, detail.modelSelection) ??
          detail.modelSelection)
        : null,
    [detail, modelOptions, threadModelSelections],
  );
  const threadReasoning = React.useMemo(
    () => reasoningChoicesForSelection(modelOptions, threadModelSelection),
    [modelOptions, threadModelSelection],
  );
  const resolvedNewModelSelection = React.useMemo(
    () => resolveModelSelection(modelOptions, newModelSelection) ?? newModelSelection,
    [modelOptions, newModelSelection],
  );

  React.useEffect(() => {
    if (
      focus !== "new" ||
      newDraftOriginSelectionRef.current === null ||
      newDraftOriginSelectionRef.current === selectionKey
    ) {
      return;
    }
    newDraftOriginSelectionRef.current = null;
    newContextMutationTokenRef.current += 1;
    newContextMutationPendingRef.current = false;
    setNewContextMutationPending(false);
    setDraft("");
    setNewComposerImages([]);
    setNewBranch(null);
    setNewContextWorktreePath(null);
    setComposerEpoch((epoch) => epoch + 1);
    setFocus("compose");
  }, [focus, selectionKey]);

  React.useEffect(() => {
    if (focus !== "new") return;
    const project = projects[activeProjectIndex];
    if (!project) {
      setNewBranchRefs([]);
      setNewBranchRefsStatus("empty");
      return;
    }
    let cancelled = false;
    setNewBranchRefs([]);
    setNewBranchRefsStatus("loading");
    void client.listRefs(project.workspaceRoot).then(
      (result) => {
        if (cancelled) return;
        const status = result.refs.length > 0 ? "ready" : "empty";
        const resolvedBranch = resolveInitialBranch(result.refs, newBranchRef.current);
        setNewBranchRefs(result.refs);
        setNewBranchRefsStatus(status);
        setNewBranch(resolvedBranch);
        setPicker((current) =>
          current?.kind === "branch" && current.target === "new"
            ? {
                ...current,
                status,
                options: branchPickerOptions(result.refs),
                selectedIndex: Math.max(
                  0,
                  result.refs.findIndex((ref) => ref.name === resolvedBranch),
                ),
              }
            : current,
        );
      },
      () => {
        if (cancelled) return;
        setNewBranchRefsStatus("error");
        setPicker((current) =>
          current?.kind === "branch" && current.target === "new"
            ? { ...current, status: "error", options: [] }
            : current,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeProjectIndex, client, focus, projects]);
  // The selected thread's terminal tabs + the single active terminal the drawer
  // renders (derived so the existing single-terminal usages keep working).
  const terminalCwd = detail
    ? (detail.worktreePath ??
      projects.find((p) => p.id === detail.projectId)?.workspaceRoot ??
      process.cwd())
    : process.cwd();
  const composerCwd =
    focus === "new"
      ? ((newWorkspaceMode === "current" ? newContextWorktreePath : null) ??
        projects[activeProjectIndex]?.workspaceRoot ??
        process.cwd())
      : terminalCwd;
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
  const newReasoning = React.useMemo(
    () => reasoningChoicesForSelection(modelOptions, resolvedNewModelSelection),
    [modelOptions, resolvedNewModelSelection],
  );
  const controls =
    focus === "new"
      ? {
          interactionMode: newInteractionMode,
          runtimeMode: newRuntimeMode,
          model: resolvedNewModelSelection?.model ?? null,
          reasoning: newReasoning?.selectedId ?? null,
        }
      : {
          ...composerControls(detail, threadModelSelection, threadReasoning?.selectedId),
          interactionMode: threadInteractionMode,
        };
  // The agent is actively running a turn — show the red stop affordance (mirrors
  // the web composer swapping its send button for a stop button while running).
  const working = !!detail && isWorking(detail);
  const composerWorking = focus !== "new" && working;

  const detailId = detail?.id ?? null;
  const openExpandedImage = React.useCallback((preview: ExpandedImagePreview) => {
    expandedImageScrollTopRef.current = scrollRef.current?.scrollTop ?? null;
    setTerminalFocused(false);
    setExpandedImage(preview);
  }, []);
  const closeExpandedImage = React.useCallback(() => {
    pendingImageScrollRestoreRef.current = expandedImageScrollTopRef.current;
    expandedImageScrollTopRef.current = null;
    setExpandedImage(null);
  }, []);
  React.useEffect(() => {
    const scrollTop = pendingImageScrollRestoreRef.current;
    if (expandedImage || scrollTop === null) return;
    const restoreScrollTop = () => {
      renderer.off(CliRenderEvents.FRAME, restoreScrollTop);
      pendingImageScrollRestoreRef.current = null;
      scrollRef.current?.scrollTo(scrollTop);
    };
    renderer.on(CliRenderEvents.FRAME, restoreScrollTop);
    renderer.requestRender();
    return () => {
      renderer.off(CliRenderEvents.FRAME, restoreScrollTop);
    };
  }, [expandedImage, renderer]);
  React.useEffect(() => {
    // Terminal focus is global but tabs are per-thread: dropping focus on a
    // thread switch stops keystrokes routing to whichever shell the new thread
    // happens to have, until the user re-focuses it (^P) explicitly.
    setTerminalFocused(false);
    expandedImageScrollTopRef.current = null;
    pendingImageScrollRestoreRef.current = null;
    setExpandedImage(null);
  }, [detailId]);
  React.useEffect(() => {
    if (!detail || threadInteractionModes.get(detail.id) !== detail.interactionMode) return;
    setThreadInteractionModes((current) => {
      if (current.get(detail.id) !== detail.interactionMode) return current;
      const next = new Map(current);
      next.delete(detail.id);
      return next;
    });
  }, [detail, threadInteractionModes]);
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
    if (focus === "new") {
      setNewInteractionMode((mode) => {
        const next = mode === "plan" ? "default" : "plan";
        store.setStatus(next === "plan" ? "Plan mode." : "Build mode.", "success");
        return next;
      });
      return;
    }
    if (!detail) return;
    const threadId = detail.id;
    const next = threadInteractionMode === "plan" ? "default" : "plan";
    setThreadInteractionModes((current) => new Map(current).set(threadId, next));
    store.setStatus(next === "plan" ? "Plan mode." : "Build mode.", "success");
    void client.setInteractionMode(threadId, next).catch((error) => {
      setThreadInteractionModes((current) => {
        if (current.get(threadId) !== next) return current;
        const rolledBack = new Map(current);
        rolledBack.delete(threadId);
        return rolledBack;
      });
      store.setStatus(`mode change failed: ${String(error)}`, "error");
    });
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

  const rightPanelActions = React.useMemo(
    () => buildGitPanelActions(state.vcsStatus, state.gitBusy),
    [state.vcsStatus, state.gitBusy],
  );
  const safeRightPanelIndex = Math.min(rightPanelIndex, Math.max(0, rightPanelActions.length - 1));

  const toggleRightPanel = () => {
    if (rightPanelOpen) {
      setRightPanelOpen(false);
      setRightPanelFocused(false);
      return;
    }
    setTerminalFocused(false);
    setRightPanelIndex(0);
    setRightPanelOpen(true);
    setRightPanelFocused(true);
  };

  const activateRightPanelAction = (action: GitPanelAction) => {
    if (action.disabled) {
      if (action.hint) store.setStatus(action.hint, "info");
      return;
    }
    setRightPanelFocused(false);
    if (action.kind === "git") {
      onRunGitAction(action.action);
      return;
    }
    if (action.kind === "pull") {
      store.pullGit();
      return;
    }
    if (action.kind === "url") {
      renderer.copyToClipboardOSC52(action.url);
      const copied = renderer.isOsc52Supported();
      store.setStatus(
        copied
          ? "PR link copied. Ctrl-click the underlined link to open it."
          : `Open PR: ${action.url}`,
        copied ? "success" : "info",
      );
    }
  };

  const openNewThread = () => {
    if (focus === "new") return;
    newDraftOriginSelectionRef.current = selectionKey;
    const context = resolveNewThreadContext({
      projects,
      thread: detail,
      defaultEnvironmentMode: newThreadSettings.defaultThreadEnvMode,
    });
    setProjectIndex(context.projectIndex);
    const project = projects[context.projectIndex];
    setNewModelSelection(
      resolveModelSelection(modelOptions, project?.defaultModelSelection) ??
        project?.defaultModelSelection ??
        null,
    );
    setNewRuntimeMode(detail?.runtimeMode ?? "full-access");
    setNewInteractionMode("default");
    setNewWorkspaceMode(context.workspaceMode);
    setNewBranch(context.branch);
    setNewContextWorktreePath(context.worktreePath);
    setDraft("");
    setNewComposerImages([]);
    setComposerEpoch((epoch) => epoch + 1);
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

  const openWorkspacePicker = () => {
    if (focus !== "new") return;
    const currentWorkspaceLabel = newContextWorktreePath ? "Current worktree" : "Current checkout";
    setPicker({
      kind: "workspace",
      target: "new",
      title: "workspace",
      status: "ready",
      options: [
        {
          name: currentWorkspaceLabel,
          description: newContextWorktreePath
            ? "Reuse the selected existing worktree."
            : "Run in the project's current checkout.",
          value: "current",
        },
        {
          name: "New worktree",
          description: `Create an isolated worktree from ${newBranch ?? "the selected base"}.`,
          value: "new-worktree",
        },
      ],
      selectedIndex: newWorkspaceMode === "current" ? 0 : 1,
    });
  };

  const openBranchPicker = () => {
    if (focus !== "new") return;
    const options = branchPickerOptions(newBranchRefs);
    setPicker({
      kind: "branch",
      target: "new",
      title: newWorkspaceMode === "new-worktree" ? "base branch" : "branch",
      status: newBranchRefsStatus,
      options,
      selectedIndex: Math.max(
        0,
        newBranchRefs.findIndex((ref) => ref.name === newBranch),
      ),
    });
  };

  const openRuntimePicker = () => {
    const target = focus === "new" ? "new" : "thread";
    if (target === "thread" && !detail) return;
    const runtimeMode = target === "new" ? newRuntimeMode : (detail?.runtimeMode ?? "full-access");
    setPicker({
      kind: "runtime",
      target,
      title: "access",
      status: "ready",
      options: RUNTIME_MODES.map((mode) => ({
        name: RUNTIME_MODE_META[mode].label,
        description: RUNTIME_MODE_META[mode].description,
        value: mode,
      })),
      selectedIndex: Math.max(0, RUNTIME_MODES.indexOf(runtimeMode)),
    });
  };

  const openModelPicker = () => {
    const target = focus === "new" ? "new" : "thread";
    const selection = target === "new" ? resolvedNewModelSelection : threadModelSelection;
    if (target === "thread" && !detail) return;
    setPicker({
      kind: "model",
      target,
      title: "model",
      status: "loading",
      options: [],
      selectedIndex: 0,
    });
    void client
      .listModels()
      .then((models) => {
        setModelOptions(models);
        setPicker((current) => {
          if (!current || current.kind !== "model" || current.target !== target) return current;
          return {
            ...current,
            status: models.length > 0 ? "ready" : "empty",
            options: models.map((model) => ({
              name: model.label,
              description: model.providerLabel,
              value: JSON.stringify({ instanceId: model.instanceId, model: model.model }),
            })),
            selectedIndex: currentModelIndex(models, selection),
          };
        });
      })
      .catch(() =>
        setPicker((current) =>
          current && current.kind === "model" ? { ...current, status: "error" } : current,
        ),
      );
  };

  const openReasoningPicker = () => {
    const target = focus === "new" ? "new" : "thread";
    const selection = target === "new" ? resolvedNewModelSelection : threadModelSelection;
    if ((target === "thread" && !detail) || !selection) {
      store.setStatus("Select a model first.", "info");
      return;
    }
    setPicker({
      kind: "reasoning",
      target,
      title: "effort",
      status: "loading",
      options: [],
      selectedIndex: 0,
    });
    void client
      .listModels()
      .then((models) => {
        setModelOptions(models);
        const resolvedSelection = resolveModelSelection(models, selection) ?? selection;
        const result = reasoningChoicesForSelection(models, resolvedSelection);
        setPicker((current) => {
          if (!current || current.kind !== "reasoning" || current.target !== target) return current;
          if (!result || result.choices.length === 0) return { ...current, status: "empty" };
          return {
            ...current,
            status: "ready",
            options: result.choices.map((choice) => ({
              name: choice.label,
              description: choice.description ?? result.descriptorId,
              value: JSON.stringify({ descriptorId: result.descriptorId, choiceId: choice.id }),
            })),
            selectedIndex: Math.max(
              0,
              result.choices.findIndex((choice) => choice.id === result.selectedId),
            ),
          };
        });
      })
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

  const applyNewThreadBranch = (ref: VcsRef) => {
    const project = projects[activeProjectIndex];
    if (!project || newContextMutationPendingRef.current) return;
    const selection = resolveNewThreadBranchSelection({
      workspaceMode: newWorkspaceMode,
      projectCwd: project.workspaceRoot,
      currentWorktreePath: newContextWorktreePath,
      ref,
    });
    setPicker(null);

    if (selection.kind === "select-base") {
      setNewBranch(selection.branch);
      store.setStatus(`Worktree base → ${selection.branch}`, "success");
      return;
    }
    if (selection.kind === "reuse-worktree") {
      setNewBranch(selection.branch);
      setNewContextWorktreePath(selection.worktreePath);
      store.setStatus(`Workspace → ${selection.branch}`, "success");
      return;
    }

    newContextMutationPendingRef.current = true;
    const mutationToken = newContextMutationTokenRef.current + 1;
    newContextMutationTokenRef.current = mutationToken;
    setNewContextMutationPending(true);
    store.setStatus(`Switching checkout to ${ref.name}…`, "busy");
    void client
      .switchRef(selection.checkoutCwd, ref.name)
      .then(
        (result) => {
          if (
            newContextMutationTokenRef.current !== mutationToken ||
            newDraftOriginSelectionRef.current === null
          ) {
            return;
          }
          setNewBranch(result.refName ?? selection.branch);
          setNewContextWorktreePath(selection.worktreePath);
          store.setStatus(`Branch → ${result.refName ?? selection.branch}`, "success");
        },
        (error) => {
          if (newContextMutationTokenRef.current !== mutationToken) return;
          store.setStatus(`branch switch failed: ${String(error)}`, "error");
        },
      )
      .finally(() => {
        if (newContextMutationTokenRef.current !== mutationToken) return;
        newContextMutationPendingRef.current = false;
        setNewContextMutationPending(false);
      });
  };

  const applyPicker = (index: number) => {
    const current = picker;
    if (!current) return;
    const option = current.options[index];
    const value = typeof option?.value === "string" ? option.value : null;
    const kind = current.kind;
    if (!value) return;
    if (kind === "branch") {
      const ref = newBranchRefs.find((candidate) => candidate.name === value);
      if (ref) applyNewThreadBranch(ref);
      return;
    }
    setPicker(null);
    if (kind === "workspace") {
      const mode = value as NewThreadWorkspaceMode;
      setNewWorkspaceMode(mode);
      if (mode === "current") {
        const project = projects[activeProjectIndex];
        const currentRef = newContextWorktreePath
          ? newBranchRefs.find((ref) => ref.worktreePath === newContextWorktreePath)
          : newBranchRefs.find(
              (ref) => ref.current || (!!project && ref.worktreePath === project.workspaceRoot),
            );
        if (currentRef) {
          setNewBranch(currentRef.name);
        }
      }
      store.setStatus(
        mode === "new-worktree" ? "Workspace → New worktree" : "Workspace → Current checkout",
        "success",
      );
    } else if (kind === "runtime") {
      const mode = value as RuntimeMode;
      if (current.target === "new") {
        setNewRuntimeMode(mode);
        store.setStatus(`Access → ${runtimeModeLabel(mode)}`, "success");
      } else if (detail) {
        void client
          .setRuntimeMode(detail.id, mode)
          .catch((error) => store.setStatus(`access change failed: ${String(error)}`, "error"));
        store.setStatus(`Access → ${runtimeModeLabel(mode)}`, "success");
      }
    } else if (kind === "model") {
      const parsed = JSON.parse(value) as { instanceId?: string; model?: string };
      const model = modelOptions.find(
        (candidate) =>
          candidate.instanceId === parsed.instanceId && candidate.model === parsed.model,
      );
      if (!model) return;
      const selection = modelSelectionForOption(model);
      if (current.target === "new") setNewModelSelection(selection);
      else if (detail) {
        setThreadModelSelections((previous) => {
          const next = new Map(previous);
          next.set(detail.id, selection);
          return next;
        });
      }
      store.setStatus(`Model → ${model.model} (next turn)`, "success");
    } else if (kind === "reasoning") {
      const parsed = JSON.parse(value) as { descriptorId?: string; choiceId?: string };
      if (!parsed.descriptorId || !parsed.choiceId) return;
      if (current.target === "new" && resolvedNewModelSelection) {
        setNewModelSelection(
          withModelSelectionOption(resolvedNewModelSelection, parsed.descriptorId, parsed.choiceId),
        );
      } else if (detail && threadModelSelection) {
        const selection = withModelSelectionOption(
          threadModelSelection,
          parsed.descriptorId,
          parsed.choiceId,
        );
        setThreadModelSelections((previous) => {
          const next = new Map(previous);
          next.set(detail.id, selection);
          return next;
        });
      }
      store.setStatus(`Effort → ${parsed.choiceId} (next turn)`, "success");
    }
  };

  const pendingUserInput = React.useMemo(
    () => (detail ? (derivePendingUserInputs(detail.activities)[0] ?? null) : null),
    [detail],
  );
  // Reset the answer draft whenever a different request comes in (or it clears).
  const pendingRequestId = pendingUserInput?.requestId ?? null;
  const pendingRequestIdRef = React.useRef(pendingRequestId);
  pendingRequestIdRef.current = pendingRequestId;
  React.useEffect(() => {
    userInputSubmissionRequestRef.current = null;
    setUserInputDeferred(false);
    setUiQuestionIndex(0);
    setUiOptionIndex(0);
    setUiSelections({});
    setCustomAnswer("");
  }, [pendingRequestId]);
  const userInputActive = pendingUserInput !== null && !userInputDeferred;
  const composerUserInputActive = focus !== "new" && userInputActive;
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
  const rightPanelVisible =
    rightPanelOpen && !diffOpen && !filesOpen && !settingsOpen && !expandedImage;
  const columnLayout = resolveChatColumnLayout(width, rightPanelVisible);
  const { sidebarVisible, listWidth, mainWidth, chatWidth, rightWidth, rightPanelAsMain } =
    columnLayout;
  const sidebarAsMain = !sidebarVisible && focus === "filter";
  const composerSurfaceWidth = Math.max(8, Math.min(COMPOSER_MAX_WIDTH, chatWidth - 2));
  const composerContext: ComposerDockContext | null =
    focus === "new"
      ? {
          workspace:
            newWorkspaceMode === "new-worktree"
              ? "New worktree"
              : newContextWorktreePath
                ? "Current worktree"
                : "Project workspace",
          branch: newBranch ?? "(current)",
          onOpenWorkspace: openWorkspacePicker,
          onOpenBranch: openBranchPicker,
        }
      : detail && state.vcsStatus?.isRepo
        ? {
            workspace: detail.worktreePath ? "Worktree checkout" : "Local checkout",
            branch: state.vcsStatus.refName ?? detail.branch ?? "(detached)",
          }
        : null;

  // The web composer starts as a multiline surface, grows for soft-wrapped text,
  // and scrolls internally after its cap. Count visual rows rather than only
  // explicit newlines so a long pasted command cannot push the terminal away.
  const composerText = focus === "new" ? draft : reply;
  const activeComposerImages = focus === "new" ? newComposerImages : composerImages;
  const autoPromptLines = Math.max(
    COMPOSER_MIN_EDITOR_ROWS,
    countWrappedComposerLines(composerText, Math.max(1, composerSurfaceWidth - 4)),
  );
  // A popover (picker / palette / revert / confirm) floats ABOVE the composer,
  // which stays visible (unfocused, compact) below — mirroring the web, where a
  // dropdown opens over the still-present composer rather than replacing it.
  const popoverOpen =
    !!picker || overlay === "command" || overlay === "revert" || overlay === "confirmDelete";
  const composerThreadId = detail?.id ?? null;
  const composerInputFocused =
    !terminalFocused &&
    !replySubmissionPending &&
    !newSubmissionPending &&
    !newContextMutationPending &&
    !diffOpen &&
    !filesOpen &&
    !settingsOpen &&
    !expandedImage &&
    !popoverOpen &&
    !rightPanelFocused &&
    focus !== "filter";

  React.useEffect(() => {
    const acceptsAttachments =
      focus === "new" || (focus === "compose" && composerThreadId !== null);
    if (!composerInputFocused || !acceptsAttachments || composerUserInputActive) return;
    return getKittyClipboardManager(renderer).activate({
      maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      onError: (error) => store.setStatus(error.message, "error"),
    });
  }, [composerInputFocused, composerThreadId, composerUserInputActive, focus, renderer, store]);
  // A pending question renders a panel inside the composer (header + question +
  // options + hint + spacer), so the composer grows to fit it.
  const pendingPanelHeight =
    composerUserInputActive && uiQuestion ? uiQuestion.options.length + 4 : 0;
  const attachmentPreviewHeight =
    activeComposerImages.length === 0 ? 0 : inlineImagesSupported ? 4 : 1;
  const compactComposerFooter =
    focus !== "rename" && focus !== "filter" && focus !== "commit" && composerSurfaceWidth < 64;
  const pickerWanted = picker ? Math.max(picker.options.length, 1) * 2 + 3 : 0;
  const commandWanted = overlay === "command" ? Math.floor(height * 0.5) : 0;
  const revertWanted = overlay === "revert" ? Math.min(checkpoints.length, 8) + 3 : 0;
  const confirmWanted = overlay === "confirmDelete" ? 4 : 0;
  const specialComposer = focus === "rename" || focus === "filter" || focus === "commit";
  const desiredPromptLines = specialComposer || popoverOpen ? 1 : (promptHeight ?? autoPromptLines);
  // OpenTUI measures five non-editor rows for the composer borders, footer, and margins.
  const composerChromeRows =
    5 +
    (specialComposer || popoverOpen ? 0 : pendingPanelHeight) +
    (specialComposer ? 0 : attachmentPreviewHeight) +
    (compactComposerFooter ? 1 : 0) +
    (composerContext ? 1 : 0);
  const verticalLayout = resolveChatVerticalLayout({
    terminalHeight: height,
    desiredEditorRows: desiredPromptLines,
    composerChromeRows,
    terminalOpen: activeTerminal !== null,
    preferredTerminalRows: terminalHeight ?? Math.floor(height * 0.4),
    wantedPopoverRows: pickerWanted + commandWanted + revertWanted + confirmWanted,
  });
  const promptLines = verticalLayout.editorRows;
  const terminalDrawerHeight = verticalLayout.terminalRows;
  const popoverHeight = verticalLayout.popoverRows;
  const pickerContentRows = Math.max(2, popoverHeight - 3);
  const panesHeight = verticalLayout.panesRows;
  const listViewport = resolveSidebarListViewport(height);
  const termCols = Math.max(2, mainWidth - 4);
  // header + tab bar + frame + border(2) = frame rows + 4.
  const termRows = Math.max(2, terminalDrawerHeight - 4);

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
    setComposerImages([]);
    setComposerEpoch((epoch) => epoch + 1);
  };

  const sendReply = () => {
    if (replySubmissionPendingRef.current) return;
    const typedText = reply.trim();
    if (typedText.length === 0 && composerImages.length === 0) {
      // Empty prompt → Enter activates the highlighted row.
      if (state.selection?.kind === "project") store.toggleProject(state.selection.id);
      else if (state.selection?.kind === "more") store.loadMore(state.selection.id);
      return;
    }
    if (!detail) {
      store.setStatus("Select a thread (Alt+↑/↓ or click) to send a message.");
      return;
    }
    const text = typedText.length > 0 ? typedText : IMAGE_ONLY_PROMPT;
    const attachments = composerImages.map((image) => image.upload);
    const submittedReply = reply;
    const submittedImagePaths = new Set(composerImages.map((image) => image.relativePath));
    replySubmissionPendingRef.current = true;
    setReplySubmissionPending(true);
    store.setStatus("Sending reply…", "busy");
    void Promise.resolve()
      .then(() =>
        client.sendReply(
          { ...detail, interactionMode: threadInteractionMode },
          text,
          attachments,
          threadModelSelection ?? undefined,
        ),
      )
      .then(
        () => {
          replySubmissionPendingRef.current = false;
          setReplySubmissionPending(false);
          // The prompt is temporarily unfocused while sending, but other surfaces
          // may still update its state. Clear only the submitted snapshot and keep
          // anything staged after the request began.
          setReply((current) => (current === submittedReply ? "" : current));
          setComposerImages((current) =>
            current.filter((image) => !submittedImagePaths.has(image.relativePath)),
          );
          setComposerEpoch((epoch) => epoch + 1);
          store.setStatus("Reply sent.", "success");
        },
        (error) => {
          replySubmissionPendingRef.current = false;
          setReplySubmissionPending(false);
          store.setStatus(`send failed: ${String(error)}`, "error");
        },
      );
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
    const isLast = uiQuestionIndex >= pendingUserInput.questions.length - 1;
    if (!isLast) {
      setCustomAnswer("");
      setUiSelections(selections);
      setUiQuestionIndex((index) => index + 1);
      setUiOptionIndex(0);
      return;
    }
    if (userInputSubmissionRequestRef.current === pendingUserInput.requestId) return;
    const answers = buildUserInputAnswers(pendingUserInput.questions, selections);
    const requestId = pendingUserInput.requestId;
    userInputSubmissionRequestRef.current = requestId;
    store.setStatus("Sending answer…", "busy");
    void Promise.resolve()
      .then(() => client.respondUserInput(detail.id, requestId, answers))
      .then(
        () => {
          if (pendingRequestIdRef.current !== requestId) return;
          // Keep the local values until the live activity stream resolves the
          // request. Deferring avoids a second submit during that short interval.
          setUserInputDeferred(true);
          store.setStatus("Answer sent.", "success");
        },
        (error) => {
          if (userInputSubmissionRequestRef.current === requestId) {
            userInputSubmissionRequestRef.current = null;
          }
          if (pendingRequestIdRef.current === requestId) {
            store.setStatus(`answer failed: ${String(error)}`, "error");
          }
        },
      );
  };

  const submitNewThread = () => {
    if (newSubmissionPendingRef.current) return;
    if (newContextMutationPendingRef.current) {
      store.setStatus("Wait for the branch switch to finish.", "info");
      return;
    }
    const project = projects[activeProjectIndex];
    const typedMessage = draft.trim();
    const message =
      typedMessage.length > 0
        ? typedMessage
        : newComposerImages.length > 0
          ? IMAGE_ONLY_PROMPT
          : "";
    const validationError = validateNewThread({
      hasProject: !!project,
      message,
      hasModelSelection: !!resolvedNewModelSelection,
      workspaceMode: newWorkspaceMode,
      branch: newBranch,
    });
    if (validationError) {
      store.setStatus(newThreadValidationMessage(validationError), "error");
      return;
    }
    if (!project || !resolvedNewModelSelection) return;

    newSubmissionPendingRef.current = true;
    setNewSubmissionPending(true);
    store.setStatus("Creating thread and starting its first turn…", "busy");
    const createWorktree = newWorkspaceMode === "new-worktree";
    void client
      .createThread({
        projectId: project.id,
        projectCwd: project.workspaceRoot,
        title: typedMessage.length > 0 ? truncate(typedMessage) : "Image attachment",
        modelSelection: resolvedNewModelSelection,
        firstMessage: message,
        attachments: newComposerImages.map((image) => image.upload),
        runtimeMode: newRuntimeMode,
        interactionMode: newInteractionMode,
        branch: newBranch,
        worktreePath: createWorktree ? null : newContextWorktreePath,
        createWorktree,
        startFromOrigin: createWorktree && newThreadSettings.newWorktreesStartFromOrigin,
      })
      .then(
        (threadId) => {
          setDraft("");
          setNewComposerImages([]);
          setNewBranch(null);
          setNewContextWorktreePath(null);
          newDraftOriginSelectionRef.current = null;
          setComposerEpoch((epoch) => epoch + 1);
          setFocus("compose");
          if (!store.getState().expanded.has(project.id)) store.toggleProject(project.id);
          store.select({ kind: "thread", id: threadId });
          store.setStatus("Thread created.", "success");
        },
        (error) => {
          store.setStatus(`create failed: ${String(error)}`, "error");
        },
      )
      .finally(() => {
        newSubmissionPendingRef.current = false;
        setNewSubmissionPending(false);
      });
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

  // Discover terminals the TUI didn't open (agent-spawned, web-created, or from
  // a prior run) via the metadata stream, so the tab bar isn't blind to them.
  React.useEffect(() => {
    const unsubscribe = client.subscribeTerminalMetadata((event) => {
      setKnownTerminals((prev) => reduceKnownTerminals(prev, event));
    });
    return unsubscribe;
  }, [client]);

  // Union discovered ids into the open thread's tabs. tabsWithDiscovered returns
  // the same reference when nothing is new, so updateThreadTabs no-ops then.
  const detailIdForTabs = detail?.id ?? null;
  React.useEffect(() => {
    if (!terminalOpen || detailIdForTabs === null) return;
    const discovered = knownTerminals.get(detailIdForTabs) ?? [];
    if (discovered.length === 0) return;
    updateThreadTabs(detailIdForTabs, (tabs) => tabsWithDiscovered(tabs, discovered));
  }, [terminalOpen, detailIdForTabs, knownTerminals]);

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

  const clearActiveTerminal = () => {
    if (!activeTerminal) return;
    store.setStatus("Clearing terminal…", "busy");
    void client.terminalClear(activeTerminal.threadId, activeTerminal.terminalId).then(
      () => store.setStatus("Terminal cleared.", "success"),
      (error) => store.setStatus(`Could not clear terminal: ${String(error)}`, "error"),
    );
  };

  const restartActiveTerminal = () => {
    if (!activeTerminal) return;
    store.setStatus("Restarting terminal…", "busy");
    void client
      .terminalRestart({
        threadId: activeTerminal.threadId,
        terminalId: activeTerminal.terminalId,
        cwd: activeTerminal.cwd,
        worktreePath: activeTerminal.worktreePath,
        cols: termCols,
        rows: termRows,
      })
      .then(
        () => store.setStatus("Terminal restarted.", "success"),
        (error) => store.setStatus(`Could not restart terminal: ${String(error)}`, "error"),
      );
  };

  // ── Workspace file browser ─────────────────────────────────────────────────
  // The flattened, collapse-aware tree built from the file entries (dirs inferred
  // from paths; reuses the changed-files tree machinery).
  const fileRows = React.useMemo(
    () =>
      flattenFileTree(
        buildFileTree(
          fileEntries
            .filter(
              (entry) =>
                entry.kind === "file" &&
                (filesPurpose === "browse" || isSupportedImagePath(entry.path)),
            )
            .map((entry) => ({ path: entry.path, additions: 0, deletions: 0 })),
        ),
        filesCollapsedDirs,
      ),
    [fileEntries, filesCollapsedDirs, filesPurpose],
  );

  const openFiles = (purpose: "browse" | "attach-image" = "browse") => {
    setFilesPurpose(purpose);
    setFilesOpen(true);
    setViewingFile(null);
    setFilesIndex(0);
    setFilesCollapsedDirs(new Set());
    setFilesStatus("loading");
    setFileEntries([]);
    void client
      .listEntries(composerCwd)
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
    setFilesIndex((index) =>
      Math.min(Math.max(0, index + delta), Math.max(0, fileRows.length - 1)),
    );
  };
  const updateActiveComposerImages = (
    update: (
      current: ReadonlyArray<ComposerImageAttachment>,
    ) => ReadonlyArray<ComposerImageAttachment>,
  ) => {
    if (focus === "new") setNewComposerImages(update);
    else setComposerImages(update);
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
    if (filesPurpose === "attach-image") {
      if (activeComposerImages.some((image) => image.relativePath === row.path)) {
        store.setStatus(`${row.name} is already attached.`, "info");
        closeFiles();
        return;
      }
      if (activeComposerImages.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        store.setStatus(
          `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images.`,
          "error",
        );
        closeFiles();
        return;
      }
      setFilesStatus("loading");
      void client
        .readFileBase64(composerCwd, row.path)
        .then((file) => {
          if (!file) throw new Error("Could not read the image.");
          return prepareComposerImage(row.path, file);
        })
        .then((image) => {
          updateActiveComposerImages((current) => [...current, image]);
          closeFiles();
          store.setStatus(`Attached ${image.upload.name}.`, "success");
        })
        .catch((error) => {
          setFilesStatus("ready");
          store.setStatus(
            error instanceof Error ? error.message : "Could not attach image.",
            "error",
          );
        });
      return;
    }
    setViewingFile({ path: row.path, status: "loading", content: "" });
    void client
      .readFile(composerCwd, row.path)
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
  const removeStagedComposerImage = (relativePath: string) => {
    updateActiveComposerImages((current) => removeComposerImage(current, relativePath));
  };

  const pasteComposerImage = (paste: { readonly bytes: Uint8Array; readonly mimeType: string }) => {
    if (!detail && focus !== "new") {
      store.setStatus("Select a thread before pasting an image.", "error");
      return;
    }
    if (userInputActive) {
      store.setStatus("Answer the pending question before attaching an image.", "error");
      return;
    }
    if (
      activeComposerImages.length + clipboardImageLoadsRef.current >=
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      store.setStatus(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images.`,
        "error",
      );
      return;
    }
    const extension = imageExtensionForMimeType(paste.mimeType);
    if (!extension) {
      store.setStatus("Paste a supported image format.", "error");
      return;
    }

    clipboardImageSequenceRef.current += 1;
    const name = `clipboard-image-${clipboardImageSequenceRef.current}.${extension}`;
    clipboardImageLoadsRef.current += 1;
    store.setStatus("Adding pasted image…", "busy");
    void prepareComposerImageBytes(name, paste.mimeType, paste.bytes)
      .then((image) => {
        updateActiveComposerImages((current) =>
          current.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS ? current : [...current, image],
        );
        store.setStatus(`Attached ${image.upload.name}.`, "success");
      })
      .catch((error) => {
        store.setStatus(
          error instanceof Error ? error.message : "Could not attach pasted image.",
          "error",
        );
      })
      .finally(() => {
        clipboardImageLoadsRef.current = Math.max(0, clipboardImageLoadsRef.current - 1);
      });
  };

  const toggleFocus = () => {
    if (activeTerminal) setTerminalFocused((focused) => !focused);
  };

  const resizeTerminal = (delta: number) => {
    if (!activeTerminal) return;
    setTerminalHeight((current) => Math.max((current ?? Math.floor(height * 0.4)) + delta, 6));
  };

  const resizePrompt = (delta: number) => {
    setPromptHeight((current) =>
      Math.min(Math.max((current ?? autoPromptLines) + delta, 1), COMPOSER_MAX_EDITOR_ROWS),
    );
  };

  // ^G: edit the current draft in $EDITOR. Release the terminal (suspend), run the
  // editor on a temp file, then read it back into the prompt and re-take the screen.
  const editInEditor = () => {
    if (terminalFocused) return;
    const draftText = composerText;
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
        getKittyImageManager(renderer).clearImages();
        renderer.suspend();
        try {
          await new Promise<void>((resolve) => {
            const child = NodeChildProcess.spawn(cmd, [...args, file], { stdio: "inherit" });
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
          });
        } finally {
          renderer.resume();
          renderer.requestRender();
        }
        const edited = normalizeEditedPrompt(await NodeFSP.readFile(file, "utf8"));
        if (focus === "new") setDraft(edited);
        else setReply(edited);
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
    if (detail && focus !== "new") {
      list.push({
        id: "plan",
        title: threadInteractionMode === "plan" ? "Switch to build mode" : "Switch to plan mode",
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
            void (
              archived ? client.unarchiveThread(detail.id) : client.archiveThread(detail.id)
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
        list.push({
          id: "implement",
          title: "Implement plan",
          hint: "^Y",
          run: () => runCommand(implementPlan),
        });
      }
    }
    if (focus === "new") {
      list.push(
        {
          id: "workspace",
          title: "Change workspace",
          keywords: "checkout worktree",
          run: () => runCommand(openWorkspacePicker),
        },
        {
          id: "branch",
          title: newWorkspaceMode === "new-worktree" ? "Change base branch" : "Change branch",
          keywords: "git ref",
          run: () => runCommand(openBranchPicker),
        },
        {
          id: "model",
          title: "Change model",
          run: () => runCommand(openModelPicker),
        },
        {
          id: "reasoning",
          title: "Change reasoning effort",
          run: () => runCommand(openReasoningPicker),
        },
        {
          id: "runtime",
          title: "Change runtime access",
          hint: "^O",
          run: () => runCommand(openRuntimePicker),
        },
      );
    }
    list.push({
      id: "terminal",
      title: activeTerminal ? "Hide terminal" : "Show terminal",
      hint: "^E",
      run: () => runCommand(toggleTerminal),
    });
    if (detail) {
      list.push({
        id: "terminal-new",
        title: "New terminal",
        keywords: "shell group tab",
        run: () => runCommand(newTerminal),
      });
    }
    if (detailTabs && detailTabs.ids.length > 1) {
      list.push({
        id: "terminal-next",
        title: "Next terminal",
        keywords: "tab",
        run: () => runCommand(() => cycleTerminal(1)),
      });
      list.push({
        id: "terminal-prev",
        title: "Previous terminal",
        keywords: "tab",
        run: () => runCommand(() => cycleTerminal(-1)),
      });
    }
    if (terminalOpen && detailTabs) {
      list.push({
        id: "terminal-clear",
        title: "Clear terminal",
        keywords: "shell history reset",
        run: () => runCommand(clearActiveTerminal),
      });
      list.push({
        id: "terminal-restart",
        title: "Restart terminal",
        keywords: "shell reset relaunch",
        run: () => runCommand(restartActiveTerminal),
      });
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
      run: () => runCommand(toggleRightPanel),
    });
    list.push({
      id: "filter",
      title: "Filter threads",
      hint: "^F",
      keywords: "search",
      run: () => runCommand(() => setFocus("filter")),
    });
    if (detail || focus === "new") {
      list.push({
        id: "files",
        title: "Browse files",
        keywords: "workspace open file",
        run: () => runCommand(openFiles),
      });
      if (
        (focus === "new" || !pendingUserInput) &&
        activeComposerImages.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ) {
        list.push({
          id: "attach-image",
          title: "Attach image",
          keywords: "image picture workspace upload",
          run: () => runCommand(() => openFiles("attach-image")),
        });
      }
      if (activeComposerImages.length > 0) {
        list.push({
          id: "remove-attachment",
          title: "Remove last attachment",
          keywords: "image clear",
          run: () =>
            runCommand(() => {
              updateActiveComposerImages((current) => current.slice(0, -1));
            }),
        });
      }
    }
    list.push({
      id: "settings",
      title: "Settings",
      keywords: "keybindings reference help providers",
      run: () => runCommand(() => setSettingsOpen(true)),
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    detail,
    checkpoints.length,
    activeTerminal,
    detailTabs,
    terminalOpen,
    rightPanelOpen,
    actionablePlan,
    activeComposerImages,
    focus,
    pendingUserInput,
    threadModelSelection,
    threadInteractionMode,
    newWorkspaceMode,
    newBranchRefs,
    newBranchRefsStatus,
    newBranch,
    newContextWorktreePath,
    activeProjectIndex,
  ]);

  const filteredCommands = React.useMemo(
    () => filterCommands(paletteCommands, commandQuery),
    [paletteCommands, commandQuery],
  );
  // Clamp at use: the command list can shrink while the palette is open (a turn
  // finishes, a tab closes), which would otherwise leave commandIndex past the
  // end — no highlight, Enter no-ops.
  const safeCommandIndex = Math.min(commandIndex, Math.max(0, filteredCommands.length - 1));

  const keyMode = expandedImage
    ? "imagePreview"
    : activeTerminal && terminalFocused
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
                    : focus === "rename"
                      ? "rename"
                      : focus === "filter"
                        ? "filter"
                        : focus === "commit"
                          ? "commit"
                          : rightPanelVisible && rightPanelFocused
                            ? "panel"
                            : composerUserInputActive
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
    onTerminalScroll: (action) => terminalScrollRef.current?.(action),
    onImagePreviewClose: closeExpandedImage,
    onToggleFocus: toggleFocus,
    // Plain arrows stay with the composer except while choosing between multiple
    // pending approvals. Threads use the explicit Alt+↑/↓ shortcuts or mouse.
    approvalNavigation: focus !== "new" && approvals.length > 1 && reply.length === 0,
    onApprovalPrev: () =>
      setApprovalIndex((index) => (index <= 0 ? approvals.length - 1 : index - 1)),
    onApprovalNext: () => setApprovalIndex((index) => (index + 1) % approvals.length),
    onScrollUp: () => {
      const box = scrollRef.current;
      getKittyImageManager(renderer).pauseForScroll();
      box?.scrollBy({ x: 0, y: -SCROLL_STEP });
    },
    onScrollDown: () => {
      getKittyImageManager(renderer).pauseForScroll();
      scrollRef.current?.scrollBy({ x: 0, y: SCROLL_STEP });
    },
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
    onToggleRightPanel: toggleRightPanel,
    onPanelPrev: () =>
      setRightPanelIndex((index) =>
        rightPanelActions.length === 0
          ? 0
          : (index - 1 + rightPanelActions.length) % rightPanelActions.length,
      ),
    onPanelNext: () =>
      setRightPanelIndex((index) =>
        rightPanelActions.length === 0 ? 0 : (index + 1) % rightPanelActions.length,
      ),
    onPanelActivate: () => {
      const action = rightPanelActions[safeRightPanelIndex];
      if (action) activateRightPanelAction(action);
    },
    onPanelClose: () => {
      setRightPanelFocused(false);
      if (rightPanelAsMain) setRightPanelOpen(false);
    },
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
        filteredCommands.length === 0
          ? 0
          : (index - 1 + filteredCommands.length) % filteredCommands.length,
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
    onOpenModel: openModelPicker,
    onOpenReasoning: openReasoningPicker,
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
    onSend: focus === "new" ? submitNewThread : sendReply,
    onEscape: () => {
      if (focus === "new") {
        if (newSubmissionPendingRef.current) return;
        if (newContextMutationPendingRef.current) {
          store.setStatus("Wait for the branch switch to finish.", "info");
          return;
        }
        setDraft("");
        setNewComposerImages([]);
        setNewBranch(null);
        setNewContextWorktreePath(null);
        newDraftOriginSelectionRef.current = null;
        setComposerEpoch((epoch) => epoch + 1);
        setFocus("compose");
        return;
      }
      if (reply.length > 0) {
        clearReply();
        return;
      }
      stopTurn();
    },
  });

  const placeholder =
    focus === "new"
      ? "Ask anything, @tag files/folders, $use skills, or / for commands"
      : detail
        ? "Ask anything, @tag files/folders, $use skills, or / for commands"
        : state.selection?.kind === "project"
          ? "Enter to expand · Alt+↑/↓ to pick a thread"
          : "Select a thread with Alt+↑/↓ or click";

  // Contextual footer: only show keys that apply now (^Y with a plan, ^A/^R with
  // approvals). The persistent state (^B/^O/model/reasoning) lives in the controls
  // row, so it isn't duplicated here.
  const composeHint = [
    "Alt+↑/↓ threads",
    "Enter send",
    "^G editor",
    "^↑/^↓ size",
    "^N new",
    "^E term",
    ...(focus !== "new" && actionablePlan ? ["^Y implement"] : []),
    ...(focus !== "new" && approvals.length > 0
      ? [approvals.length > 1 ? "^A/^R approve (↑/↓)" : "^A/^R approve"]
      : []),
    "^K commands",
    "^F find",
    `^L panel ${rightPanelOpen ? "▾" : "▸"}`,
    ...(composerWorking ? ["Esc stop"] : focus === "new" ? ["Esc cancel"] : []),
    "^C quit",
  ].join(" · ");
  const hint = expandedImage
    ? "image preview · Esc or click to close · ^C quit"
    : focus !== "new" && pendingUserInput && userInputDeferred
      ? "⚠ question pending — ^U to answer · ^C quit"
      : activeTerminal
        ? "^P prompt · ^E close term · ^↑/^↓ size term · keys → shell"
        : composeHint;

  const statusStyle = statusGlyphColor(state.statusKind);
  const selectRightPanelAction = (index: number) => {
    setTerminalFocused(false);
    setRightPanelIndex(index);
    setRightPanelFocused(true);
  };
  const rightPanelProps = {
    status: state.vcsStatus,
    busy: state.gitBusy,
    actions: rightPanelActions,
    selectedIndex: safeRightPanelIndex,
    focused: rightPanelFocused,
    height: panesHeight,
    onSelect: selectRightPanelAction,
    onActivate: activateRightPanelAction,
  } as const;
  const statusLabel = `${statusStyle.glyph} ${state.status}`;
  const statusWidth = Math.min(
    Math.max(0, mainWidth - 2),
    Math.max(8, Math.min(32, statusLabel.length)),
  );
  const hintWidth = Math.max(0, mainWidth - 2 - statusWidth);

  return (
    <box flexDirection="row" width={width} height={height}>
      {sidebarVisible || sidebarAsMain ? (
        <Sidebar
          rows={listRows}
          selection={state.selection}
          moreAbove={moreAbove}
          moreBelow={moreBelow}
          width={sidebarAsMain ? width : listWidth}
          height={height}
          store={store}
          filter={state.filter}
          searchFocused={focus === "filter" && !terminalFocused && !diffOpen && !picker}
          onSearchInput={store.setFilter}
          onFocusSearch={() => setFocus("filter")}
        />
      ) : null}

      {!sidebarAsMain ? (
        <box flexDirection="column" width={mainWidth} height={height} flexShrink={0}>
          <box height={panesHeight} flexShrink={0} flexDirection="row">
            <box width={chatWidth} height={panesHeight} flexShrink={0}>
              {rightPanelAsMain ? (
                <RightPanel {...rightPanelProps} width={chatWidth} />
              ) : settingsOpen ? (
                <SettingsView
                  controls={controls}
                  vcsStatus={state.vcsStatus}
                  width={chatWidth}
                  height={panesHeight}
                  scrollRef={settingsScrollRef}
                />
              ) : filesOpen ? (
                <FilesView
                  cwdLabel={composerCwd}
                  status={filesStatus}
                  rows={fileRows}
                  selectedIndex={filesIndex}
                  viewing={viewingFile}
                  width={chatWidth}
                  height={panesHeight}
                  syntaxStyle={syntaxStyle}
                  scrollRef={filesScrollRef}
                  purpose={filesPurpose}
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
              ) : expandedImage ? (
                <ImageLightbox
                  preview={expandedImage}
                  width={chatWidth}
                  height={panesHeight}
                  onClose={closeExpandedImage}
                />
              ) : (
                <MessagesTimeline
                  detail={focus === "new" ? null : detail}
                  approvals={focus === "new" ? [] : approvals}
                  approvalIndex={activeApprovalIndex}
                  projectHint={selectedProjectTitle}
                  {...(focus === "new"
                    ? {
                        emptyHint: `${projects[activeProjectIndex]?.title ?? "New thread"} — describe the task below.`,
                      }
                    : {})}
                  width={chatWidth}
                  height={panesHeight}
                  syntaxStyle={syntaxStyle}
                  scrollRef={scrollRef}
                  onOpenDiff={openDiffAtTurn}
                  getAttachmentUrl={client.getAttachmentUrl}
                  getAttachmentImage={client.getAttachmentImage}
                  onOpenUrl={(url) => store.setStatus(url, "info")}
                  onOpenImage={openExpandedImage}
                />
              )}
            </box>
            {rightPanelVisible && !rightPanelAsMain ? (
              <RightPanel {...rightPanelProps} width={rightWidth} />
            ) : null}
          </box>

          {/* Popovers float ABOVE the still-present composer (mirroring the web's
            dropdowns), rather than replacing it. */}
          {picker ? (
            <SelectOverlay
              title={picker.title}
              status={picker.status}
              options={picker.options}
              selectedIndex={picker.selectedIndex}
              width={Math.max(1, mainWidth - 4)}
              maxRows={pickerContentRows}
              onSelect={(index) => applyPicker(index)}
            />
          ) : overlay === "command" ? (
            <CommandPalette
              commands={filteredCommands}
              selectedIndex={safeCommandIndex}
              query={commandQuery}
              width={Math.max(1, mainWidth - 4)}
              maxRows={Math.max(1, pickerContentRows - 1)}
              onInput={(value) => {
                setCommandQuery(value);
                setCommandIndex(0);
              }}
              onRun={(index) => filteredCommands[index]?.run()}
            />
          ) : overlay === "revert" && detail ? (
            <RevertMenu
              checkpoints={checkpoints}
              selected={Math.min(revertIndex, checkpoints.length - 1)}
            />
          ) : overlay === "confirmDelete" && detail ? (
            <ConfirmDeleteMenu title={detail.title} />
          ) : null}

          <ComposerDock
            leftWidth={0}
            mainWidth={chatWidth}
            rightWidth={rightWidth}
            surfaceWidth={composerSurfaceWidth}
            context={composerContext}
          >
            <ChatComposer
              // Search/filter now lives in the sidebar; the composer never owns it.
              mode={focus === "filter" || focus === "new" ? "compose" : focus}
              reply={composerText}
              auxValue={focus === "rename" ? renameDraft : focus === "commit" ? commitDraft : ""}
              placeholder={placeholder}
              editorRows={promptLines}
              inputFocused={composerInputFocused}
              composerEpoch={composerEpoch}
              controls={controls}
              working={composerWorking}
              attachments={activeComposerImages}
              inlineImagesSupported={inlineImagesSupported}
              width={composerSurfaceWidth}
              pendingUserInput={composerUserInputActive ? pendingUserInput : null}
              uiQuestionIndex={uiQuestionIndex}
              uiOptionIndex={uiOptionIndex}
              uiSelectedLabels={uiSelectedLabels}
              answerDraft={customAnswer}
              onAnswerInput={setCustomAnswer}
              onReplyInput={focus === "new" ? setDraft : setReply}
              onReplySubmit={focus === "new" ? submitNewThread : sendReply}
              onAuxInput={focus === "commit" ? setCommitDraft : setRenameDraft}
              onTogglePlan={togglePlanMode}
              onOpenAccess={openRuntimePicker}
              onOpenModel={openModelPicker}
              onOpenReasoning={openReasoningPicker}
              onStop={stopTurn}
              onSend={focus === "new" ? submitNewThread : sendReply}
              onSubmitAnswer={submitUserInput}
              onRemoveAttachment={removeStagedComposerImage}
              onPasteImage={pasteComposerImage}
            />
          </ComposerDock>

          {activeTerminal && detailTabs && terminalDrawerHeight >= 6 ? (
            <ThreadTerminalDrawer
              client={client}
              info={activeTerminal}
              cols={termCols}
              rows={termRows}
              focused={terminalFocused}
              copyRef={terminalCopyRef}
              scrollRef={terminalScrollRef}
              tabIds={detailTabs.ids}
              activeTabId={detailTabs.activeId}
              onSelectTab={selectTerminal}
              onNewTab={newTerminal}
              onCloseTab={closeTerminal}
            />
          ) : null}

          <box
            flexDirection="row"
            justifyContent="space-between"
            paddingLeft={1}
            paddingRight={1}
            flexShrink={0}
            overflow="hidden"
          >
            <text fg={palette.dim}>{clip(hint, hintWidth)}</text>
            <text fg={statusStyle.color}>{clip(statusLabel, statusWidth)}</text>
          </box>
        </box>
      ) : null}
    </box>
  );
}

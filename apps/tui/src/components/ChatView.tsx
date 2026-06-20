import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import {
  DEFAULT_TERMINAL_ID,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";

import { derivePendingApprovals } from "../approvals.ts";
import { normalizeEditedPrompt, resolveEditorCommand } from "../promptEditor.ts";
import type { TuiClient } from "../connection.ts";
import { useKeyBindings } from "../hooks/useKeyBindings.ts";
import { latestActionableProposedPlan } from "../proposedPlan.ts";
import { createStore } from "../store.ts";
import { statusGlyphColor, usePalette } from "../theme.ts";
import { currentModelIndex, type ModelOption } from "../models.ts";
import { revertableCheckpoints } from "../timeline.ts";
import { buildUserInputAnswers, derivePendingUserInputs } from "../userInput.ts";
import { buildRows, selectionEquals } from "./Sidebar.logic.ts";
import { ChatComposer } from "./ChatComposer.tsx";
import { type DiffStatus, DiffViewer } from "./DiffViewer.tsx";
import { MessagesTimeline } from "./MessagesTimeline.tsx";
import { ModelPicker, type ModelPickerStatus } from "./ModelPicker.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { RevertMenu, ThreadActionsMenu } from "./ThreadActionsMenu.tsx";
import { UserInputForm } from "./UserInputForm.tsx";
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
  const renderer = useRenderer();
  const palette = usePalette();
  const store = React.useMemo(() => createStore(client), [client]);
  const syntaxStyle = React.useMemo(() => SyntaxStyle.create(), []);
  const state = React.useSyncExternalStore(store.subscribe, store.getState);

  React.useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const [focus, setFocus] = React.useState<"compose" | "new" | "rename" | "filter">("compose");
  // Transient key-driven overlay over the composer (thread actions / delete confirm / revert).
  const [overlay, setOverlay] = React.useState<"none" | "actions" | "confirmDelete" | "revert">(
    "none",
  );
  const [revertIndex, setRevertIndex] = React.useState(0);
  // Turn diff viewer (^K → g): which checkpoint's diff, its fetch state, the text.
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [diffIndex, setDiffIndex] = React.useState(0);
  const [diffStatus, setDiffStatus] = React.useState<DiffStatus>("loading");
  const [diffText, setDiffText] = React.useState("");
  const diffScrollRef = React.useRef<ScrollBoxRenderable | null>(null);
  // Model picker (^K → m): fetched lazily on open.
  const [modelOpen, setModelOpen] = React.useState(false);
  const [modelIndex, setModelIndex] = React.useState(0);
  const [modelStatus, setModelStatus] = React.useState<ModelPickerStatus>("loading");
  const [modelOptions, setModelOptions] = React.useState<ModelOption[]>([]);
  // Pending user-input form state.
  const [userInputDeferred, setUserInputDeferred] = React.useState(false);
  const [uiQuestionIndex, setUiQuestionIndex] = React.useState(0);
  const [uiOptionIndex, setUiOptionIndex] = React.useState(0);
  const [uiSelections, setUiSelections] = React.useState<Record<string, string[]>>({});
  const [reply, setReply] = React.useState("");
  // Bumped to remount (clear) the uncontrolled multiline reply editor.
  const [composerEpoch, setComposerEpoch] = React.useState(0);
  const [draft, setDraft] = React.useState("");
  const [renameDraft, setRenameDraft] = React.useState("");
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
  // Collapse long tool-call runs in the conversation (^T toggles).
  const [workLogExpanded, setWorkLogExpanded] = React.useState(false);
  // User-set prompt height in editor rows; null = auto-grow with content.
  const [promptHeight, setPromptHeight] = React.useState<number | null>(null);
  const [activeTerminal, setActiveTerminal] = React.useState<TerminalInfo | null>(null);
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
  const sessionActive =
    !!detail && ["starting", "running", "ready"].includes(detail.session?.status ?? "");
  const actionablePlan = React.useMemo(
    () => (detail ? latestActionableProposedPlan(detail) : null),
    [detail],
  );
  const checkpoints = React.useMemo(
    () => (detail ? revertableCheckpoints(detail.checkpoints) : []),
    [detail],
  );
  const diffCheckpoint = diffOpen ? checkpoints[Math.min(diffIndex, checkpoints.length - 1)] : null;
  const diffTurnCount = diffCheckpoint?.checkpointTurnCount ?? null;
  // Fetch the selected turn's diff whenever the viewer opens or the turn changes.
  React.useEffect(() => {
    if (!diffOpen || !detail || diffTurnCount === null) return;
    let cancelled = false;
    setDiffStatus("loading");
    setDiffText("");
    void client
      .getTurnDiff(detail.id, diffTurnCount)
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
  }, [client, diffOpen, detail?.id, diffTurnCount]);

  // Fetch the model list when the picker opens, seeding the cursor on the current model.
  React.useEffect(() => {
    if (!modelOpen) return;
    let cancelled = false;
    setModelStatus("loading");
    void client
      .listModels()
      .then((options) => {
        if (cancelled) return;
        setModelOptions(options);
        setModelStatus(options.length > 0 ? "ready" : "empty");
        setModelIndex(currentModelIndex(options, detail?.modelSelection ?? null));
      })
      .catch(() => {
        if (!cancelled) setModelStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [client, modelOpen, detail?.modelSelection]);

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
  const composerHeight =
    focus === "new" ? 9 : focus === "rename" || focus === "filter" ? 5 : promptLines + 4;
  const defaultTerminalHeight = Math.floor(height * 0.4);
  const maxTerminalHeight = Math.max(6, height - composerHeight - 6);
  const terminalDrawerHeight = activeTerminal
    ? Math.min(Math.max(terminalHeight ?? defaultTerminalHeight, 6), maxTerminalHeight)
    : 0;
  const bottomReserve = terminalDrawerHeight + composerHeight + 1;
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

  // ^E shows/hides the drawer (opening focuses it); ^P flips focus between the
  // prompt and the terminal (so it gets you back to the terminal too).
  const toggleTerminal = () => {
    if (activeTerminal) {
      setActiveTerminal(null);
      setTerminalFocused(false);
      return;
    }
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
    setTerminalFocused(true);
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
        dir = await mkdtemp(join(tmpdir(), "t3-prompt-"));
        const file = join(dir, "prompt.md");
        await writeFile(file, draftText, "utf8");
        const { cmd, args } = resolveEditorCommand({
          VISUAL: process.env.VISUAL,
          EDITOR: process.env.EDITOR,
        });
        renderer.suspend();
        try {
          await new Promise<void>((resolve) => {
            const child = spawn(cmd, [...args, file], { stdio: "inherit" });
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
          });
        } finally {
          renderer.resume();
        }
        const edited = normalizeEditedPrompt(await readFile(file, "utf8"));
        setReply(edited);
        setComposerEpoch((epoch) => epoch + 1);
        store.setStatus("Prompt updated from $EDITOR.", "success");
      } catch {
        store.setStatus("Could not open $EDITOR.", "error");
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    })();
  };

  const keyMode =
    activeTerminal && terminalFocused
      ? "terminal"
      : diffOpen
        ? "diff"
        : modelOpen
          ? "model"
          : overlay === "actions"
        ? "actions"
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
    onNewThread: () => {
      setProjectIndex(0);
      setNewRuntimeMode(detail?.runtimeMode ?? "full-access");
      setNewInteractionMode("default");
      setNewBranch("");
      setNewWorktree("");
      setNewField("message");
      setFocus("new");
    },
    onToggleTerminal: toggleTerminal,
    onGrowTerminal: () => resizeTerminal(2),
    onShrinkTerminal: () => resizeTerminal(-2),
    onTerminalCopy: () => {
      const text = terminalCopyRef.current?.() ?? "";
      if (text.length === 0) {
        store.setStatus("Terminal is empty.", "info");
        return;
      }
      const copied = renderer.copyToClipboardOSC52(text);
      store.setStatus(
        copied ? "Terminal copied to clipboard." : "Clipboard not supported by this terminal.",
        copied ? "success" : "error",
      );
    },
    onGrowPrompt: () => resizePrompt(2),
    onShrinkPrompt: () => resizePrompt(-2),
    onEditInEditor: editInEditor,
    onTogglePlanMode: () => {
      if (!detail) return;
      const next = detail.interactionMode === "plan" ? "default" : "plan";
      void client.setInteractionMode(detail.id, next).catch(() => {});
      store.setStatus(next === "plan" ? "Plan mode." : "Build mode.", "success");
    },
    onImplementPlan: () => {
      if (!detail || !actionablePlan) return;
      void client
        .implementPlan(detail, actionablePlan.id)
        .catch((error) => store.setStatus(`implement failed: ${String(error)}`, "error"));
      store.setStatus("Implementing plan…", "busy");
    },
    onToggleWorkLog: () => setWorkLogExpanded((expanded) => !expanded),
    onOpenActions: () => {
      if (!detail) {
        store.setStatus("Select a thread first.");
        return;
      }
      setOverlay("actions");
    },
    onActionRename: () => {
      if (!detail) return;
      setRenameDraft(detail.title);
      setOverlay("none");
      setFocus("rename");
    },
    onActionArchive: () => {
      if (!detail) return;
      const archived = detail.archivedAt !== null;
      void (archived ? client.unarchiveThread(detail.id) : client.archiveThread(detail.id)).catch(
        () => {},
      );
      setOverlay("none");
      store.setStatus(archived ? "Unarchived." : "Archived.", "success");
    },
    onActionDelete: () => {
      if (!detail) return;
      setOverlay("confirmDelete");
    },
    onActionStop: () => {
      if (!detail) return;
      void client.stopSession(detail.id).catch(() => {});
      setOverlay("none");
      store.setStatus("Session stopped.", "success");
    },
    onActionRevert: () => {
      if (!detail) return;
      if (checkpoints.length === 0) {
        setOverlay("none");
        store.setStatus("No checkpoints to revert to.");
        return;
      }
      setRevertIndex(0);
      setOverlay("revert");
    },
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
    onUserInputConfirm: () => {
      if (!detail || !pendingUserInput || !uiQuestion) return;
      // Plain Enter on a single-select question picks the highlighted option.
      let selections = uiSelections;
      if (!uiQuestion.multiSelect) {
        const option = uiQuestion.options[uiOptionIndex];
        if (option) selections = { ...uiSelections, [uiQuestion.id]: [option.label] };
      }
      if ((selections[uiQuestion.id]?.length ?? 0) === 0) {
        store.setStatus("Select an option first.");
        return;
      }
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
    },
    onUserInputDefer: () => setUserInputDeferred(true),
    onReopenUserInput: () => {
      if (pendingUserInput) setUserInputDeferred(false);
    },
    onActionDiff: () => {
      if (!detail) return;
      if (checkpoints.length === 0) {
        setOverlay("none");
        store.setStatus("No turn diffs yet.");
        return;
      }
      setOverlay("none");
      setDiffIndex(0);
      setDiffOpen(true);
    },
    onDiffPrev: () =>
      setDiffIndex((index) => (index <= 0 ? checkpoints.length - 1 : index - 1)),
    onDiffNext: () => setDiffIndex((index) => (index + 1) % Math.max(checkpoints.length, 1)),
    onDiffScrollUp: () => diffScrollRef.current?.scrollBy({ x: 0, y: -SCROLL_STEP }),
    onDiffScrollDown: () => diffScrollRef.current?.scrollBy({ x: 0, y: SCROLL_STEP }),
    onDiffClose: () => setDiffOpen(false),
    onActionModel: () => {
      if (!detail) return;
      setOverlay("none");
      setModelOptions([]);
      setModelIndex(0);
      setModelOpen(true);
    },
    onModelPrev: () =>
      setModelIndex((index) => (index <= 0 ? Math.max(modelOptions.length - 1, 0) : index - 1)),
    onModelNext: () => setModelIndex((index) => (index + 1) % Math.max(modelOptions.length, 1)),
    onModelConfirm: () => {
      const option = modelOptions[Math.min(modelIndex, modelOptions.length - 1)];
      setModelOpen(false);
      if (!detail || !option) return;
      void client
        .setModel(detail.id, option.instanceId, option.model)
        .catch((error) => store.setStatus(`model change failed: ${String(error)}`, "error"));
      store.setStatus(`Model → ${option.label}`, "success");
    },
    onModelClose: () => setModelOpen(false),
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
    onInterrupt: () => {
      if (!detail) return;
      void client.interrupt(detail.id).catch(() => {});
      store.setStatus("Interrupt sent.", "success");
    },
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
    onCycleMode: () => {
      if (!detail) return;
      const current = RUNTIME_MODES.indexOf(detail.runtimeMode);
      const nextMode = RUNTIME_MODES[(current + 1) % RUNTIME_MODES.length] ?? "full-access";
      void client.setRuntimeMode(detail.id, nextMode).catch(() => {});
      store.setStatus(`Mode → ${nextMode}`, "success");
    },
    onSend: sendReply,
    onEscape: () => {
      if (reply.length > 0) {
        clearReply();
        return;
      }
      if (detail) {
        void client.interrupt(detail.id).catch(() => {});
        store.setStatus("Interrupt sent.", "success");
      }
    },
  });

  const placeholder = detail
    ? "Type a reply, Enter to send"
    : state.selection?.kind === "project"
      ? "Enter to expand · ↑/↓ to move"
      : "Select a thread with ↑/↓";

  const hint =
    pendingUserInput && userInputDeferred
      ? "⚠ question pending — ^U to answer · ^C quit"
      : activeTerminal
        ? "^P prompt · ^E close term · ^↑/^↓ size term · keys → shell"
        : "↑/↓ · Enter send · ^↑/^↓ size · ^G editor · ^N new · ^B plan/build · ^Y implement · ^O mode · ^E term · ^T tools · ^A/^R approve · ^K actions · ^F find · Esc stop · ^C quit";

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
        />
        {diffOpen && diffCheckpoint ? (
          <DiffViewer
            turnCount={diffCheckpoint.checkpointTurnCount}
            fileCount={diffCheckpoint.files.length}
            status={diffStatus}
            diff={diffText}
            height={panesHeight}
            syntaxStyle={syntaxStyle}
            scrollRef={diffScrollRef}
          />
        ) : (
          <MessagesTimeline
            detail={detail}
            approvals={approvals}
            approvalIndex={activeApprovalIndex}
            projectHint={selectedProjectTitle}
            workLogCollapsed={!workLogExpanded}
            width={chatWidth}
            height={panesHeight}
            syntaxStyle={syntaxStyle}
            scrollRef={scrollRef}
          />
        )}
      </box>

      {activeTerminal ? (
        <ThreadTerminalDrawer
          client={client}
          info={activeTerminal}
          cols={termCols}
          rows={termRows}
          focused={terminalFocused}
          copyRef={terminalCopyRef}
        />
      ) : null}

      {modelOpen && detail ? (
        <ModelPicker
          options={modelOptions}
          selected={Math.min(modelIndex, Math.max(modelOptions.length - 1, 0))}
          status={modelStatus}
          currentInstanceId={detail.modelSelection?.instanceId ?? null}
          currentModel={detail.modelSelection?.model ?? null}
          width={chatWidth}
        />
      ) : overlay === "revert" && detail ? (
        <RevertMenu checkpoints={checkpoints} selected={Math.min(revertIndex, checkpoints.length - 1)} />
      ) : (overlay === "actions" || overlay === "confirmDelete") && detail ? (
        <ThreadActionsMenu
          overlay={overlay}
          title={detail.title}
          archived={detail.archivedAt !== null}
          sessionRunning={sessionActive}
        />
      ) : keyMode === "userInput" && pendingUserInput ? (
        <UserInputForm
          pending={pendingUserInput}
          questionIndex={uiQuestionIndex}
          optionIndex={uiOptionIndex}
          selectedLabels={uiSelectedLabels}
          width={chatWidth}
        />
      ) : (
        <ChatComposer
          mode={focus}
          reply={reply}
          draft={draft}
          auxValue={focus === "rename" ? renameDraft : focus === "filter" ? state.filter : ""}
          placeholder={placeholder}
          projectName={projects[activeProjectIndex]?.title ?? "(none)"}
          interactionMode={focus === "new" ? newInteractionMode : (detail?.interactionMode ?? "default")}
          newRuntimeMode={newRuntimeMode}
          newBranch={newBranch}
          newWorktree={newWorktree}
          newField={newField}
          editorRows={promptLines}
          inputFocused={!terminalFocused && !diffOpen && !modelOpen}
          composerEpoch={composerEpoch}
          onReplyInput={setReply}
          onReplySubmit={sendReply}
          onDraftInput={(value) => setDraft(value.replace(/\t/g, ""))}
          onBranchInput={(value) => setNewBranch(value.replace(/\t/g, ""))}
          onWorktreeInput={(value) => setNewWorktree(value.replace(/\t/g, ""))}
          onAuxInput={focus === "rename" ? setRenameDraft : store.setFilter}
        />
      )}

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

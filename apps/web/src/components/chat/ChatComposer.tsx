import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  ProjectEntry,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderKind,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ServerLocalAgentInventory,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@forma/contracts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@forma/contracts";
import { createModelSelection, normalizeModelSlug } from "@forma/shared/model";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../../composer-logic";
import { deriveComposerSendState, readFileAsDataUrl } from "../ChatView.logic";
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import {
  type CodeContextDraft,
  type CodeContextSelection,
  insertInlineCodeContextPlaceholder,
  removeInlineCodeContextPlaceholder,
} from "../../lib/codeContext";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
} from "../../lib/terminalContext";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ComposerAddActionsMenu } from "./ComposerAddActionsMenu";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerInteractionModePill } from "./ComposerInteractionModePill";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerQueuedTurnsPanel } from "./ComposerQueuedTurnsPanel";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { basenameOfPath } from "../../vscode-icons";
import { cn, randomUUID } from "~/lib/utils";
import { Separator } from "../ui/separator";
import { Button } from "../ui/button";
import { MenuCreateHandle } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { IconQuestionmarkBubble as AskIcon, IconXmark as XIcon } from "symbols-react";
import { SidebarPlanReadyIcon } from "../icons/custom";
import { proposedPlanTitle } from "../../proposedPlan";
import {
  getProviderInteractionModeToggle,
  getProviderModels,
  resolveSelectableProvider,
} from "../../providerModels";
import type { UnifiedSettings } from "@forma/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";

function isLocalAgentSkill(
  skill:
    | ServerLocalAgentInventory["skills"][number]
    | NonNullable<ServerProvider["skills"]>[number],
): skill is ServerLocalAgentInventory["skills"][number] {
  return "source" in skill && skill.source === "local-agents";
}

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncContextsByIds = <T extends { id: string }>(
  contexts: ReadonlyArray<T>,
  ids: ReadonlyArray<string>,
): T[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const contextIdListsEqual = <T extends { id: string }>(
  contexts: ReadonlyArray<T>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  turnQueueStatus: Thread["turnQueue"]["status"];
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  hasSendableContent: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      {props.isPreparingWorktree ? (
        <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        turnQueueStatus={props.turnQueueStatus}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        isConnecting={props.isConnecting}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  isModelPickerOpen: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
    codeContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Insert a code context from the diff editor. */
  addCodeContext: (
    selection: CodeContextSelection,
    options?: {
      focusComposerAfterInsert?: boolean;
    },
  ) => boolean;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    terminalContexts: TerminalContextDraft[];
    codeContexts: CodeContextDraft[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    selectedProvider: ProviderKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  };
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  turnQueue: Thread["turnQueue"];
  isServerThread: boolean;
  isLocalDraftThread: boolean;

  // Session phase
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  isPreparingWorktree: boolean;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: { id: string } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  activePlan: { turnId?: TurnId } | null;
  sidebarProposedPlan: { turnId?: TurnId } | null;
  planSidebarLabel: string;
  planSidebarOpen: boolean;

  // Mode
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;

  localAgentInventory: ServerLocalAgentInventory;
  localAgentInventoryLoading: boolean;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;

  // Refs the parent needs kept in sync
  promptRef: React.MutableRefObject<string>;
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.MutableRefObject<TerminalContextDraft[]>;
  composerCodeContextsRef: React.MutableRefObject<CodeContextDraft[]>;

  // Scroll
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  scheduleStickToBottom: () => void;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }) => void;
  onInterrupt: () => void;
  onRemoveQueuedTurn: (messageId: Thread["turnQueue"]["items"][number]["messageId"]) => void;
  onResumeTurnQueue: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (provider: ProviderKind, model: string) => void;
  toggleInteractionMode: () => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  togglePlanSidebar: () => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(
  forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(props, ref) {
    const {
      composerDraftTarget,
      environmentId,
      routeKind,
      routeThreadRef,
      draftId,
      activeThreadId,
      activeThreadEnvironmentId: _activeThreadEnvironmentId,
      activeThread,
      turnQueue,
      isServerThread: _isServerThread,
      isLocalDraftThread: _isLocalDraftThread,
      phase,
      isConnecting,
      isSendBusy,
      isPreparingWorktree,
      activePendingApproval,
      pendingApprovals,
      pendingUserInputs,
      activePendingProgress,
      activePendingResolvedAnswers,
      activePendingIsResponding,
      activePendingDraftAnswers,
      activePendingQuestionIndex,
      respondingRequestIds,
      showPlanFollowUpPrompt,
      activeProposedPlan,
      activePlan,
      sidebarProposedPlan,
      planSidebarLabel,
      planSidebarOpen,
      interactionMode,
      lockedProvider,
      providerStatuses,
      activeProjectDefaultModelSelection,
      activeThreadModelSelection,
      localAgentInventory,
      localAgentInventoryLoading,
      resolvedTheme,
      settings,
      keybindings,
      terminalOpen,
      gitCwd,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerCodeContextsRef,
      shouldAutoScrollRef,
      scheduleStickToBottom,
      onSend,
      onInterrupt,
      onRemoveQueuedTurn,
      onResumeTurnQueue,
      onImplementPlanInNewThread,
      onRespondToApproval,
      onSelectActivePendingUserInputOption,
      onAdvanceActivePendingUserInput,
      onPreviousActivePendingUserInputQuestion,
      onChangeActivePendingUserInputCustomAnswer,
      onProviderModelSelect,
      toggleInteractionMode,
      handleInteractionModeChange,
      togglePlanSidebar,
      focusComposer,
      scheduleComposerFocus,
      setThreadError,
      onExpandImage,
    } = props;

    // ------------------------------------------------------------------
    // Store subscriptions (prompt / images / terminal contexts)
    // ------------------------------------------------------------------
    const composerDraft = useComposerThreadDraft(composerDraftTarget);
    const prompt = composerDraft.prompt;
    const composerImages = composerDraft.images;
    const composerTerminalContexts = composerDraft.terminalContexts;
    const composerCodeContexts = composerDraft.codeContexts;
    const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;

    const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
    const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
    const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
    const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
    const insertComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.insertTerminalContext,
    );
    const insertComposerDraftCodeContext = useComposerDraftStore(
      (store) => store.insertCodeContext,
    );
    const removeComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.removeTerminalContext,
    );
    const removeComposerDraftCodeContext = useComposerDraftStore(
      (store) => store.removeCodeContext,
    );
    const setComposerDraftTerminalContexts = useComposerDraftStore(
      (store) => store.setTerminalContexts,
    );
    const setComposerDraftCodeContexts = useComposerDraftStore((store) => store.setCodeContexts);
    const clearComposerDraftPersistedAttachments = useComposerDraftStore(
      (store) => store.clearPersistedAttachments,
    );
    const syncComposerDraftPersistedAttachments = useComposerDraftStore(
      (store) => store.syncPersistedAttachments,
    );
    const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

    // ------------------------------------------------------------------
    // Model state
    // ------------------------------------------------------------------
    const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
    const threadProvider =
      activeThreadModelSelection?.provider ?? activeProjectDefaultModelSelection?.provider ?? null;

    const unlockedSelectedProvider = resolveSelectableProvider(
      providerStatuses,
      selectedProviderByThreadId ?? threadProvider ?? "codex",
    );
    const selectedProvider: ProviderKind = lockedProvider ?? unlockedSelectedProvider;

    const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
      threadRef: composerDraftTarget,
      providers: providerStatuses,
      selectedProvider,
      threadModelSelection: activeThreadModelSelection,
      projectModelSelection: activeProjectDefaultModelSelection,
      settings,
    });

    const selectedProviderModels = getProviderModels(providerStatuses, selectedProvider);
    const selectedProviderStatus = useMemo(
      () => providerStatuses.find((provider) => provider.provider === selectedProvider),
      [providerStatuses, selectedProvider],
    );
    const allComposerSkills = useMemo(
      () => [...localAgentInventory.skills, ...(selectedProviderStatus?.skills ?? [])],
      [localAgentInventory.skills, selectedProviderStatus?.skills],
    );
    const hasEnabledComposerSkills = useMemo(
      () => allComposerSkills.some((skill) => skill.enabled),
      [allComposerSkills],
    );

    const composerProviderState = useMemo(
      () =>
        getComposerProviderState({
          provider: selectedProvider,
          model: selectedModel,
          models: selectedProviderModels,
          prompt,
          modelOptions: composerModelOptions?.[selectedProvider],
        }),
      [composerModelOptions, prompt, selectedModel, selectedProvider, selectedProviderModels],
    );

    const selectedPromptEffort = composerProviderState.promptEffort;
    const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
    const composerProviderControls = useMemo(
      () => ({
        showInteractionModeToggle: getProviderInteractionModeToggle(
          providerStatuses,
          selectedProvider,
        ),
      }),
      [providerStatuses, selectedProvider],
    );
    const selectedModelSelection = useMemo<ModelSelection>(
      () => createModelSelection(selectedProvider, selectedModel, selectedModelOptionsForDispatch),
      [selectedModel, selectedModelOptionsForDispatch, selectedProvider],
    );
    const selectedModelForPicker = selectedModel;
    const modelOptionsByProvider = useMemo<
      Record<ProviderKind, ReadonlyArray<ServerProvider["models"][number]>>
    >(
      () => ({
        codex: providerStatuses.find((provider) => provider.provider === "codex")?.models ?? [],
        claudeAgent:
          providerStatuses.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
        cursor: providerStatuses.find((provider) => provider.provider === "cursor")?.models ?? [],
        grok: providerStatuses.find((provider) => provider.provider === "grok")?.models ?? [],
        opencode:
          providerStatuses.find((provider) => provider.provider === "opencode")?.models ?? [],
      }),
      [providerStatuses],
    );
    const selectedModelForPickerWithCustomFallback = useMemo(() => {
      const currentOptions = modelOptionsByProvider[selectedProvider];
      return currentOptions.some((option) => option.slug === selectedModelForPicker)
        ? selectedModelForPicker
        : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
    }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);

    // ------------------------------------------------------------------
    // Composer-local state
    // ------------------------------------------------------------------
    const [composerCursor, setComposerCursor] = useState(() =>
      collapseExpandedComposerCursor(prompt, prompt.length),
    );
    const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
      detectComposerTrigger(prompt, prompt.length),
    );
    const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
    const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
      null,
    );
    const [isDragOverComposer, setIsDragOverComposer] = useState(false);
    const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
    const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
    const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
    const [composerAddActionsMenuHandle] = useState(() =>
      MenuCreateHandle<ProviderInteractionMode>(),
    );
    const composerAddActionsTriggerId = useId();

    // ------------------------------------------------------------------
    // Refs
    // ------------------------------------------------------------------
    const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
    const composerFormRef = useRef<HTMLFormElement>(null);
    const composerImageInputRef = useRef<HTMLInputElement>(null);
    const composerFormHeightRef = useRef(0);
    const composerSelectLockRef = useRef(false);
    const composerMenuOpenRef = useRef(false);
    const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
    const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
    const dragDepthRef = useRef(0);

    // ------------------------------------------------------------------
    // Derived: composer send state
    // ------------------------------------------------------------------
    const composerSendState = useMemo(
      () =>
        deriveComposerSendState({
          prompt,
          imageCount: composerImages.length,
          terminalContexts: composerTerminalContexts,
          codeContexts: composerCodeContexts,
        }),
      [composerCodeContexts, composerImages.length, composerTerminalContexts, prompt],
    );

    // ------------------------------------------------------------------
    // Derived: composer trigger / menu
    // ------------------------------------------------------------------
    const composerTriggerKind = composerTrigger?.kind ?? null;
    const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
    const isPathTrigger = composerTriggerKind === "path";
    const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
      pathTriggerQuery,
      { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
      (debouncerState) => ({ isPending: debouncerState.isPending }),
    );
    const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
    const workspaceEntriesQuery = useQuery(
      projectSearchEntriesQueryOptions({
        environmentId,
        cwd: gitCwd,
        query: effectivePathQuery,
        enabled: isPathTrigger,
        limit: 80,
      }),
    );
    const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

    const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
      if (!composerTrigger) return [];
      if (composerTrigger.kind === "path") {
        return workspaceEntries.map((entry) => ({
          id: `path:${entry.kind}:${entry.path}`,
          type: "path",
          path: entry.path,
          pathKind: entry.kind,
          label: basenameOfPath(entry.path),
          description: entry.parentPath ?? "",
        }));
      }
      if (composerTrigger.kind === "slash-command") {
        const builtInSlashCommandItems = [
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
          {
            id: "slash:plan",
            type: "slash-command",
            command: "plan",
            label: "/plan",
            description: "Switch this thread into plan mode",
          },
          {
            id: "slash:ask",
            type: "slash-command",
            command: "ask",
            label: "/ask",
            description: "Switch this thread into read-only ask mode",
          },
          {
            id: "slash:default",
            type: "slash-command",
            command: "default",
            label: "/default",
            description: "Switch this thread back to normal build mode",
          },
        ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
        const localSlashCommandItems = localAgentInventory.commands.map((command) => ({
          id: `local-slash-command:${command.path}`,
          type: "local-slash-command" as const,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.inputHint ?? "Run project command",
        }));
        const providerSlashCommandItems = (selectedProviderStatus?.slashCommands ?? []).map(
          (command) => ({
            id: `provider-slash-command:${selectedProvider}:${command.name}`,
            type: "provider-slash-command" as const,
            provider: selectedProvider,
            command,
            label: `/${command.name}`,
            description: command.description ?? command.input?.hint ?? "Run provider command",
          }),
        );
        const query = composerTrigger.query.trim().toLowerCase();
        const slashCommandItems = [
          ...builtInSlashCommandItems,
          ...localSlashCommandItems,
          ...providerSlashCommandItems,
        ];
        if (!query) {
          return slashCommandItems;
        }
        return searchSlashCommandItems(slashCommandItems, query);
      }
      if (composerTrigger.kind === "skill") {
        return searchProviderSkills(allComposerSkills, composerTrigger.query).map((skill) => {
          const description =
            skill.shortDescription ??
            skill.description ??
            (skill.scope ? `${skill.scope} skill` : "Run provider skill");

          if (isLocalAgentSkill(skill)) {
            return {
              id: `local-skill:${skill.path}`,
              type: "local-skill" as const,
              skill,
              label: formatProviderSkillDisplayName(skill),
              description,
            } satisfies Extract<ComposerCommandItem, { type: "local-skill" }>;
          }

          return {
            id: `skill:${selectedProvider}:${skill.name}`,
            type: "skill" as const,
            provider: selectedProvider,
            skill,
            label: formatProviderSkillDisplayName(skill),
            description,
          } satisfies Extract<ComposerCommandItem, { type: "skill" }>;
        });
      }
      return [];
    }, [
      allComposerSkills,
      composerTrigger,
      localAgentInventory.commands,
      selectedProvider,
      selectedProviderStatus,
      workspaceEntries,
    ]);

    const composerMenuOpen = Boolean(composerTrigger);
    const composerMenuSearchKey = composerTrigger
      ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
      : null;
    const activeComposerMenuItem = useMemo(() => {
      const activeItemId = resolveComposerMenuActiveItemId({
        items: composerMenuItems,
        highlightedItemId: composerHighlightedItemId,
        currentSearchKey: composerMenuSearchKey,
        highlightedSearchKey: composerHighlightedSearchKey,
      });
      return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
    }, [
      composerHighlightedItemId,
      composerHighlightedSearchKey,
      composerMenuItems,
      composerMenuSearchKey,
    ]);

    composerMenuOpenRef.current = composerMenuOpen;
    composerMenuItemsRef.current = composerMenuItems;
    activeComposerMenuItemRef.current = activeComposerMenuItem;

    const nonPersistedComposerImageIdSet = useMemo(
      () => new Set(nonPersistedComposerImageIds),
      [nonPersistedComposerImageIds],
    );

    const isComposerApprovalState = activePendingApproval !== null;
    const activePendingUserInput = pendingUserInputs[0] ?? null;
    const hasComposerHeader =
      isComposerApprovalState ||
      pendingUserInputs.length > 0 ||
      (showPlanFollowUpPrompt && activeProposedPlan !== null);

    const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
    const showPlanSidebarToggle = Boolean(activePlan || sidebarProposedPlan || planSidebarOpen);
    const composerFooterActionLayoutKey = useMemo(() => {
      if (activePendingProgress) {
        return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
      }
      if (phase === "running") {
        return "running";
      }
      if (showPlanFollowUpPrompt) {
        return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
      }
      return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
    }, [
      activePendingIsResponding,
      activePendingProgress,
      composerSendState.hasSendableContent,
      isConnecting,
      isPreparingWorktree,
      isSendBusy,
      phase,
      prompt,
      showPlanFollowUpPrompt,
    ]);

    const isComposerMenuLoading =
      (composerTriggerKind === "path" &&
        ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
          workspaceEntriesQuery.isLoading ||
          workspaceEntriesQuery.isFetching)) ||
      ((composerTriggerKind === "skill" || composerTriggerKind === "slash-command") &&
        localAgentInventoryLoading);
    const composerMenuEmptyState = useMemo(() => {
      if (composerTriggerKind === "skill") {
        return "No skills found. Try / to browse provider commands.";
      }
      return composerTriggerKind === "path"
        ? "No matching files or folders."
        : "No matching command.";
    }, [composerTriggerKind]);

    // ------------------------------------------------------------------
    // Provider traits UI
    // ------------------------------------------------------------------
    const setPromptFromTraits = useCallback(
      (nextPrompt: string) => {
        if (nextPrompt === promptRef.current) {
          scheduleComposerFocus();
          return;
        }
        promptRef.current = nextPrompt;
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
        const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
        scheduleComposerFocus();
      },
      [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
    );

    const providerTraitsMenuContent = renderProviderTraitsMenuContent({
      provider: selectedProvider,
      ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
      ...(routeKind === "draft" && draftId ? { draftId } : {}),
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: composerModelOptions?.[selectedProvider],
      prompt,
      onPromptChange: setPromptFromTraits,
    });
    const providerTraitsPicker = renderProviderTraitsPicker({
      provider: selectedProvider,
      ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
      ...(routeKind === "draft" && draftId ? { draftId } : {}),
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: composerModelOptions?.[selectedProvider],
      prompt,
      onPromptChange: setPromptFromTraits,
    });
    const pendingPrimaryAction = useMemo(
      () =>
        activePendingProgress
          ? {
              questionIndex: activePendingProgress.questionIndex,
              isLastQuestion: activePendingProgress.isLastQuestion,
              canAdvance: activePendingProgress.canAdvance,
              isResponding: activePendingIsResponding,
              isComplete: Boolean(activePendingResolvedAnswers),
            }
          : null,
      [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
    );
    const showQueuedTurnsPanel =
      !isComposerApprovalState && pendingUserInputs.length === 0 && turnQueue.items.length > 0;
    const providerModelPickerControl = (
      <ProviderModelPicker
        compact={isComposerFooterCompact}
        provider={selectedProvider}
        model={selectedModelForPickerWithCustomFallback}
        lockedProvider={lockedProvider}
        providers={providerStatuses}
        keybindings={keybindings}
        modelOptionsByProvider={modelOptionsByProvider}
        terminalOpen={terminalOpen}
        open={isComposerModelPickerOpen}
        onOpenChange={(open) => {
          setIsComposerModelPickerOpen(open);
        }}
        onProviderModelChange={onProviderModelSelect}
      />
    );

    // ------------------------------------------------------------------
    // Prompt helpers
    // ------------------------------------------------------------------
    const setPrompt = useCallback(
      (nextPrompt: string) => {
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      },
      [composerDraftTarget, setComposerDraftPrompt],
    );

    const addComposerImage = useCallback(
      (image: ComposerImageAttachment) => {
        addComposerDraftImage(composerDraftTarget, image);
      },
      [composerDraftTarget, addComposerDraftImage],
    );

    const addComposerImagesToDraft = useCallback(
      (images: ComposerImageAttachment[]) => {
        addComposerDraftImages(composerDraftTarget, images);
      },
      [composerDraftTarget, addComposerDraftImages],
    );

    const removeComposerImageFromDraft = useCallback(
      (imageId: string) => {
        removeComposerDraftImage(composerDraftTarget, imageId);
      },
      [composerDraftTarget, removeComposerDraftImage],
    );

    const removeComposerTerminalContextFromDraft = useCallback(
      (contextId: string) => {
        const contextIndex = composerTerminalContexts.findIndex(
          (context) => context.id === contextId,
        );
        if (contextIndex < 0) return;
        const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
        promptRef.current = removal.prompt;
        setPrompt(removal.prompt);
        removeComposerDraftTerminalContext(composerDraftTarget, contextId);
        const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
      },
      [
        composerDraftTarget,
        composerTerminalContexts,
        promptRef,
        removeComposerDraftTerminalContext,
        setPrompt,
      ],
    );

    const removeComposerCodeContextFromDraft = useCallback(
      (contextId: string) => {
        const contextIndex = composerCodeContexts.findIndex((context) => context.id === contextId);
        if (contextIndex < 0) return;
        const removal = removeInlineCodeContextPlaceholder(promptRef.current, contextIndex);
        promptRef.current = removal.prompt;
        setPrompt(removal.prompt);
        removeComposerDraftCodeContext(composerDraftTarget, contextId);
        const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
      },
      [
        composerCodeContexts,
        composerDraftTarget,
        promptRef,
        removeComposerDraftCodeContext,
        setPrompt,
      ],
    );

    // ------------------------------------------------------------------
    // Sync refs back to parent
    // ------------------------------------------------------------------
    useEffect(() => {
      promptRef.current = prompt;
      setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
    }, [prompt, promptRef]);

    useEffect(() => {
      composerImagesRef.current = composerImages;
    }, [composerImages, composerImagesRef]);

    useEffect(() => {
      composerTerminalContextsRef.current = composerTerminalContexts;
    }, [composerTerminalContexts, composerTerminalContextsRef]);

    useEffect(() => {
      composerCodeContextsRef.current = composerCodeContexts;
    }, [composerCodeContexts, composerCodeContextsRef]);

    // ------------------------------------------------------------------
    // Composer menu highlight sync
    // ------------------------------------------------------------------
    useEffect(() => {
      if (!composerMenuOpen) {
        setComposerHighlightedItemId(null);
        setComposerHighlightedSearchKey(null);
        return;
      }
      const nextActiveItemId = resolveComposerMenuActiveItemId({
        items: composerMenuItems,
        highlightedItemId: composerHighlightedItemId,
        currentSearchKey: composerMenuSearchKey,
        highlightedSearchKey: composerHighlightedSearchKey,
      });
      setComposerHighlightedItemId((existing) =>
        existing === nextActiveItemId ? existing : nextActiveItemId,
      );
      setComposerHighlightedSearchKey((existing) =>
        existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
      );
    }, [
      composerHighlightedItemId,
      composerHighlightedSearchKey,
      composerMenuItems,
      composerMenuOpen,
      composerMenuSearchKey,
    ]);

    const lastSyncedPendingInputRef = useRef<{
      requestId: string | null;
      questionId: string | null;
    } | null>(null);

    useEffect(() => {
      const nextCustomAnswer = activePendingProgress?.customAnswer;
      if (typeof nextCustomAnswer !== "string") {
        lastSyncedPendingInputRef.current = null;
        return;
      }

      const nextRequestId = activePendingUserInput?.requestId ?? null;
      const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
      const questionChanged =
        lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
        lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
      const textChangedExternally = promptRef.current !== nextCustomAnswer;

      lastSyncedPendingInputRef.current = {
        requestId: nextRequestId,
        questionId: nextQuestionId,
      };

      if (!questionChanged && !textChangedExternally) {
        return;
      }

      promptRef.current = nextCustomAnswer;
      const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextCustomAnswer,
          expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
        ),
      );
      setComposerHighlightedItemId(null);
    }, [
      activePendingProgress?.customAnswer,
      activePendingProgress?.activeQuestion?.id,
      activePendingUserInput?.requestId,
      promptRef,
    ]);

    // ------------------------------------------------------------------
    // Reset compositor state on thread/draft change
    // ------------------------------------------------------------------
    useEffect(() => {
      setComposerHighlightedItemId(null);
      setComposerCursor(
        collapseExpandedComposerCursor(promptRef.current, promptRef.current.length),
      );
      setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
      dragDepthRef.current = 0;
      setIsDragOverComposer(false);
    }, [draftId, activeThreadId, promptRef]);

    // ------------------------------------------------------------------
    // Footer compact layout observation
    // ------------------------------------------------------------------
    useLayoutEffect(() => {
      const composerForm = composerFormRef.current;
      if (!composerForm) return;
      const measureComposerFormWidth = () => composerForm.clientWidth;
      const measureFooterCompactness = () => {
        const composerFormWidth = measureComposerFormWidth();
        const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
        const primaryActionsCompact =
          footerCompact &&
          shouldUseCompactComposerPrimaryActions(composerFormWidth, {
            hasWideActions: composerFooterHasWideActions,
          });
        return {
          primaryActionsCompact,
          footerCompact,
        };
      };

      composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
      const initialCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
      setIsComposerFooterCompact(initialCompactness.footerCompact);
      if (typeof ResizeObserver === "undefined") return;

      const observer = new ResizeObserver((entries) => {
        const [entry] = entries;
        if (!entry) return;
        const nextCompactness = measureFooterCompactness();
        setIsComposerPrimaryActionsCompact((previous) =>
          previous === nextCompactness.primaryActionsCompact
            ? previous
            : nextCompactness.primaryActionsCompact,
        );
        setIsComposerFooterCompact((previous) =>
          previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
        );
        const nextHeight = entry.contentRect.height;
        const previousHeight = composerFormHeightRef.current;
        composerFormHeightRef.current = nextHeight;
        if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
        if (!shouldAutoScrollRef.current) return;
        scheduleStickToBottom();
      });

      observer.observe(composerForm);
      return () => {
        observer.disconnect();
      };
    }, [
      activeThreadId,
      composerFooterActionLayoutKey,
      composerFooterHasWideActions,
      scheduleStickToBottom,
      shouldAutoScrollRef,
    ]);

    // ------------------------------------------------------------------
    // Image persist effect
    // ------------------------------------------------------------------
    useEffect(() => {
      let cancelled = false;
      void (async () => {
        if (composerImages.length === 0) {
          clearComposerDraftPersistedAttachments(composerDraftTarget);
          return;
        }
        const getPersistedAttachmentsForThread = () =>
          getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
        try {
          const currentPersistedAttachments = getPersistedAttachmentsForThread();
          const existingPersistedById = new Map(
            currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
          );
          const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
          await Promise.all(
            composerImages.map(async (image) => {
              try {
                const dataUrl = await readFileAsDataUrl(image.file);
                stagedAttachmentById.set(image.id, {
                  id: image.id,
                  name: image.name,
                  mimeType: image.mimeType,
                  sizeBytes: image.sizeBytes,
                  dataUrl,
                });
              } catch {
                const existingPersisted = existingPersistedById.get(image.id);
                if (existingPersisted) {
                  stagedAttachmentById.set(image.id, existingPersisted);
                }
              }
            }),
          );
          const serialized = Array.from(stagedAttachmentById.values());
          if (cancelled) return;
          syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
        } catch {
          const currentImageIds = new Set(composerImages.map((image) => image.id));
          const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
          const fallbackPersistedIds = fallbackPersistedAttachments
            .map((attachment) => attachment.id)
            .filter((id) => currentImageIds.has(id));
          const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
          const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
            fallbackPersistedIdSet.has(attachment.id),
          );
          if (cancelled) return;
          syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [
      composerDraftTarget,
      clearComposerDraftPersistedAttachments,
      composerImages,
      getComposerDraft,
      syncComposerDraftPersistedAttachments,
    ]);

    // ------------------------------------------------------------------
    // Callbacks: prompt change
    // ------------------------------------------------------------------
    const onPromptChange = useCallback(
      (
        nextPrompt: string,
        nextCursor: number,
        expandedCursor: number,
        cursorAdjacentToMention: boolean,
        terminalContextIds: string[],
        codeContextIds: string[],
      ) => {
        if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
          setComposerCursor(nextCursor);
          setComposerTrigger(
            cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
          );
          onChangeActivePendingUserInputCustomAnswer(
            activePendingProgress.activeQuestion.id,
            nextPrompt,
            nextCursor,
            expandedCursor,
            cursorAdjacentToMention,
          );
          return;
        }
        promptRef.current = nextPrompt;
        setPrompt(nextPrompt);
        if (!contextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
          setComposerDraftTerminalContexts(
            composerDraftTarget,
            syncContextsByIds(composerTerminalContexts, terminalContextIds),
          );
        }
        if (!contextIdListsEqual(composerCodeContexts, codeContextIds)) {
          setComposerDraftCodeContexts(
            composerDraftTarget,
            syncContextsByIds(composerCodeContexts, codeContextIds),
          );
        }
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
      },
      [
        activePendingProgress?.activeQuestion,
        pendingUserInputs.length,
        onChangeActivePendingUserInputCustomAnswer,
        promptRef,
        setPrompt,
        composerDraftTarget,
        composerCodeContexts,
        composerTerminalContexts,
        setComposerDraftCodeContexts,
        setComposerDraftTerminalContexts,
      ],
    );

    // ------------------------------------------------------------------
    // Callbacks: prompt replacement / menu
    // ------------------------------------------------------------------
    const applyPromptReplacement = useCallback(
      (
        rangeStart: number,
        rangeEnd: number,
        replacement: string,
        options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
      ): boolean => {
        const currentText = promptRef.current;
        const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
        const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
        if (
          options?.expectedText !== undefined &&
          currentText.slice(safeStart, safeEnd) !== options.expectedText
        ) {
          return false;
        }
        const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
        const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
        const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
        promptRef.current = next.text;
        const activePendingQuestion = activePendingProgress?.activeQuestion;
        if (activePendingQuestion && activePendingUserInput) {
          onChangeActivePendingUserInputCustomAnswer(
            activePendingQuestion.id,
            next.text,
            nextCursor,
            nextExpandedCursor,
            false,
          );
        } else {
          setPrompt(next.text);
        }
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
        if (options?.focusEditorAfterReplace !== false) {
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCursor);
          });
        }
        return true;
      },
      [
        activePendingProgress?.activeQuestion,
        activePendingUserInput,
        onChangeActivePendingUserInputCustomAnswer,
        promptRef,
        setPrompt,
      ],
    );

    const readComposerSnapshot = useCallback((): {
      value: string;
      cursor: number;
      expandedCursor: number;
      terminalContextIds: string[];
      codeContextIds: string[];
    } => {
      const editorSnapshot = composerEditorRef.current?.readSnapshot();
      if (editorSnapshot) {
        return editorSnapshot;
      }
      return {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
        codeContextIds: composerCodeContexts.map((context) => context.id),
      };
    }, [composerCodeContexts, composerCursor, composerTerminalContexts, promptRef]);

    const insertTextAtComposerCursor = useCallback(
      (text: string) => {
        const snapshot = readComposerSnapshot();
        const applied = applyPromptReplacement(
          snapshot.expandedCursor,
          snapshot.expandedCursor,
          text,
          { focusEditorAfterReplace: true },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
      },
      [applyPromptReplacement, readComposerSnapshot],
    );

    const resolveActiveComposerTrigger = useCallback((): {
      snapshot: { value: string; cursor: number; expandedCursor: number };
      trigger: ComposerTrigger | null;
    } => {
      const snapshot = readComposerSnapshot();
      return {
        snapshot,
        trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
      };
    }, [readComposerSnapshot]);

    const onSelectComposerItem = useCallback(
      (item: ComposerCommandItem) => {
        if (composerSelectLockRef.current) return;
        composerSelectLockRef.current = true;
        window.requestAnimationFrame(() => {
          composerSelectLockRef.current = false;
        });
        const { snapshot, trigger } = resolveActiveComposerTrigger();
        if (!trigger) return;
        if (item.type === "path") {
          const replacement = `@${item.path} `;
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.type === "slash-command") {
          if (item.command === "model") {
            const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
              expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
              focusEditorAfterReplace: false,
            });
            if (applied) {
              setComposerHighlightedItemId(null);
              setIsComposerModelPickerOpen(true);
            }
            return;
          }
          void handleInteractionModeChange(
            item.command === "plan" ? "plan" : item.command === "ask" ? "ask" : "default",
          );
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          });
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.type === "local-slash-command" || item.type === "provider-slash-command") {
          const replacement = `/${item.command.name} `;
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.type === "skill" || item.type === "local-skill") {
          const replacement = `$${item.skill.name} `;
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
      },
      [applyPromptReplacement, handleInteractionModeChange, resolveActiveComposerTrigger],
    );

    const onComposerMenuItemHighlighted = useCallback(
      (itemId: string | null) => {
        setComposerHighlightedItemId(itemId);
        setComposerHighlightedSearchKey(composerMenuSearchKey);
      },
      [composerMenuSearchKey],
    );

    const nudgeComposerMenuHighlight = useCallback(
      (key: "ArrowDown" | "ArrowUp") => {
        if (composerMenuItems.length === 0) return;
        const highlightedIndex = composerMenuItems.findIndex(
          (item) => item.id === composerHighlightedItemId,
        );
        const normalizedIndex =
          highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
        const offset = key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
        const nextItem = composerMenuItems[nextIndex];
        setComposerHighlightedItemId(nextItem?.id ?? null);
      },
      [composerHighlightedItemId, composerMenuItems],
    );

    // ------------------------------------------------------------------
    // Callbacks: command key
    // ------------------------------------------------------------------
    const onComposerCommandKey = (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
      event: KeyboardEvent,
    ) => {
      if (key === "Tab" && event.shiftKey) {
        toggleInteractionMode();
        return true;
      }
      const { trigger } = resolveActiveComposerTrigger();
      const menuIsActive = composerMenuOpenRef.current || trigger !== null;
      if (menuIsActive) {
        const currentItems = composerMenuItemsRef.current;
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (key === "ArrowDown" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowDown");
          return true;
        }
        if (key === "ArrowUp" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowUp");
          return true;
        }
        if ((key === "Enter" || key === "Tab") && selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
      if (key === "Enter" && !event.shiftKey) {
        void onSend();
        return true;
      }
      return false;
    };

    // ------------------------------------------------------------------
    // Callbacks: images
    // ------------------------------------------------------------------
    const addComposerImages = useCallback(
      (files: File[]) => {
        if (!activeThreadId || files.length === 0) return;
        if (pendingUserInputs.length > 0) {
          toastManager.add({
            type: "error",
            title: "Attach images after answering plan questions.",
          });
          return;
        }
        const nextImages: ComposerImageAttachment[] = [];
        let nextImageCount = composerImagesRef.current.length;
        let error: string | null = null;
        for (const file of files) {
          if (!file.type.startsWith("image/")) {
            error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
            continue;
          }
          if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
            continue;
          }
          if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
            error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
            break;
          }
          const previewUrl = URL.createObjectURL(file);
          nextImages.push({
            type: "image",
            id: randomUUID(),
            name: file.name || "image",
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl,
            file,
          });
          nextImageCount += 1;
        }
        if (nextImages.length === 1 && nextImages[0]) {
          addComposerImage(nextImages[0]);
        } else if (nextImages.length > 1) {
          addComposerImagesToDraft(nextImages);
        }
        setThreadError(activeThreadId, error);
      },
      [
        activeThreadId,
        addComposerImage,
        addComposerImagesToDraft,
        composerImagesRef,
        pendingUserInputs.length,
        setThreadError,
      ],
    );

    const removeComposerImage = (imageId: string) => {
      removeComposerImageFromDraft(imageId);
    };

    const toggleComposerAddActionsMenu = useCallback(() => {
      if (composerAddActionsMenuHandle.isOpen) {
        composerAddActionsMenuHandle.close();
        return;
      }
      composerAddActionsMenuHandle.open(composerAddActionsTriggerId);
    }, [composerAddActionsMenuHandle, composerAddActionsTriggerId]);

    const onComposerImageInputChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        addComposerImages(files);
        event.target.value = "";
        focusComposer();
      },
      [addComposerImages, focusComposer],
    );

    const openComposerImagePicker = useCallback(() => {
      composerImageInputRef.current?.click();
    }, []);

    const insertSkillTriggerAtCursor = useCallback(() => {
      insertTextAtComposerCursor("$");
    }, [insertTextAtComposerCursor]);

    // ------------------------------------------------------------------
    // Callbacks: paste / drag
    // ------------------------------------------------------------------
    const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) return;
      event.preventDefault();
      addComposerImages(imageFiles);
    };

    const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragOverComposer(true);
    };

    const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragOverComposer(true);
    };

    const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragOverComposer(false);
      }
    };

    const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOverComposer(false);
      const files = Array.from(event.dataTransfer.files);
      addComposerImages(files);
      focusComposer();
    };
    const handleInterruptPrimaryAction = useCallback(() => {
      void onInterrupt();
    }, [onInterrupt]);
    const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
      void onImplementPlanInNewThread();
    }, [onImplementPlanInNewThread]);

    // ------------------------------------------------------------------
    // Imperative handle
    // ------------------------------------------------------------------
    useImperativeHandle(
      ref,
      () => ({
        focusAtEnd: () => {
          composerEditorRef.current?.focusAtEnd();
        },
        focusAt: (cursor: number) => {
          composerEditorRef.current?.focusAt(cursor);
        },
        openModelPicker: () => {
          setIsComposerModelPickerOpen(true);
        },
        toggleModelPicker: () => {
          setIsComposerModelPickerOpen((open) => !open);
        },
        isModelPickerOpen: () => isComposerModelPickerOpen,
        readSnapshot: () => {
          return readComposerSnapshot();
        },
        resetCursorState: (options?: {
          cursor?: number;
          prompt?: string;
          detectTrigger?: boolean;
        }) => {
          const promptForState = options?.prompt ?? promptRef.current;
          const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
          setComposerHighlightedItemId(null);
          setComposerCursor(cursor);
          setComposerTrigger(
            options?.detectTrigger
              ? detectComposerTrigger(
                  promptForState,
                  expandCollapsedComposerCursor(promptForState, cursor),
                )
              : null,
          );
        },
        addTerminalContext: (selection: TerminalContextSelection) => {
          if (!activeThread) return;
          const snapshot = composerEditorRef.current?.readSnapshot() ?? {
            value: promptRef.current,
            cursor: composerCursor,
            expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
            terminalContextIds: composerTerminalContexts.map((context) => context.id),
            codeContextIds: composerCodeContexts.map((context) => context.id),
          };
          const insertion = insertInlineTerminalContextPlaceholder(
            snapshot.value,
            snapshot.expandedCursor,
          );
          const nextCollapsedCursor = collapseExpandedComposerCursor(
            insertion.prompt,
            insertion.cursor,
          );
          const inserted = insertComposerDraftTerminalContext(
            composerDraftTarget,
            insertion.prompt,
            {
              id: randomUUID(),
              threadId: activeThread.id,
              createdAt: new Date().toISOString(),
              ...selection,
            },
            insertion.contextIndex,
          );
          if (!inserted) return;
          promptRef.current = insertion.prompt;
          setComposerCursor(nextCollapsedCursor);
          setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCollapsedCursor);
          });
        },
        addCodeContext: (
          selection: CodeContextSelection,
          options?: { focusComposerAfterInsert?: boolean },
        ) => {
          if (!activeThread) return false;
          const snapshot = composerEditorRef.current?.readSnapshot() ?? {
            value: promptRef.current,
            cursor: composerCursor,
            expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
            terminalContextIds: composerTerminalContexts.map((context) => context.id),
            codeContextIds: composerCodeContexts.map((context) => context.id),
          };
          const insertion = insertInlineCodeContextPlaceholder(
            snapshot.value,
            snapshot.expandedCursor,
          );
          const nextCollapsedCursor = collapseExpandedComposerCursor(
            insertion.prompt,
            insertion.cursor,
          );
          const inserted = insertComposerDraftCodeContext(
            composerDraftTarget,
            insertion.prompt,
            {
              id: randomUUID(),
              threadId: activeThread.id,
              createdAt: new Date().toISOString(),
              ...selection,
            },
            insertion.contextIndex,
          );
          if (!inserted) {
            return false;
          }
          promptRef.current = insertion.prompt;
          setComposerCursor(nextCollapsedCursor);
          setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
          if (options?.focusComposerAfterInsert === true) {
            window.requestAnimationFrame(() => {
              composerEditorRef.current?.focusAt(nextCollapsedCursor);
            });
          }
          return true;
        },
        getSendContext: () => ({
          prompt: promptRef.current,
          images: composerImagesRef.current,
          terminalContexts: composerTerminalContextsRef.current,
          codeContexts: composerCodeContextsRef.current,
          selectedPromptEffort,
          selectedModelOptionsForDispatch,
          selectedModelSelection,
          selectedProvider,
          selectedModel,
          selectedProviderModels,
        }),
      }),
      [
        activeThread,
        composerCodeContexts,
        composerDraftTarget,
        composerCursor,
        composerTerminalContexts,
        composerCodeContextsRef,
        insertComposerDraftCodeContext,
        insertComposerDraftTerminalContext,
        promptRef,
        composerImagesRef,
        composerTerminalContextsRef,
        isComposerModelPickerOpen,
        readComposerSnapshot,
        selectedModel,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        selectedPromptEffort,
        selectedProvider,
        selectedProviderModels,
      ],
    );

    // Render
    // ------------------------------------------------------------------
    return (
      <div className="mx-auto flex w-full min-w-0 max-w-208 flex-col gap-2">
        {showQueuedTurnsPanel ? (
          <ComposerQueuedTurnsPanel
            turnQueue={turnQueue}
            onRemoveQueuedTurn={onRemoveQueuedTurn}
            onResumeTurnQueue={onResumeTurnQueue}
          />
        ) : null}

        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="w-full min-w-0"
          data-chat-composer-form="true"
        >
          <div
            className={cn(
              "group rounded-[22px] p-px transition-[background-color,border-color] [transition-duration:var(--motion-duration-ui)] [transition-timing-function:var(--motion-ease-in-out)]",
              composerProviderState.composerFrameClassName,
            )}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            <div
              className={cn(
                "chat-composer-surface rounded-[20px] border backdrop-blur-md transition-[background-color,border-color,box-shadow] [transition-duration:var(--motion-duration-ui)] [transition-timing-function:var(--motion-ease-in-out)]",
                isDragOverComposer && "border-primary/70 !bg-accent/30",
                composerProviderState.composerSurfaceClassName,
              )}
            >
              {activePendingApproval ? (
                <div className="chat-composer-banner rounded-t-[19px] border-b">
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={pendingApprovals.length}
                  />
                </div>
              ) : pendingUserInputs.length > 0 ? (
                <div className="chat-composer-banner rounded-t-[19px] border-b">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    respondingRequestIds={respondingRequestIds}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onSelectActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                  />
                </div>
              ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                <div className="chat-composer-banner rounded-t-[19px] border-b">
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                </div>
              ) : null}

              <div
                className={cn(
                  "relative px-3 pb-2 sm:px-4",
                  hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
                )}
              >
                {composerMenuOpen && !isComposerApprovalState && (
                  <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                    <ComposerCommandMenu
                      items={composerMenuItems}
                      resolvedTheme={resolvedTheme}
                      isLoading={isComposerMenuLoading}
                      triggerKind={composerTriggerKind}
                      groupSlashCommandSections={
                        composerTrigger?.kind === "slash-command" &&
                        composerTrigger.query.trim().length === 0
                      }
                      emptyStateText={composerMenuEmptyState}
                      activeItemId={activeComposerMenuItem?.id ?? null}
                      onHighlightedItemChange={onComposerMenuItemHighlighted}
                      onSelect={onSelectComposerItem}
                    />
                  </div>
                )}

                {!isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  composerImages.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {composerImages.map((image) => (
                        <div
                          key={image.id}
                          className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(composerImages, image.id);
                                if (!preview) return;
                                onExpandImage(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="h-full w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="text-ui-2xs flex h-full w-full items-center justify-center px-1 text-center text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                          {nonPersistedComposerImageIdSet.has(image.id) && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span
                                    role="img"
                                    aria-label="Draft attachment may not persist"
                                    className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                  >
                                    <AskIcon className="size-3" />
                                  </span>
                                }
                              />
                              <TooltipPopup
                                side="top"
                                className="max-w-64 whitespace-normal leading-tight"
                              >
                                Draft attachment could not be saved locally and may be lost on
                                navigation.
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                            onClick={() => removeComposerImage(image.id)}
                            aria-label={`Remove ${image.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                <ComposerPromptEditor
                  ref={composerEditorRef}
                  value={
                    isComposerApprovalState
                      ? ""
                      : activePendingProgress
                        ? activePendingProgress.customAnswer
                        : prompt
                  }
                  cursor={composerCursor}
                  terminalContexts={
                    !isComposerApprovalState && pendingUserInputs.length === 0
                      ? composerTerminalContexts
                      : []
                  }
                  codeContexts={
                    !isComposerApprovalState && pendingUserInputs.length === 0
                      ? composerCodeContexts
                      : []
                  }
                  skills={allComposerSkills}
                  onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                  onRemoveCodeContext={removeComposerCodeContextFromDraft}
                  onChange={onPromptChange}
                  onCommandKeyDown={onComposerCommandKey}
                  onPaste={onComposerPaste}
                  placeholder={
                    isComposerApprovalState
                      ? (activePendingApproval?.detail ??
                        "Resolve this approval request to continue")
                      : activePendingProgress
                        ? "Type your own answer, or leave this blank to use the selected option"
                        : showPlanFollowUpPrompt && activeProposedPlan
                          ? "Add feedback to refine the plan, or leave this blank to implement it"
                          : "Ask anything, @tag files/folders, use $ for skills, or / for commands"
                  }
                  disabled={isConnecting || isComposerApprovalState}
                />
              </div>

              {/* Separator — independent element so you can bevel, gradient, inset shadow, etc. */}
              <div
                aria-hidden
                data-chat-composer-footer-separator
                className="[background-color:color-mix(in_srgb,var(--composer-footer-separator-background-color)_var(--composer-footer-separator-background-opacity),transparent)] [border-top-color:color-mix(in_srgb,var(--composer-footer-separator-border-color)_var(--composer-footer-separator-border-opacity),transparent)] pointer-events-none h-[2px] w-full shrink-0 border-t"
              />

              {/* Bottom toolbar */}
              {activePendingApproval ? (
                <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 pt-2.5 sm:px-3 sm:pb-3 sm:pt-3">
                  <ComposerPendingApprovalActions
                    requestId={activePendingApproval.requestId}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              ) : (
                <div
                  data-chat-composer-footer="true"
                  data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
                  className={cn(
                    "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 pt-2.5 sm:px-3 sm:pb-3 sm:pt-3",
                    isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                  )}
                >
                  <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {isComposerFooterCompact ? (
                      <>
                        {providerModelPickerControl}
                        <CompactComposerControlsMenu
                          activePlan={showPlanSidebarToggle}
                          interactionMode={interactionMode}
                          planSidebarLabel={planSidebarLabel}
                          planSidebarOpen={planSidebarOpen}
                          showInteractionModeToggle={
                            composerProviderControls.showInteractionModeToggle
                          }
                          traitsMenuContent={providerTraitsMenuContent}
                          onInteractionModeChange={handleInteractionModeChange}
                          onTogglePlanSidebar={togglePlanSidebar}
                        />
                      </>
                    ) : (
                      <>
                        <ComposerAddActionsMenu
                          menuHandle={composerAddActionsMenuHandle}
                          triggerId={composerAddActionsTriggerId}
                          interactionMode={interactionMode}
                          showInteractionModeActions={
                            composerProviderControls.showInteractionModeToggle
                          }
                          hasEnabledSkills={hasEnabledComposerSkills}
                          skillsLoading={localAgentInventoryLoading}
                          imageDisabled={pendingUserInputs.length > 0 || activeThreadId === null}
                          onSelectMode={handleInteractionModeChange}
                          onSelectImage={openComposerImagePicker}
                          onSelectSkill={insertSkillTriggerAtCursor}
                        />
                        {composerProviderControls.showInteractionModeToggle ? (
                          <ComposerInteractionModePill
                            interactionMode={interactionMode}
                            onClick={toggleComposerAddActionsMenu}
                          />
                        ) : null}
                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                        {providerModelPickerControl}
                        {providerTraitsPicker ? (
                          <>
                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />
                            {providerTraitsPicker}
                          </>
                        ) : null}
                        {showPlanSidebarToggle ? (
                          <>
                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />
                            <Button
                              variant="ghost"
                              className={cn(
                                "shrink-0 rounded-full whitespace-nowrap px-2 text-violet-600 hover:text-violet-700 dark:text-violet-300/90 dark:hover:text-violet-200 sm:px-3",
                                planSidebarOpen && "bg-violet-500/10 hover:bg-violet-500/15",
                              )}
                              size="sm"
                              type="button"
                              onClick={togglePlanSidebar}
                              title={
                                planSidebarOpen
                                  ? `Hide ${planSidebarLabel.toLowerCase()} sidebar`
                                  : `Show ${planSidebarLabel.toLowerCase()} sidebar`
                              }
                            >
                              <SidebarPlanReadyIcon className="size-3.5 shrink-0 fill-current" />
                              <span className="sr-only sm:not-sr-only">{planSidebarLabel}</span>
                            </Button>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>

                  {/* Right side: send / stop button */}
                  <div
                    data-chat-composer-actions="right"
                    data-chat-composer-primary-actions-compact={
                      isComposerPrimaryActionsCompact ? "true" : "false"
                    }
                    className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                  >
                    <ComposerFooterPrimaryActions
                      compact={isComposerPrimaryActionsCompact}
                      pendingAction={pendingPrimaryAction}
                      isRunning={phase === "running"}
                      turnQueueStatus={turnQueue.status}
                      showPlanFollowUpPrompt={
                        pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                      }
                      promptHasText={prompt.trim().length > 0}
                      isSendBusy={isSendBusy}
                      isConnecting={isConnecting}
                      isPreparingWorktree={isPreparingWorktree}
                      hasSendableContent={composerSendState.hasSendableContent}
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    />
                  </div>
                </div>
              )}
            </div>
            <input
              ref={composerImageInputRef}
              type="file"
              accept="image/*"
              multiple
              tabIndex={-1}
              className="sr-only"
              data-composer-image-upload-input="true"
              onChange={onComposerImageInputChange}
            />
          </div>
        </form>
      </div>
    );
  }),
);

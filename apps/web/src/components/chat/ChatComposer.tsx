import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  ProjectEntry,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
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
import { AVAILABLE_PROVIDER_OPTIONS, ProviderModelPicker } from "./ProviderModelPicker";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderRegistry";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { basenameOfPath } from "../../vscode-icons";
import { cn, randomUUID } from "~/lib/utils";
import { Separator } from "../ui/separator";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  BotIcon,
  CircleAlertIcon,
  ListTodoIcon,
  type LucideIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  XIcon,
} from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import { resolveSelectableProvider, getProviderModels } from "../../providerModels";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;

const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
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

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showPlanToggle: boolean;
  planSidebarOpen: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTogglePlanSidebar: () => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Button
        variant="ghost"
        className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
        size="sm"
        type="button"
        onClick={props.onToggleInteractionMode}
        title={
          props.interactionMode === "plan"
            ? "Plan mode — click to return to normal build mode"
            : "Default mode — click to enter plan mode"
        }
      >
        <BotIcon />
        <span className="sr-only sm:not-sr-only">
          {props.interactionMode === "plan" ? "Plan" : "Build"}
        </span>
      </Button>

      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Select
        value={props.runtimeMode}
        onValueChange={(value) => props.onRuntimeModeChange(value!)}
      >
        <SelectTrigger
          variant="ghost"
          size="sm"
          className="font-medium"
          aria-label="Runtime mode"
          title={runtimeModeOption.description}
        >
          <RuntimeModeIcon className="size-4" />
          <SelectValue>{runtimeModeOption.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {runtimeModeOptions.map((mode) => {
            const option = runtimeModeConfig[mode];
            const OptionIcon = option.icon;
            return (
              <SelectItem key={mode} value={mode} className="min-w-64 py-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {option.label}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {option.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>

      {props.showPlanToggle ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <Button
            variant="ghost"
            className={cn(
              "shrink-0 whitespace-nowrap px-2 sm:px-3",
              props.planSidebarOpen
                ? "text-blue-400 hover:text-blue-300"
                : "text-muted-foreground/70 hover:text-foreground/80",
            )}
            size="sm"
            type="button"
            onClick={props.onTogglePlanSidebar}
            title={props.planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
          >
            <ListTodoIcon />
            <span className="sr-only sm:not-sr-only">Plan</span>
          </Button>
        </>
      ) : null}
    </>
  );
});

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
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
      {props.activeContextWindow ? <ContextWindowMeter usage={props.activeContextWindow} /> : null}
      {props.isPreparingWorktree ? (
        <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
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
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    terminalContexts: TerminalContextDraft[];
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
  planSidebarOpen: boolean;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;

  // Context window
  activeThreadActivities: Thread["activities"] | undefined;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  gitCwd: string | null;

  // Refs the parent needs kept in sync
  promptRef: React.MutableRefObject<string>;
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.MutableRefObject<TerminalContextDraft[]>;

  // Scroll
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  scheduleStickToBottom: () => void;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }) => void;
  onInterrupt: () => void;
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
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
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
      planSidebarOpen,
      runtimeMode,
      interactionMode,
      lockedProvider,
      providerStatuses,
      activeProjectDefaultModelSelection,
      activeThreadModelSelection,
      activeThreadActivities,
      resolvedTheme,
      settings,
      gitCwd,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      shouldAutoScrollRef,
      scheduleStickToBottom,
      onSend,
      onInterrupt,
      onImplementPlanInNewThread,
      onRespondToApproval,
      onSelectActivePendingUserInputOption,
      onAdvanceActivePendingUserInput,
      onPreviousActivePendingUserInputQuestion,
      onChangeActivePendingUserInputCustomAnswer,
      onProviderModelSelect,
      toggleInteractionMode,
      handleRuntimeModeChange,
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
    const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;

    const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
    const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
    const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
    const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
    const insertComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.insertTerminalContext,
    );
    const removeComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.removeTerminalContext,
    );
    const setComposerDraftTerminalContexts = useComposerDraftStore(
      (store) => store.setTerminalContexts,
    );
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

    const composerProviderState = useMemo(
      () =>
        getComposerProviderState({
          provider: selectedProvider,
          model: selectedModel,
          models: selectedProviderModels,
          prompt,
          modelOptions: composerModelOptions,
        }),
      [composerModelOptions, prompt, selectedModel, selectedProvider, selectedProviderModels],
    );

    const selectedPromptEffort = composerProviderState.promptEffort;
    const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
    const selectedModelSelection = useMemo<ModelSelection>(
      () => ({
        provider: selectedProvider,
        model: selectedModel,
        ...(selectedModelOptionsForDispatch ? { options: selectedModelOptionsForDispatch } : {}),
      }),
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
      }),
      [providerStatuses],
    );
    const selectedModelForPickerWithCustomFallback = useMemo(() => {
      const currentOptions = modelOptionsByProvider[selectedProvider];
      return currentOptions.some((option) => option.slug === selectedModelForPicker)
        ? selectedModelForPicker
        : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
    }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
    const searchableModelOptions = useMemo(
      () =>
        AVAILABLE_PROVIDER_OPTIONS.filter(
          (option) => lockedProvider === null || option.value === lockedProvider,
        ).flatMap((option) =>
          modelOptionsByProvider[option.value].map(({ slug, name }) => ({
            provider: option.value,
            providerLabel: option.label,
            slug,
            name,
            searchSlug: slug.toLowerCase(),
            searchName: name.toLowerCase(),
            searchProvider: option.label.toLowerCase(),
          })),
        ),
      [lockedProvider, modelOptionsByProvider],
    );

    // ------------------------------------------------------------------
    // Context window
    // ------------------------------------------------------------------
    const activeContextWindow = useMemo(
      () => deriveLatestContextWindowSnapshot(activeThreadActivities ?? []),
      [activeThreadActivities],
    );

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
    const [isDragOverComposer, setIsDragOverComposer] = useState(false);
    const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
    const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);

    // ------------------------------------------------------------------
    // Refs
    // ------------------------------------------------------------------
    const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
    const composerFormRef = useRef<HTMLFormElement>(null);
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
        }),
      [composerImages.length, composerTerminalContexts, prompt],
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
        const slashCommandItems = [
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
            id: "slash:default",
            type: "slash-command",
            command: "default",
            label: "/default",
            description: "Switch this thread back to normal build mode",
          },
        ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) {
          return [...slashCommandItems];
        }
        return slashCommandItems.filter(
          (item) => item.command.includes(query) || item.label.slice(1).includes(query),
        );
      }
      return searchableModelOptions
        .filter(({ searchSlug, searchName, searchProvider }) => {
          const query = composerTrigger.query.trim().toLowerCase();
          if (!query) return true;
          return (
            searchSlug.includes(query) ||
            searchName.includes(query) ||
            searchProvider.includes(query)
          );
        })
        .map(({ provider, providerLabel, slug, name }) => ({
          id: `model:${provider}:${slug}`,
          type: "model",
          provider,
          model: slug,
          label: name,
          description: `${providerLabel} · ${slug}`,
        }));
    }, [composerTrigger, searchableModelOptions, workspaceEntries]);

    const composerMenuOpen = Boolean(composerTrigger);
    const activeComposerMenuItem = useMemo(
      () =>
        composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
        composerMenuItems[0] ??
        null,
      [composerHighlightedItemId, composerMenuItems],
    );

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
      composerTriggerKind === "path" &&
      ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching);

    // ------------------------------------------------------------------
    // Provider traits UI
    // ------------------------------------------------------------------
    const setPromptFromTraits = useCallback(
      (nextPrompt: string) => {
        const currentPrompt = promptRef.current;
        if (nextPrompt === currentPrompt) {
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

    // ------------------------------------------------------------------
    // Composer menu highlight sync
    // ------------------------------------------------------------------
    useEffect(() => {
      if (!composerMenuOpen) {
        setComposerHighlightedItemId(null);
        return;
      }
      setComposerHighlightedItemId((existing) =>
        existing && composerMenuItems.some((item) => item.id === existing)
          ? existing
          : (composerMenuItems[0]?.id ?? null),
      );
    }, [composerMenuItems, composerMenuOpen]);

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
        if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
          setComposerDraftTerminalContexts(
            composerDraftTarget,
            syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
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
        composerTerminalContexts,
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
        options?: { expectedText?: string },
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
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
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
      };
    }, [composerCursor, composerTerminalContexts, promptRef]);

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
            const replacement = "/model ";
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
          void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          });
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        onProviderModelSelect(item.provider, item.model);
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
      },
      [
        applyPromptReplacement,
        handleInteractionModeChange,
        onProviderModelSelect,
        resolveActiveComposerTrigger,
      ],
    );

    const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
    }, []);

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
    const addComposerImages = (files: File[]) => {
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
    };

    const removeComposerImage = (imageId: string) => {
      removeComposerImageFromDraft(imageId);
    };

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
        getSendContext: () => ({
          prompt: promptRef.current,
          images: composerImagesRef.current,
          terminalContexts: composerTerminalContextsRef.current,
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
        composerDraftTarget,
        composerCursor,
        composerTerminalContexts,
        insertComposerDraftTerminalContext,
        promptRef,
        composerImagesRef,
        composerTerminalContextsRef,
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
      <form
        ref={composerFormRef}
        onSubmit={onSend}
        className="mx-auto w-full min-w-0 max-w-208"
        data-chat-composer-form="true"
      >
        <div
          className={cn(
            "group rounded-[22px] p-px transition-colors duration-200",
            composerProviderState.composerFrameClassName,
          )}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          <div
            className={cn(
              "rounded-[20px] border bg-card transition-colors duration-200 has-focus-visible:border-ring/45",
              isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
              composerProviderState.composerSurfaceClassName,
            )}
          >
            {activePendingApproval ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
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
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
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
                          <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
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
                                  <CircleAlertIcon className="size-3" />
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
                onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                    : activePendingProgress
                      ? "Type your own answer, or leave this blank to use the selected option"
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : phase === "disconnected"
                          ? "Ask for follow-up changes or attach images"
                          : "Ask anything, @tag files/folders, or use / to show available commands"
                }
                disabled={isConnecting || isComposerApprovalState}
              />
            </div>

            {/* Bottom toolbar */}
            {activePendingApproval ? (
              <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
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
                  "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                  isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <ProviderModelPicker
                    compact={isComposerFooterCompact}
                    provider={selectedProvider}
                    model={selectedModelForPickerWithCustomFallback}
                    lockedProvider={lockedProvider}
                    providers={providerStatuses}
                    modelOptionsByProvider={modelOptionsByProvider}
                    {...(composerProviderState.modelPickerIconClassName
                      ? {
                          activeProviderIconClassName:
                            composerProviderState.modelPickerIconClassName,
                        }
                      : {})}
                    onProviderModelChange={onProviderModelSelect}
                  />

                  {isComposerFooterCompact ? (
                    <CompactComposerControlsMenu
                      activePlan={showPlanSidebarToggle}
                      interactionMode={interactionMode}
                      planSidebarOpen={planSidebarOpen}
                      runtimeMode={runtimeMode}
                      traitsMenuContent={providerTraitsMenuContent}
                      onToggleInteractionMode={toggleInteractionMode}
                      onTogglePlanSidebar={togglePlanSidebar}
                      onRuntimeModeChange={handleRuntimeModeChange}
                    />
                  ) : (
                    <>
                      {providerTraitsPicker ? (
                        <>
                          <Separator
                            orientation="vertical"
                            className="mx-0.5 hidden h-4 sm:block"
                          />
                          {providerTraitsPicker}
                        </>
                      ) : null}
                      <ComposerFooterModeControls
                        interactionMode={interactionMode}
                        runtimeMode={runtimeMode}
                        showPlanToggle={showPlanSidebarToggle}
                        planSidebarOpen={planSidebarOpen}
                        onToggleInteractionMode={toggleInteractionMode}
                        onRuntimeModeChange={handleRuntimeModeChange}
                        onTogglePlanSidebar={togglePlanSidebar}
                      />
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
                    activeContextWindow={activeContextWindow}
                    pendingAction={pendingPrimaryAction}
                    isRunning={phase === "running"}
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
        </div>
      </form>
    );
  }),
);

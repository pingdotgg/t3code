import { scopeThreadRef } from "@forma/client-runtime";
import type {
  ApprovalRequestId,
  EnvironmentId,
  ProjectId,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  ServerLocalAgentInventory,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@forma/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@forma/contracts/settings";
import { createModelCapabilities, createModelSelection } from "@forma/shared/model";
import * as React from "react";

import type { CodeContextDraft } from "../../lib/codeContext";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { type ChatComposerHandle, ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { Thread } from "../../types";

type PreviewVariant =
  | "default"
  | "slash-command-menu"
  | "plan-follow-up"
  | "pending-approval"
  | "pending-user-input";

interface ChatComposerPreviewArgs {
  variant?: PreviewVariant;
  resolvedTheme?: "light" | "dark";
}

const PREVIEW_ENVIRONMENT_ID = "preview-env" as const;
const PREVIEW_ENVIRONMENT = PREVIEW_ENVIRONMENT_ID as EnvironmentId;
const PREVIEW_THREAD_ID = "preview-thread" as ThreadId;
const PREVIEW_PROJECT_ID = "preview-project" as ProjectId;
const PREVIEW_ROUTE_THREAD_REF = scopeThreadRef(PREVIEW_ENVIRONMENT, PREVIEW_THREAD_ID);
const PREVIEW_CREATED_AT = "2026-05-04T12:00:00.000Z";
const PREVIEW_UPDATED_AT = "2026-05-04T12:05:00.000Z";
const PREVIEW_PLAN_ID = "preview-plan" as const;
const PREVIEW_TURN_ID = "preview-turn" as TurnId;

const PREVIEW_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const PREVIEW_SETTINGS = DEFAULT_UNIFIED_SETTINGS;
const PREVIEW_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});
const PREVIEW_PROVIDERS: ServerProvider[] = [
  {
    provider: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "preview",
    status: "ready",
    auth: {
      status: "authenticated",
      label: "Connected",
      type: "api-key",
    },
    checkedAt: PREVIEW_UPDATED_AT,
    models: [
      {
        slug: "gpt-5.1",
        name: "GPT-5.1",
        shortName: "GPT-5.1",
        isCustom: false,
        capabilities: PREVIEW_MODEL_CAPABILITIES,
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        shortName: "GPT-5.3",
        isCustom: false,
        capabilities: PREVIEW_MODEL_CAPABILITIES,
      },
    ],
    slashCommands: [
      {
        name: "fix",
        description: "Apply a targeted fix in the active thread",
        input: {
          hint: "Describe the problem to fix",
        },
      },
      {
        name: "explain",
        description: "Explain the current code path",
        input: {
          hint: "What needs explaining?",
        },
      },
    ],
    skills: [
      {
        name: "grill-me",
        path: ".agents/skills/grill-me",
        scope: "project",
        enabled: true,
        displayName: "Grill Me",
        description: "Stress-test a design or implementation plan.",
        shortDescription: "Interrogate the plan",
      },
    ],
    showInteractionModeToggle: true,
  },
  {
    provider: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "preview",
    status: "ready",
    auth: {
      status: "authenticated",
      label: "Connected",
      type: "oauth",
    },
    checkedAt: PREVIEW_UPDATED_AT,
    models: [
      {
        slug: "claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        shortName: "Sonnet 4.5",
        isCustom: false,
        capabilities: PREVIEW_MODEL_CAPABILITIES,
      },
    ],
    slashCommands: [],
    skills: [],
    showInteractionModeToggle: true,
  },
];
const PREVIEW_LOCAL_AGENT_INVENTORY: ServerLocalAgentInventory = {
  skills: [
    {
      name: "write-a-prd",
      path: ".agents/skills/write-a-prd",
      scope: "project",
      source: "local-agents",
      enabled: true,
      displayName: "Write a PRD",
      description: "Create a product requirements document from repo context.",
      shortDescription: "Author a PRD",
    },
  ],
  commands: [
    {
      name: "ship",
      path: ".agents/commands/ship.md",
      scope: "project",
      source: "local-agents",
      description: "Prepare the current branch for shipping.",
      inputHint: "Release notes or scope",
    },
  ],
};
const PREVIEW_TURN_QUEUE: Thread["turnQueue"] = {
  items: [],
  status: "idle",
  pauseReason: null,
};
const PREVIEW_PENDING_APPROVAL: PendingApproval = {
  requestId: "approval-preview" as ApprovalRequestId,
  requestKind: "file-change",
  createdAt: PREVIEW_UPDATED_AT,
  detail: "Approve updates to `apps/web/src/components/chat/ChatComposer.tsx`.",
};
const PREVIEW_PENDING_USER_INPUT_QUESTIONS = [
  {
    id: "delivery",
    header: "Delivery",
    question: "Which delivery style should the implementation use?",
    options: [
      {
        label: "Minimal patch",
        description: "Keep the changes narrowly scoped to the active file.",
      },
      {
        label: "Shared abstraction",
        description: "Extract any reusable logic while implementing the change.",
      },
    ],
    multiSelect: false,
  },
  {
    id: "verification",
    header: "Verification",
    question: "Which verification steps should run after the change?",
    options: [
      {
        label: "Format",
        description: "Run the formatter before handing the work back.",
      },
      {
        label: "Typecheck",
        description: "Run typecheck across the workspace.",
      },
    ],
    multiSelect: true,
  },
] as const satisfies PendingUserInput["questions"];
const PREVIEW_PENDING_USER_INPUT: PendingUserInput = {
  requestId: "user-input-preview" as ApprovalRequestId,
  createdAt: PREVIEW_UPDATED_AT,
  questions: PREVIEW_PENDING_USER_INPUT_QUESTIONS,
};
const PREVIEW_PLAN: Thread["proposedPlans"][number] = {
  id: PREVIEW_PLAN_ID,
  turnId: PREVIEW_TURN_ID,
  planMarkdown: [
    "1. Isolate the composer preview state behind a deterministic adapter.",
    "2. Add scenarios for command browsing, approvals, and follow-up planning.",
    "3. Keep the definition static so Forma can parse it without executing app code.",
  ].join("\n"),
  implementedAt: null,
  implementationThreadId: null,
  createdAt: PREVIEW_CREATED_AT,
  updatedAt: PREVIEW_UPDATED_AT,
} as const;

function getSeedPrompt(variant: PreviewVariant): string {
  switch (variant) {
    case "default":
      return "Summarize how the latest chat composer changes affect keyboard shortcuts.";
    case "slash-command-menu":
      return "/";
    case "plan-follow-up":
      return "";
    case "pending-approval":
      return "";
    case "pending-user-input":
      return "";
  }
}

function buildPreviewThread(
  interactionMode: ProviderInteractionMode,
  activePlanVisible: boolean,
): Thread {
  return {
    id: PREVIEW_THREAD_ID,
    environmentId: PREVIEW_ENVIRONMENT,
    codexThreadId: "codex-preview-thread",
    projectId: PREVIEW_PROJECT_ID,
    title: "Chat Composer Preview",
    modelSelection: createModelSelection("codex", "gpt-5.1"),
    runtimeMode: "full-access",
    interactionMode,
    session: {
      provider: "codex",
      status: "ready",
      createdAt: PREVIEW_CREATED_AT,
      updatedAt: PREVIEW_UPDATED_AT,
      orchestrationStatus: "ready",
    },
    messages: [],
    proposedPlans: activePlanVisible ? [PREVIEW_PLAN] : [],
    error: null,
    createdAt: PREVIEW_CREATED_AT,
    archivedAt: null,
    updatedAt: PREVIEW_UPDATED_AT,
    latestTurn: null,
    branch: "preview/chat-composer",
    worktreePath: "/tmp/forma-preview/chat-composer",
    turnDiffSummaries: [],
    activities: [],
    turnQueue: PREVIEW_TURN_QUEUE,
  };
}

function buildPendingAnswers(
  currentQuestionId: string,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, unknown> | null {
  const question = PREVIEW_PENDING_USER_INPUT.questions.find(
    (entry) => entry.id === currentQuestionId,
  );
  if (!question) {
    return null;
  }
  const draft = draftAnswers[currentQuestionId];
  if (!draft) {
    return null;
  }
  if (draft.customAnswer && draft.customAnswer.trim().length > 0) {
    return {
      [currentQuestionId]: draft.customAnswer,
    };
  }
  if (draft.selectedOptionLabels && draft.selectedOptionLabels.length > 0) {
    return {
      [currentQuestionId]: question.multiSelect
        ? draft.selectedOptionLabels
        : (draft.selectedOptionLabels[0] ?? null),
    };
  }
  return null;
}

export default function ChatComposerPreviewHarness(input: ChatComposerPreviewArgs) {
  const variant = input.variant ?? "default";
  const resolvedTheme = input.resolvedTheme ?? "light";
  const composerRef = React.useRef<ChatComposerHandle>(null);
  const promptRef = React.useRef("");
  const composerImagesRef = React.useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = React.useRef<TerminalContextDraft[]>([]);
  const composerCodeContextsRef = React.useRef<CodeContextDraft[]>([]);
  const shouldAutoScrollRef = React.useRef(true);
  const [interactionMode, setInteractionMode] = React.useState<ProviderInteractionMode>(() =>
    variant === "plan-follow-up" ? "plan" : "default",
  );
  const [modelSelection, setModelSelection] = React.useState(() =>
    createModelSelection("codex", "gpt-5.1"),
  );
  const [planSidebarOpen, setPlanSidebarOpen] = React.useState(variant === "plan-follow-up");
  const [pendingQuestionIndex, setPendingQuestionIndex] = React.useState(0);
  const [pendingDraftAnswers, setPendingDraftAnswers] = React.useState<
    Record<string, PendingUserInputDraftAnswer>
  >({
    delivery: {
      selectedOptionLabels: ["Shared abstraction"],
      customAnswer: "",
    },
  });

  React.useEffect(() => {
    const prompt = getSeedPrompt(variant);
    const store = useComposerDraftStore.getState();
    store.setPrompt(PREVIEW_ROUTE_THREAD_REF, prompt);
    store.setTerminalContexts(PREVIEW_ROUTE_THREAD_REF, []);
    store.setCodeContexts(PREVIEW_ROUTE_THREAD_REF, []);
    promptRef.current = prompt;
    composerRef.current?.resetCursorState({
      cursor: prompt.length,
      prompt,
      detectTrigger: true,
    });
  }, [variant]);

  React.useEffect(() => {
    if (variant !== "pending-user-input") {
      setPendingQuestionIndex(0);
      setPendingDraftAnswers({
        delivery: {
          selectedOptionLabels: ["Shared abstraction"],
          customAnswer: "",
        },
      });
    }
  }, [variant]);

  const activePendingQuestion =
    variant === "pending-user-input"
      ? (PREVIEW_PENDING_USER_INPUT.questions[pendingQuestionIndex] ?? null)
      : null;
  const activePendingDraft = activePendingQuestion
    ? pendingDraftAnswers[activePendingQuestion.id]
    : undefined;
  const activePendingSelectionCount = activePendingDraft?.selectedOptionLabels?.length ?? 0;
  const activePendingCustomAnswer = activePendingDraft?.customAnswer ?? "";
  const activePendingCanAdvance =
    activePendingCustomAnswer.trim().length > 0 || activePendingSelectionCount > 0;

  const activePendingProgress =
    variant === "pending-user-input" && activePendingQuestion
      ? {
          questionIndex: pendingQuestionIndex,
          isLastQuestion: pendingQuestionIndex === PREVIEW_PENDING_USER_INPUT.questions.length - 1,
          canAdvance: activePendingCanAdvance,
          customAnswer: activePendingCustomAnswer,
          activeQuestion: {
            id: activePendingQuestion.id,
          },
        }
      : null;

  const thread = React.useMemo(
    () => buildPreviewThread(interactionMode, variant === "plan-follow-up"),
    [interactionMode, variant],
  );

  const props: ChatComposerProps = {
    composerDraftTarget: PREVIEW_ROUTE_THREAD_REF,
    environmentId: PREVIEW_ENVIRONMENT,
    routeKind: "server",
    routeThreadRef: PREVIEW_ROUTE_THREAD_REF,
    draftId: null,
    activeThreadId: PREVIEW_THREAD_ID,
    activeThreadEnvironmentId: PREVIEW_ENVIRONMENT,
    activeThread: thread,
    turnQueue: PREVIEW_TURN_QUEUE,
    isServerThread: true,
    isLocalDraftThread: false,
    phase: variant === "pending-approval" ? "running" : "ready",
    isConnecting: false,
    isSendBusy: false,
    isPreparingWorktree: false,
    activePendingApproval: variant === "pending-approval" ? PREVIEW_PENDING_APPROVAL : null,
    pendingApprovals: variant === "pending-approval" ? [PREVIEW_PENDING_APPROVAL] : [],
    pendingUserInputs: variant === "pending-user-input" ? [PREVIEW_PENDING_USER_INPUT] : [],
    activePendingProgress,
    activePendingResolvedAnswers:
      variant === "pending-user-input" && activePendingQuestion
        ? buildPendingAnswers(activePendingQuestion.id, pendingDraftAnswers)
        : null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: pendingDraftAnswers,
    activePendingQuestionIndex: pendingQuestionIndex,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: variant === "plan-follow-up",
    activeProposedPlan: variant === "plan-follow-up" ? PREVIEW_PLAN : null,
    activePlan: variant === "plan-follow-up" ? { turnId: PREVIEW_TURN_ID } : null,
    sidebarProposedPlan: variant === "plan-follow-up" ? { turnId: PREVIEW_TURN_ID } : null,
    planSidebarLabel: "Plan",
    planSidebarOpen,
    interactionMode,
    lockedProvider: null,
    providerStatuses: PREVIEW_PROVIDERS,
    activeProjectDefaultModelSelection: modelSelection,
    activeThreadModelSelection: modelSelection,
    localAgentInventory: PREVIEW_LOCAL_AGENT_INVENTORY,
    localAgentInventoryLoading: false,
    resolvedTheme,
    settings: PREVIEW_SETTINGS,
    keybindings: PREVIEW_KEYBINDINGS,
    terminalOpen: false,
    gitCwd: "/Users/stevensarmi/Code/harness/apps/web",
    promptRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerCodeContextsRef,
    shouldAutoScrollRef,
    scheduleStickToBottom: () => undefined,
    onSend: (event) => {
      event?.preventDefault();
    },
    onInterrupt: () => undefined,
    onRemoveQueuedTurn: () => undefined,
    onResumeTurnQueue: () => undefined,
    onImplementPlanInNewThread: () => undefined,
    onRespondToApproval: async () => undefined,
    onSelectActivePendingUserInputOption: (questionId, optionLabel) => {
      setPendingDraftAnswers((existing) => {
        const question = PREVIEW_PENDING_USER_INPUT.questions.find(
          (entry) => entry.id === questionId,
        );
        if (!question) {
          return existing;
        }
        const current = existing[questionId];
        if (question.multiSelect) {
          const selected = current?.selectedOptionLabels ?? [];
          const nextSelected = selected.includes(optionLabel)
            ? selected.filter((label) => label !== optionLabel)
            : [...selected, optionLabel];
          return {
            ...existing,
            [questionId]: {
              customAnswer: "",
              ...(nextSelected.length > 0 ? { selectedOptionLabels: nextSelected } : {}),
            },
          };
        }
        return {
          ...existing,
          [questionId]: {
            customAnswer: "",
            selectedOptionLabels: [optionLabel],
          },
        };
      });
    },
    onAdvanceActivePendingUserInput: () => {
      setPendingQuestionIndex((existing) =>
        Math.min(existing + 1, PREVIEW_PENDING_USER_INPUT.questions.length - 1),
      );
    },
    onPreviousActivePendingUserInputQuestion: () => {
      setPendingQuestionIndex((existing) => Math.max(existing - 1, 0));
    },
    onChangeActivePendingUserInputCustomAnswer: (questionId, value) => {
      setPendingDraftAnswers((existing) => ({
        ...existing,
        [questionId]: {
          customAnswer: value,
        },
      }));
    },
    onProviderModelSelect: (provider, model) => {
      setModelSelection(createModelSelection(provider, model));
    },
    toggleInteractionMode: () => {
      setInteractionMode((existing) => (existing === "default" ? "ask" : "default"));
    },
    handleInteractionModeChange: (mode) => {
      setInteractionMode(mode);
    },
    togglePlanSidebar: () => {
      setPlanSidebarOpen((existing) => !existing);
    },
    focusComposer: () => {
      composerRef.current?.focusAtEnd();
    },
    scheduleComposerFocus: () => {
      composerRef.current?.focusAtEnd();
    },
    setThreadError: () => undefined,
    onExpandImage: () => undefined,
  };

  return React.createElement(
    "div",
    {
      className: "flex min-h-dvh min-w-0 flex-col text-foreground",
    },
    React.createElement(
      "div",
      {
        className: "flex min-h-0 min-w-0 flex-1 flex-col justify-end",
      },
      React.createElement(
        "div",
        {
          className: "px-3 pb-3 pt-1.5 sm:px-5 sm:pb-4 sm:pt-2",
        },
        React.createElement(ChatComposer, {
          ...props,
          ref: composerRef,
        }),
      ),
    ),
  );
}

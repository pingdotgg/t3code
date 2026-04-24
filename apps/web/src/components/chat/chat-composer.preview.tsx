import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { scopeThreadRef } from "@forma/client-runtime";
import {
  type ApprovalRequestId,
  type ModelSelection,
  type ProjectId,
  type ResolvedKeybindingsConfig,
  type RuntimeMode,
  type ServerLocalAgentInventory,
  type ServerProvider,
  type ThreadId,
  EnvironmentId as EnvironmentIdSchema,
} from "@forma/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@forma/contracts/settings";
import { definePreview } from "@forma/preview-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "../../index.css";

import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { SessionPhase, Thread } from "../../types";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { ChatComposer } from "./ChatComposer";

const ENVIRONMENT_ID = EnvironmentIdSchema.make("environment-preview");
const PROJECT_ID = "project-preview" as ProjectId;
const NOW_ISO = "2026-04-23T16:00:00.000Z";
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PENDING_APPROVALS: PendingApproval[] = [];
const EMPTY_PENDING_USER_INPUTS: PendingUserInput[] = [];
const EMPTY_PENDING_DRAFT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_RESPONDING_REQUEST_IDS: ApprovalRequestId[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];

function effort(value: string, isDefault = false) {
  return {
    value,
    label: value,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

const PROVIDER_STATUSES: ServerProvider[] = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW_ISO,
    slashCommands: [
      {
        name: "fix",
        description: "Apply a targeted fix.",
        input: { hint: "What should I fix?" },
      },
    ],
    skills: [
      {
        name: "deep-research",
        path: ".codex/skills/deep-research",
        enabled: true,
        displayName: "Deep Research",
        description: "Long-form repo investigation.",
        shortDescription: "Investigate across files",
      },
    ],
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW_ISO,
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            effort("low"),
            effort("medium", true),
            effort("high"),
            effort("max"),
          ],
          supportsFastMode: true,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
];

const LOCAL_AGENT_INVENTORY: ServerLocalAgentInventory = {
  skills: [
    {
      name: "design-review",
      path: ".agents/skills/design-review",
      scope: "project",
      enabled: true,
      source: "local-agents",
      displayName: "Design Review",
      description: "Critique interaction and UI decisions.",
      shortDescription: "Review the UX",
    },
  ],
  commands: [
    {
      name: "ship-checklist",
      path: ".agents/commands/ship-checklist.md",
      scope: "project",
      source: "local-agents",
      description: "Run the release checklist for this repo.",
      inputHint: "Version or release target",
    },
  ],
};

function makeModelSelection(model = "gpt-5.4"): ModelSelection {
  return {
    provider: "codex",
    model,
    options: {
      reasoningEffort: "medium",
    },
  };
}

function makeThread(threadId: ThreadId, turnQueue: Thread["turnQueue"]): Thread {
  return {
    id: threadId,
    environmentId: ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Composer Preview",
    modelSelection: makeModelSelection(),
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "ready",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      orchestrationStatus: "ready",
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: NOW_ISO,
    archivedAt: null,
    updatedAt: NOW_ISO,
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    turnQueue,
  };
}

function makeQueuedTurn(messageId: string, text: string): Thread["turnQueue"]["items"][number] {
  return {
    messageId: messageId as Thread["turnQueue"]["items"][number]["messageId"],
    text,
    attachmentIds: [],
    modelSelection: makeModelSelection(),
    runtimeMode: "full-access",
    interactionMode: "default",
    titleSeed: "Composer Preview",
    sourceProposedPlan: null,
    queuedAt: NOW_ISO,
  };
}

function ComposerPreviewShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-full min-h-full w-full items-center justify-center p-6">
      <div className="w-full max-w-[1180px]">{children}</div>
    </div>
  );
}

function ComposerPreviewCase(props: {
  readonly caseId: string;
  readonly initialPrompt: string;
  readonly runtimeMode: RuntimeMode;
  readonly turnQueue: Thread["turnQueue"];
  readonly showPlanFollowUpPrompt?: boolean;
}) {
  const threadId = `${props.caseId}-thread` as ThreadId;
  const routeThreadRef = scopeThreadRef(ENVIRONMENT_ID, threadId);
  const queryClient = useMemo(() => new QueryClient(), []);
  const promptRef = useRef(props.initialPrompt);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(EMPTY_TERMINAL_CONTEXTS);
  const shouldAutoScrollRef = useRef(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(props.runtimeMode);
  const [interactionMode, setInteractionMode] = useState<Thread["interactionMode"]>("default");
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const thread = useMemo(() => makeThread(threadId, props.turnQueue), [threadId, props.turnQueue]);

  useEffect(() => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(routeThreadRef, props.initialPrompt);
    store.setRuntimeMode(routeThreadRef, runtimeMode);
    store.setInteractionMode(routeThreadRef, interactionMode);
  }, [interactionMode, props.initialPrompt, routeThreadRef, runtimeMode]);

  return (
    <QueryClientProvider client={queryClient}>
      <ComposerPreviewShell>
        <ChatComposer
          composerDraftTarget={routeThreadRef}
          environmentId={ENVIRONMENT_ID}
          routeKind="server"
          routeThreadRef={routeThreadRef}
          draftId={null}
          activeThreadId={threadId}
          activeThreadEnvironmentId={ENVIRONMENT_ID}
          activeThread={thread}
          turnQueue={props.turnQueue}
          isServerThread
          isLocalDraftThread={false}
          phase={"ready" as SessionPhase}
          isConnecting={false}
          isSendBusy={false}
          isPreparingWorktree={false}
          activePendingApproval={null}
          pendingApprovals={EMPTY_PENDING_APPROVALS}
          pendingUserInputs={EMPTY_PENDING_USER_INPUTS}
          activePendingProgress={null}
          activePendingResolvedAnswers={null}
          activePendingIsResponding={false}
          activePendingDraftAnswers={EMPTY_PENDING_DRAFT_ANSWERS}
          activePendingQuestionIndex={0}
          respondingRequestIds={EMPTY_RESPONDING_REQUEST_IDS}
          showPlanFollowUpPrompt={props.showPlanFollowUpPrompt ?? false}
          activeProposedPlan={{
            id: "plan-preview",
            turnId: null,
            planMarkdown:
              "1. Audit composer behavior\n2. Validate preview integration\n3. Polish interaction states",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }}
          activePlan={null}
          sidebarProposedPlan={null}
          planSidebarLabel="Plan"
          planSidebarOpen={planSidebarOpen}
          runtimeMode={runtimeMode}
          interactionMode={interactionMode}
          runtimeModeLocked={false}
          lockedProvider={null}
          providerStatuses={PROVIDER_STATUSES}
          activeProjectDefaultModelSelection={makeModelSelection()}
          activeThreadModelSelection={makeModelSelection()}
          activeThreadActivities={[]}
          localAgentInventory={LOCAL_AGENT_INVENTORY}
          localAgentInventoryLoading={false}
          resolvedTheme="light"
          settings={DEFAULT_UNIFIED_SETTINGS}
          keybindings={EMPTY_KEYBINDINGS}
          terminalOpen={false}
          gitCwd={null}
          promptRef={promptRef}
          composerImagesRef={composerImagesRef}
          composerTerminalContextsRef={composerTerminalContextsRef}
          shouldAutoScrollRef={shouldAutoScrollRef}
          scheduleStickToBottom={() => undefined}
          onSend={(event) => event?.preventDefault()}
          onInterrupt={() => undefined}
          onRemoveQueuedTurn={() => undefined}
          onResumeTurnQueue={() => undefined}
          onImplementPlanInNewThread={() => undefined}
          onRespondToApproval={async () => undefined}
          onSelectActivePendingUserInputOption={() => undefined}
          onAdvanceActivePendingUserInput={() => undefined}
          onPreviousActivePendingUserInputQuestion={() => undefined}
          onChangeActivePendingUserInputCustomAnswer={() => undefined}
          onProviderModelSelect={() => undefined}
          toggleInteractionMode={() => undefined}
          handleRuntimeModeChange={(mode) => setRuntimeMode(mode)}
          handleInteractionModeChange={(mode) => setInteractionMode(mode)}
          togglePlanSidebar={() => setPlanSidebarOpen((open) => !open)}
          focusComposer={() => undefined}
          scheduleComposerFocus={() => undefined}
          setThreadError={() => undefined}
          onExpandImage={(_preview: ExpandedImagePreview) => undefined}
        />
      </ComposerPreviewShell>
    </QueryClientProvider>
  );
}

export default definePreview({
  label: "Chat Composer",
  cases: {
    default: {
      label: "Default",
      render: () => (
        <ComposerPreviewCase
          caseId="composer-default"
          initialPrompt="Refactor the preview panel so restart behavior is obvious and state transitions are easy to debug."
          runtimeMode="full-access"
          turnQueue={{ items: [], status: "idle", pauseReason: null }}
        />
      ),
      viewport: { preset: "xl" },
    },
    queued: {
      label: "Queued + Plan",
      render: () => (
        <ComposerPreviewCase
          caseId="composer-queued"
          initialPrompt="Ship the desktop preview fix, then write a short validation note."
          runtimeMode="auto-accept-edits"
          showPlanFollowUpPrompt
          turnQueue={{
            items: [
              makeQueuedTurn("queued-turn-1", "Audit the preview manager open/restart flow"),
              makeQueuedTurn("queued-turn-2", "Confirm the desktop dev backend is reading source"),
            ],
            status: "paused",
            pauseReason: "interrupted",
          }}
        />
      ),
      viewport: { preset: "xl" },
    },
  },
});

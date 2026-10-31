import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  NO_PROJECTS_DRAFT_ID,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { hasExplicitComposerModelSelection } from "../../lib/chatThreadActions";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { ComposerSurface } from "./ComposerSurface";
import { NoProjectChip } from "./NoProjectChip";

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_ENTRIES = [] as const;
const NO_PROJECT_REASON = "Add a project first";
const noop = () => {};

/** Sending needs a project or an environment that offers scratch threads. */
export function NoProjectsComposer({
  environmentId,
  onStartWithoutProject,
  startUnavailableReason,
}: {
  readonly environmentId: EnvironmentId;
  readonly onStartWithoutProject: (() => void) | null;
  readonly startUnavailableReason: string | null;
}) {
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { resolvedTheme } = useTheme();
  const serverConfig = useEnvironment(environmentId)?.serverConfig ?? null;
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const providerStatuses =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS;
  const capabilities = serverConfig?.environment.capabilities;
  const maxUploadBytes = capabilities?.fileAttachments?.maxUploadBytes ?? null;
  const { defaultModelSelection, defaultRuntimeMode } = resolveProjectSettings(
    settings,
    null,
  ).settings;

  const draftRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(NO_PROJECTS_DRAFT_ID)?.runtimeMode ?? null,
  );
  const draftInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(NO_PROJECTS_DRAFT_ID)?.interactionMode ?? null,
  );
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setStickyModelSelection = useComposerDraftStore((store) => store.setStickyModelSelection);
  const setRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setInteractionMode = useComposerDraftStore((store) => store.setInteractionMode);
  const runtimeMode = draftRuntimeMode ?? defaultRuntimeMode;
  const interactionMode = settings.planModeEnabled
    ? (draftInteractionMode ?? DEFAULT_INTERACTION_MODE)
    : DEFAULT_INTERACTION_MODE;

  // Like a fresh draft, the composer starts on the last model picked anywhere.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Initialize this mounted composer from the external persisted sticky draft store.
  useEffect(() => {
    const { getComposerDraft, applyStickyState } = useComposerDraftStore.getState();
    if (!hasExplicitComposerModelSelection(getComposerDraft(NO_PROJECTS_DRAFT_ID))) {
      applyStickyState(NO_PROJECTS_DRAFT_ID);
    }
  }, []);

  // The composer keys a few lookups by thread; this one never exists.
  const routeThreadRef = scopeThreadRef(environmentId, ThreadId.make(NO_PROJECTS_DRAFT_ID));
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const [multipleModelSelections, setMultipleModelSelections] =
    useState<ReadonlyArray<ModelSelection> | null>(null);

  const scheduleComposerFocus = () => {
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };
  const onProviderModelSelect = (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => {
    const resolvedModel = resolveAppModelSelectionForInstance(
      instanceId,
      settings,
      providerStatuses,
      model,
    );
    if (resolvedModel) {
      // Restore this model's own remembered options, as a thread's picker does.
      const rememberedOptions =
        useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.[
          resolvedModel
        ];
      const nextModelSelection: ModelSelection =
        rememberedOptions !== undefined && rememberedOptions.length > 0
          ? { instanceId, model: resolvedModel, options: [...rememberedOptions] }
          : { instanceId, model: resolvedModel };
      setModelSelection(NO_PROJECTS_DRAFT_ID, nextModelSelection, {
        explicit: true,
        replaceOptions: true,
      });
      setStickyModelSelection(nextModelSelection);
    }
    if (options?.focusComposer !== false) scheduleComposerFocus();
  };
  const handleRuntimeModeChange = (mode: RuntimeMode) => {
    setRuntimeMode(NO_PROJECTS_DRAFT_ID, mode);
    scheduleComposerFocus();
  };
  const handleInteractionModeChange = (mode: ProviderInteractionMode) => {
    if (mode === "plan" && !settings.planModeEnabled) return;
    setInteractionMode(NO_PROJECTS_DRAFT_ID, mode);
    scheduleComposerFocus();
  };
  const openProviderSetup = (instanceId: ProviderInstanceId) => {
    void navigate({ to: "/settings/providers", search: { environmentId, instanceId } });
  };

  return (
    <ComposerSurface.Shell contextRow={onStartWithoutProject !== null}>
      <ComposerSurface.Host>
        <ChatComposer
          composerRef={composerRef}
          composerDraftTarget={NO_PROJECTS_DRAFT_ID}
          environmentId={environmentId}
          canOperateThread={canOperateThread}
          // A first thread has no history to compact.
          isCompacting={false}
          resumeCompactionTokens={null}
          keepFullHistory={false}
          onToggleKeepFullHistory={() => {}}
          attachmentUploadsCapabilityKnown={serverConfig !== null}
          supportsAttachmentUploads={capabilities?.attachmentUploads === true}
          supportsQuestionAttachments={capabilities?.questionAttachments === true}
          maxFileAttachmentBytes={
            maxUploadBytes === null ? null : clampFileAttachmentUploadBytes(maxUploadBytes)
          }
          routeKind="draft"
          routeThreadRef={routeThreadRef}
          draftId={NO_PROJECTS_DRAFT_ID}
          multipleModelSelections={multipleModelSelections}
          supportsMultipleModels={false}
          onMultipleModelSelectionsChange={setMultipleModelSelections}
          activeThreadId={null}
          activeProjectId={null}
          activeThread={undefined}
          activeThreadShell={null}
          promptHistoryEntries={EMPTY_ENTRIES}
          forceExpandedOnMobile={false}
          projectSelectionRequired={false}
          phase="disconnected"
          canInterrupt={false}
          isSendBusy={false}
          canResume={false}
          sendDisabledReason={
            onStartWithoutProject === null ? (startUnavailableReason ?? NO_PROJECT_REASON) : null
          }
          isPreparingWorktree={false}
          bannerItems={[]}
          environmentUnavailable={null}
          activePendingApproval={null}
          pendingApprovals={[]}
          onHeldRequestIdsChange={noop}
          pendingUserInputs={[]}
          activePendingProgress={null}
          activePendingResolvedAnswers={null}
          activePendingIsResponding={false}
          activePendingDraftAnswers={{}}
          activePendingQuestionIndex={0}
          respondingRequestIds={[]}
          showPlanFollowUpPrompt={false}
          activeProposedPlan={null}
          threadSyncPhase={null}
          workspaceFileDragActive={false}
          runtimeMode={runtimeMode}
          defaultRuntimeMode={defaultRuntimeMode}
          permissionsShownInStrip={false}
          interactionMode={interactionMode}
          lockedProvider={null}
          providerStatuses={providerStatuses as ServerProvider[]}
          providerCatalogKnown={serverConfig !== null}
          activeProjectDefaultModelSelection={defaultModelSelection}
          activeThreadModelSelection={undefined}
          contextWindowEntries={EMPTY_ENTRIES}
          contextWindowLiveUsage={null}
          contextWindowProviderThread={null}
          compactThreadUnavailable
          compactDisabled
          compactDisabledReason={NO_PROJECT_REASON}
          resolvedTheme={resolvedTheme}
          settings={settings}
          keybindings={keybindings}
          terminalOpen={false}
          gitCwd={null}
          pullRequestProjectId={null}
          pullRequestRepository={null}
          threadPullRequests={undefined}
          requestCardHost={null}
          onComposerOverlayHeightChange={noop}
          promptRef={promptRef}
          composerImagesRef={composerImagesRef}
          composerFilesRef={composerFilesRef}
          composerTerminalContextsRef={composerTerminalContextsRef}
          onPageScrollKeyDown={noop}
          onPageScrollKeyUp={noop}
          onPageScrollRelease={noop}
          editingQueuedAttachments={null}
          onRemoveEditingQueuedAttachment={noop}
          onCompactContext={noop}
          onSend={onStartWithoutProject ?? noop}
          onResume={noop}
          onInterrupt={noop}
          onImplementPlanInNewThread={noop}
          onSelectActivePendingUserInputOption={noop}
          onAdvanceActivePendingUserInput={noop}
          onDismissActivePendingUserInput={noop}
          onPreviousActivePendingUserInputQuestion={noop}
          onChangeActivePendingUserInputCustomAnswer={noop}
          onProviderModelSelect={onProviderModelSelect}
          onOpenProviderSetup={openProviderSetup}
          getModelDisabledReason={() => null}
          toggleInteractionMode={() =>
            handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan")
          }
          handleRuntimeModeChange={handleRuntimeModeChange}
          handleInteractionModeChange={handleInteractionModeChange}
          focusComposer={() => composerRef.current?.focusAtEnd()}
          scheduleComposerFocus={scheduleComposerFocus}
          setThreadError={noop}
          onExpandImage={noop}
          onFileOpen={noop}
        />
      </ComposerSurface.Host>
      {onStartWithoutProject === null ? null : (
        <ComposerSurface.ContextStrip data-composer-context-control>
          <NoProjectChip />
        </ComposerSurface.ContextStrip>
      )}
    </ComposerSurface.Shell>
  );
}

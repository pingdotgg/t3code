import type { ChatComposerProps } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";
import { useComposerCommandState } from "./useComposerCommandState";
import { useComposerSubmissionState } from "./useComposerSubmissionState";

import { useComposerStash } from "./useComposerStash";
import {
  ComposerAttachButton,
  ComposerAttachmentFileList,
  ComposerAttachmentMediaRow,
  ComposerFilePreviewDialog,
  ComposerQueuedAttachmentRow,
  ComposerRestingImagePreviews,
} from "./ComposerAttachmentStrip";
import { usePanelAnimationSettings } from "../../panelAnimations";
import { useComposerRestingTransition } from "./useComposerRestingTransition";
import { ComposerControlsBar } from "./ComposerControlsBar";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { BuildingIcon, PlayIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  resolveCompatibleRuntimeMode,
  runtimeModeConfig,
  resolveRuntimeModeOptions,
} from "./runtimeModeConfig";
export function useComposerSurfaceLayout(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  s2: ReturnType<typeof useComposerProviderModelState>,
  s3: ReturnType<typeof useComposerCommandState>,
  s6: ReturnType<typeof useComposerSubmissionState>,
  }) {
  const { s1, s2, s3, s6 } = params;
  const { environmentId, composerDraftTarget, promptRef, composerImagesRef, composerFilesRef, composerTerminalContextsRef, routeThreadRef, projectSelectionRequired, resolvedTheme, onExpandImage, onComposerOverlayHeightChange, routeKind, draftId, reportedModelSelection, settings, toggleInteractionMode, handleRuntimeModeChange, onOpenProviderSetup, isSendBusy, supportsMultipleModels, multipleModelSelections, onMultipleModelSelectionsChange: setMultipleModelSelections, onProviderModelSelect, activeThreadModelSelection, lockedProvider, keybindings, terminalOpen, getModelDisabledReason } = props;
  const { pendingUserInputs, activePendingProgress, prompt, composerPreviewAnnotations, composerReviewComments, composerThreadContexts, attachmentTargetKey, composerDraftTargetKeyRef, standaloneComposerImages, composerImages } = s1;
  const { composerMenuOpen, importContextRecords, restingControlsVisible, restingComposerControlsRef, restingControlsHiddenBlockCount, expandedControlsHiddenBlockCount, restingControlsIconOnlyBlockCount, expandedControlsIconOnlyBlockCount, promptUltrathink, editPromptFromTraitsStable } = s3;
  const { isComposerCollapsedMobile, composerEditorRef, isRevertingCheckpointRef, pendingThreadImportsRef, setComposerCursor, setComposerTrigger, isComposerModelPickerOpen, setIsComposerModelPickerOpen, selectedProvider, selectedInstanceId, selectedModel, selectedProviderModels, composerModelOptions, planModeUiEnabled, interactionMode, compatibleRuntimeMode, compatibleRuntimeModeOptions, showProviderUnavailable, providerSetupInstanceId, providerCatalogPending, selectedModelSelection, selectedModelForPickerWithCustomFallback, lockedContinuationGroupKey, providerInstanceEntries, modelOptionsByInstance, composerProviderState, runtimeModeCeilingDenial, runtimeModeCeilingFallback } = s2;
  const { expandMobileComposer, expandMobileComposerStable } = s6;
    const {
      stashQueue,
      isStashMenuOpen,
      setIsStashMenuOpen,
      stashPulseKey,
      restoreStashEntryStable,
      deleteStashEntryStable,
      toggleStashMenuStable,
    } = useComposerStash({
      environmentId,
      composerDraftTarget,
      promptRef,
      readAttachmentDraft: () => ({
        images: composerImagesRef.current,
        files: composerFilesRef.current,
      }),
      readTerminalContexts: () => composerTerminalContextsRef.current,
      routeThreadRef,
      projectSelectionRequired,
      pendingUserInputs,
      activePendingProgress,
      prompt,
      composerMenuOpen,
      isComposerCollapsedMobile,
      composerPreviewAnnotations,
      composerReviewComments,
      composerThreadContexts,
      attachmentTargetKey,
      isComposerDraftTargetOpen: (key) => composerDraftTargetKeyRef.current === key,
      composerEditorRef,
      isRevertingCheckpoint: () => isRevertingCheckpointRef.current,
      pendingThreadImportsRef,
      setComposerCursor,
      setComposerTrigger,
      importContextRecords,
      expandMobileComposer: expandMobileComposerStable,
    });
    const hasBlockingComposerTopDrawer = pendingUserInputs.length > 0;
    const composerControlsCollapsed = isComposerCollapsedMobile;
    // The collapsed mobile web composer keeps a second controls row inside the card.
    const showInlineRestingControls = isComposerCollapsedMobile;
    const composerControlsHidden = showInlineRestingControls && !restingControlsVisible;
    if (composerControlsHidden && isComposerModelPickerOpen) {
      setIsComposerModelPickerOpen(false);
    }
    const collapsedComposerImagePreviews =
      standaloneComposerImages.length > 0 ? (
        <ComposerRestingImagePreviews
          images={standaloneComposerImages}
          allImages={composerImages}
          resolvedTheme={resolvedTheme}
          onExpandImage={onExpandImage}
          onShowMore={expandMobileComposer}
        />
      ) : null;
    const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
      usePanelAnimationSettings();
    const composerMainSurfaceRef = useComposerRestingTransition(
      composerControlsCollapsed,
      restingComposerControlsRef,
      onComposerOverlayHeightChange,
      panelAnimationsActive,
      panelAnimationDurationMs,
    );
    const restingHiddenBlockCount = showInlineRestingControls
      ? restingControlsHiddenBlockCount
      : composerControlsCollapsed
        ? 0
        : expandedControlsHiddenBlockCount;
    const iconOnlyBlockCount = showInlineRestingControls
      ? restingControlsIconOnlyBlockCount
      : composerControlsCollapsed
        ? 0
        : expandedControlsIconOnlyBlockCount;
    const composerControls = (
      <ComposerControlsBar
        environmentId={environmentId}
        routeKind={routeKind}
        routeThreadRef={routeThreadRef}
        draftId={draftId}
        selectedProvider={selectedProvider}
        selectedInstanceId={selectedInstanceId}
        selectedModel={selectedModel}
        selectedProviderModels={selectedProviderModels}
        composerModelOptions={composerModelOptions}
        reportedModelSelection={reportedModelSelection}
        promptUltrathink={promptUltrathink}
        onPromptEdit={editPromptFromTraitsStable}
        planModeEnabled={settings.planModeEnabled}
        planModeUiEnabled={planModeUiEnabled}
        interactionMode={interactionMode}
        compatibleRuntimeMode={compatibleRuntimeMode}
        defaultRuntimeMode={props.defaultRuntimeMode}
        compatibleRuntimeModeOptions={compatibleRuntimeModeOptions}
        toggleInteractionMode={toggleInteractionMode}
        handleRuntimeModeChange={handleRuntimeModeChange}
        composerControlsCollapsed={composerControlsCollapsed}
        effortDisplay={settings.effortDisplay}
        permissionsShownInStrip={props.permissionsShownInStrip}
        composerControlsHidden={composerControlsHidden}
        restingHiddenBlockCount={restingHiddenBlockCount}
        iconOnlyBlockCount={iconOnlyBlockCount}
        showProviderUnavailable={showProviderUnavailable}
        providerSetupInstanceId={providerSetupInstanceId}
        onOpenProviderSetup={onOpenProviderSetup}
        providerCatalogPending={providerCatalogPending}
        isSendBusy={isSendBusy}
        multipleModelsEnabled={routeKind === "draft" && supportsMultipleModels}
        multipleModelSelections={multipleModelSelections}
        onMultipleModelSelectionsChange={setMultipleModelSelections}
        selectedModelSelection={selectedModelSelection}
        onProviderModelSelect={onProviderModelSelect}
        activeThreadModelSelection={activeThreadModelSelection}
        selectedModelForPickerWithCustomFallback={selectedModelForPickerWithCustomFallback}
        lockedProvider={lockedProvider}
        lockedContinuationGroupKey={lockedContinuationGroupKey}
        providerInstanceEntries={providerInstanceEntries}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        terminalOpen={terminalOpen}
        modelPickerOpen={isComposerModelPickerOpen}
        onModelPickerOpenChange={setIsComposerModelPickerOpen}
        modelPickerIconClassName={composerProviderState.modelPickerIconClassName}
        getModelDisabledReason={getModelDisabledReason}
      />
    );
    // An open question owns the space above the composer. Only a machine problem,
    // which is why an answer could not go through, stays beside it.
    const bannerItems: readonly ComposerBannerStackItem[] =
      runtimeModeCeilingDenial === undefined || activePendingProgress
        ? props.bannerItems
        : [
            ...props.bannerItems,
            {
              id: "managed-runtime-mode",
              variant: "warning",
              icon: <BuildingIcon />,
              title: runtimeModeCeilingDenial,
              ...(runtimeModeCeilingFallback === undefined
                ? {}
                : {
                    actions: (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => handleRuntimeModeChange(runtimeModeCeilingFallback)}
                      >
                        Switch to {runtimeModeConfig[runtimeModeCeilingFallback].label}
                      </Button>
                    ),
                  }),
            },
          ];
    const shelfItems = hasBlockingComposerTopDrawer
      ? bannerItems.filter(
          (item) =>
            item.group === "environment" && (item.variant === "error" || item.variant === "warning"),
        )
      : bannerItems;

  return { stashQueue, isStashMenuOpen, setIsStashMenuOpen, stashPulseKey, restoreStashEntryStable, deleteStashEntryStable, toggleStashMenuStable, composerControlsCollapsed, showInlineRestingControls, composerControlsHidden, collapsedComposerImagePreviews, composerMainSurfaceRef, composerControls, shelfItems };
}

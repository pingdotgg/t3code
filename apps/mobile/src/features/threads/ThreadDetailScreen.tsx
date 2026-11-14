import { ChildThreadApprovals } from "./ChildThreadApprovals";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";
import { ChatGptUsageLimitNotice } from "./ChatGptUsageLimitNotice";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";
import { type BackgroundWorkStopRequest } from "@t3tools/client-runtime/state/thread-execution";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useState } from "react";
import { Keyboard, Platform, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { ThreadBrowserFloat } from "../browser/ThreadBrowserFloat";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { finishThreadMessageJump } from "./threadMessageJump";
import { clearThreadComposerError } from "../../state/thread-composer-error";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { ComposerErrorNotice } from "./ComposerErrorNotice";
import { ManagedRuntimeModeNotice } from "./ManagedRuntimeModeNotice";
import { ComposerFeedback } from "./ComposerFeedback";
import { ComposerUsageLimits } from "./ComposerUsageLimits";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { ProviderSubagentBar } from "./ProviderSubagentBar";
import { ThreadCreationFailedCard } from "./ThreadCreationFailedCard";
import { FLOATING_WORKING_CONTROL_COVERAGE, FloatingWorkingControl } from "./floating-working-control";
import { ThreadComposer } from "./ThreadComposer";
import { ComposerPopoverHost } from "./ComposerPopoverHost";
import { ThreadFeed } from "./ThreadFeed";
import { WorkspaceMutationIdProvider } from "./WorkspaceMutationIdProvider";
import { ComposerQueuedEditBanner } from "./ComposerQueuedEdit";
import { ThreadGuestShareBar } from "./ThreadGuestShareBar";
import { ThreadSideChatsRow } from "./ThreadSideChatsRow";
import type { ThreadDetailBodyProps, ThreadDetailScreenProps } from "./ThreadDetailScreenParts";
import { useThreadDetailState } from "./useThreadDetailState";
import { useThreadDetailActions } from "./useThreadDetailActions";
import { ComposerPanels, USAGE_LIMITS_PANEL_GAP } from "./ThreadDetailScreenShared";
export function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const [statusRequests, setStatusRequests] = useState<
    Record<string, BackgroundWorkStopRequest | undefined>
  >({});
  return (
    <ThreadDetailBody
      key={scopedThreadKey(props.environmentId, props.selectedThread.id)}
      {...props}
      statusRequests={statusRequests}
      setStatusRequests={setStatusRequests}
    />
  );
}

function ThreadDetailBody(props: ThreadDetailBodyProps) {
  const detail = useThreadDetailActions({ ...useThreadDetailState(props), props });
  const {
    activeUserInputRequestId,
    agentsSegment,
    anchorMessageId,
    browserTabs,
    combinedContentInsetEndAdjustment,
    composerBottomInset,
    composerEditorRef,
    composerError,
    composerKeyboardOffset,
    composerOverlayRef,
    composerPanelsHeightStyle,
    composerPopoverHeight,
    composerSlotHidden,
    composerWidthStyle,
    contentInsetEndAdjustment,
    contentMaxWidth,
    controlInsets,
    devicePreviews,
    dismissUsageLimits,
    estimatedOverlayHeight,
    feedRef,
    floatingControlLift,
    floatingStatus,
    freeze,
    handleComposerHeightChange,
    handleComposerOverlayLayout,
    handleEditPendingMessage,
    handleEndFollowEnabledChange,
    handleFeedTouchCancel,
    handleFeedTouchEnd,
    handleFeedTouchMove,
    handleFeedTouchStart,
    handleOwnedInputFocusChange,
    handleScreenLayout,
    handleScrollToEnd,
    handleSendMessage,
    handleToggleUserInputCollapsed,
    handleUsageLimitsLayout,
    handleUseArtifactTemplate,
    hasCompactableConversation,
    isDarkMode,
    isKeyboardVisible,
    isProviderSubagent,
    isSplitLayout,
    jumpMessageId,
    jumpMessageLoaded,
    keyboardStickyEnabled,
    layoutVariant,
    listRef,
    liveKeyboardHeight,
    nativeMetrics,
    navigation,
    navigationHeaderHeight,
    openBrowserPreview,
    openDevicePreview,
    openLinkedThread,
    pendingMessageEditBlocked,
    pendingUserInputMaxHeight,
    providerSubagentCatalogModel,
    providerSubagentProvider,
    questionInFlow,
    questionStatusSpace,
    queuedCount,
    reportedModelSelection,
    screenAreaHeight,
    selectedProviderSkills,
    selectedThreadFeed,
    selectedThreadKey,
    sendingWithKeyboard,
    setScreenMetrics,
    showContent,
    showFloatingStatus,
    showScrollToEndButton,
    showUsageLimits,
    usageLimitsMaxHeight,
    usageLimitsReport,
    userInputCardCoverage,
    userInputCardProgress,
    userInputCollapsed,
    usesNativeWorkspaceColumns,
    voiceInputSession,
  } = detail;

  return (
    <View className="flex-1" onLayout={handleScreenLayout}>
      {!usesNativeWorkspaceColumns ? <NativeLayoutObserver onChange={setScreenMetrics} /> : null}
      {props.draftMode ? (
        props.draftMode.content(
          navigationHeaderHeight,
          liveKeyboardHeight + estimatedOverlayHeight + 24,
          screenAreaHeight -
            navigationHeaderHeight -
            liveKeyboardHeight -
            estimatedOverlayHeight -
            24,
        )
      ) : showContent ? (
        <View
          style={{ flex: 1 }}
          onTouchStart={handleFeedTouchStart}
          onTouchMove={handleFeedTouchMove}
          onTouchEnd={handleFeedTouchEnd}
          onTouchCancel={handleFeedTouchCancel}
        >
          <View
            pointerEvents="none"
            className={
              Platform.OS === "android"
                ? "absolute inset-0 bg-thread-canvas"
                : "absolute inset-0 bg-screen"
            }
          />
          <RenderErrorBoundary
            key={selectedThreadKey}
            resetKeys={[props.threadCwd]}
            renderFallback={(fallback) => (
              <RenderFailureView
                {...fallback}
                title="The conversation couldn't be displayed"
                bottomInset={estimatedOverlayHeight}
              />
            )}
          >
            <WorkspaceMutationIdProvider threadRef={props.selectedThreadDetailRef}>
              <ThreadFeed
                environmentId={props.environmentId}
                threadId={props.selectedThread.id}
                detailRef={props.selectedThreadDetailRef}
                workspaceRoot={props.threadCwd}
                feed={props.selectedThreadFeed}
                pendingHandoff={props.pendingHandoff}
                worktreeSetup={props.worktreeSetup}
                setupWorkingStartedAt={props.setupWorkingStartedAt}
                queuedMessages={props.queuedMessages}
                dispatchingMessageId={props.dispatchingMessageId}
                // A native subagent has no composer to edit a pending message in;
                // Cancel on the edit banner would discard it.
                onEditPendingMessage={
                  isProviderSubagent || pendingMessageEditBlocked ? null : handleEditPendingMessage
                }
                contentPresentation={props.contentPresentation}
                threadTitle={props.selectedThread.title}
                latestRun={props.activityRun}
                activeWorkStartedAt={props.activeWorkStartedAt}
                runlessWorkActive={props.runlessWorkActive ?? false}
                listRef={listRef}
                freeze={freeze}
                anchorMessageId={anchorMessageId}
                jumpToMessageId={jumpMessageLoaded ? jumpMessageId : null}
                onJumpedToMessage={() => finishThreadMessageJump(selectedThreadKey)}
                ref={feedRef}
                contentInsetEndAdjustment={combinedContentInsetEndAdjustment}
                keyboardOffset={composerKeyboardOffset}
                sendingWithKeyboard={sendingWithKeyboard}
                fitShortFeedToViewport={questionInFlow && !isKeyboardVisible}
                contentTopInset={0}
                contentBottomInset={
                  questionInFlow
                    ? 0
                    : estimatedOverlayHeight +
                      (showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0)
                }
                contentMaxWidth={contentMaxWidth}
                historyControls={props.historyControls}
                contentSideInsets={nativeMetrics?.safeArea}
                layoutVariant={layoutVariant}
                usesAutomaticContentInsets={props.usesAutomaticContentInsets}
                onHeaderMaterialVisibilityChange={props.onHeaderMaterialVisibilityChange}
                onEndFollowEnabledChange={handleEndFollowEnabledChange}
                skills={selectedProviderSkills}
                onUseArtifactTemplate={handleUseArtifactTemplate}
              />
            </WorkspaceMutationIdProvider>
          </RenderErrorBoundary>
        </View>
      ) : (
        <View className="flex-1" />
      )}

      {showContent ? (
        <ThreadBrowserFloat
          key={selectedThreadKey}
          environmentId={props.environmentId}
          threadId={props.selectedThread.id}
          tabs={browserTabs.tabs}
          loaded={browserTabs.loaded}
          top={navigationHeaderHeight + 8}
          onOpen={openBrowserPreview}
        />
      ) : null}

      {showContent ? (
        <KeyboardStickyView
          enabled={keyboardStickyEnabled}
          pointerEvents="box-none"
          style={
            questionInFlow
              ? {
                  marginLeft: controlInsets.left,
                  marginRight: controlInsets.right,
                  marginBottom: controlInsets.bottom,
                }
              : { position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }
          }
          offset={{ closed: 0, opened: composerKeyboardOffset }}
        >
          {questionInFlow ? (
            <Animated.View pointerEvents="none" style={questionStatusSpace} />
          ) : null}
          <ComposerPopoverHost
            hidden={composerSlotHidden}
            popoverHeight={composerPopoverHeight}
            inFlow={questionInFlow}
          >
            {/* The fixed sticky host gives this bottom-anchored child a stable
              coordinate space. Its top and height can then animate together
              instead of the auto-sized host jumping to Yoga's destination. */}
            <Animated.View
              pointerEvents="box-none"
              style={
                questionInFlow
                  ? isSplitLayout
                    ? composerWidthStyle
                    : undefined
                  : [
                      {
                        position: "absolute",
                        bottom: controlInsets.bottom,
                        left: controlInsets.left,
                        right: controlInsets.right,
                      },
                      composerWidthStyle,
                    ]
              }
            >
              {/* No paddingTop here: the overlay's measured height becomes the
                list's bottom inset, so any padding above the pill/composer
                pushes the resting content floor up by the same amount. */}
              <View
                ref={composerOverlayRef}
                onLayout={handleComposerOverlayLayout}
                className="w-full"
              >
                <View className="w-full self-center" style={{ maxWidth: contentMaxWidth }}>
                  <FloatingWorkingControl
                    colorScheme={isDarkMode ? "dark" : "light"}
                    status={floatingStatus}
                    lift={floatingControlLift}
                    devicePreview={
                      devicePreviews.length > 0
                        ? { count: devicePreviews.length, onPress: openDevicePreview }
                        : null
                    }
                    browserPreview={
                      browserTabs.tabs.length > 0
                        ? { count: browserTabs.tabs.length, onPress: () => openBrowserPreview() }
                        : null
                    }
                    showScrollToEnd={showScrollToEndButton}
                    onScrollToEnd={handleScrollToEnd}
                    agents={agentsSegment}
                    onOpenAgents={() => {
                      Keyboard.dismiss();
                      navigation.navigate("ThreadAgents", {
                        environmentId: props.environmentId,
                        threadId: props.selectedThread.id,
                      });
                    }}
                    queuedCount={queuedCount}
                    onOpenQueue={() => {
                      Keyboard.dismiss();
                      navigation.navigate("ThreadQueue", {
                        environmentId: props.environmentId,
                        threadId: props.selectedThread.id,
                      });
                    }}
                  />
                  <ComposerPanels
                    className="w-full"
                    style={Platform.OS === "android" ? composerPanelsHeightStyle : undefined}
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                  >
                    {props.queuedRunEdit !== null ? (
                      <Animated.View
                        className="shrink-0"
                        entering={FadeInDown.duration(180)}
                        exiting={FadeOut.duration(120)}
                      >
                        <ComposerQueuedEditBanner
                          saving={props.isSavingQueuedEdit}
                          onCancel={() => {
                            voiceInputSession.cancel(props.composerDraftKey);
                            props.onCancelQueuedRunEdit();
                          }}
                        />
                      </Animated.View>
                    ) : null}
                    <UsageLimitRecoveryCard
                      key={props.selectedThread.latestRun?.runId}
                      thread={props.selectedThread}
                      environmentId={props.environmentId}
                    />
                    <ChatGptUsageLimitNotice
                      key={`chatgpt-limit:${props.selectedThread.latestRun?.runId}`}
                      thread={props.selectedThread}
                    />
                    <ChildThreadApprovals
                      threadRef={props.selectedThreadDetailRef}
                      maxHeight={pendingUserInputMaxHeight}
                    />
                    <ThreadGuestShareBar
                      threadRef={props.selectedThreadDetailRef}
                      canOperateThread={props.canOperateThread}
                    />
                    {props.draftMode ? null : (
                      <ThreadSideChatsRow
                        environmentId={props.environmentId}
                        threadId={props.selectedThread.id}
                      />
                    )}
                    {props.feedbackSubmissions.map((submission) => (
                      <ComposerFeedback
                        key={submission.id}
                        submission={submission}
                        onDismiss={() => props.onDismissFeedback(submission.id)}
                      />
                    ))}
                    {props.canOperateThread ? (
                      <ManagedRuntimeModeNotice
                        threadKey={selectedThreadKey}
                        threadRuntimeMode={props.selectedThread.runtimeMode}
                        supportedRuntimeModes={
                          props.serverConfig?.providers.find(
                            (provider) =>
                              provider.instanceId ===
                              props.selectedThread.modelSelection.instanceId,
                          )?.supportedRuntimeModes
                        }
                        policy={props.serverConfig?.managedPolicy}
                      />
                    ) : null}
                    {composerError !== null ? (
                      <Animated.View
                        className="shrink-0"
                        entering={FadeInDown.duration(180)}
                        exiting={FadeOut.duration(120)}
                      >
                        <ComposerErrorNotice
                          message={composerError}
                          onDismiss={() => clearThreadComposerError(selectedThreadKey)}
                        />
                      </Animated.View>
                    ) : null}
                    {usageLimitsReport && activeUserInputRequestId === null ? (
                      <Animated.View
                        className="shrink-0 px-4"
                        style={{ paddingBottom: USAGE_LIMITS_PANEL_GAP }}
                        onLayout={handleUsageLimitsLayout}
                        entering={FadeInDown.duration(220)}
                        exiting={FadeOut.duration(140)}
                      >
                        <ComposerUsageLimits
                          report={usageLimitsReport}
                          environmentId={props.environmentId}
                          maxHeight={usageLimitsMaxHeight}
                          onClose={dismissUsageLimits}
                        />
                      </Animated.View>
                    ) : null}
                    {props.creationState?.kind === "failed" ? (
                      <Animated.View
                        className="shrink-0 px-4"
                        style={{ paddingBottom: composerBottomInset }}
                        entering={FadeInDown.duration(220)}
                        exiting={FadeOut.duration(140)}
                      >
                        <ThreadCreationFailedCard
                          reason={props.creationState.reason}
                          onEditTask={props.creationState.onEditTask}
                        />
                      </Animated.View>
                    ) : null}
                    {props.activePendingApproval || props.activePendingUserInput ? (
                      <Animated.View
                        className="shrink-0 gap-3 px-4 pb-3"
                        style={
                          activeUserInputRequestId !== null
                            ? { paddingBottom: composerBottomInset }
                            : undefined
                        }
                        entering={FadeInDown.duration(220)}
                        exiting={FadeOut.duration(140)}
                      >
                        {props.activePendingApproval ? (
                          <PendingApprovalCard
                            canOperateThread={props.canOperateThread}
                            approval={props.activePendingApproval}
                            respondingApprovalId={props.respondingApprovalId}
                            onRespond={props.onRespondToApproval}
                          />
                        ) : null}
                        {props.activePendingUserInput ? (
                          <PendingUserInputCard
                            environmentId={props.environmentId}
                            canOperateThread={props.canOperateThread}
                            pendingUserInput={props.activePendingUserInput}
                            maxHeight={pendingUserInputMaxHeight}
                            collapsed={userInputCollapsed}
                            onToggleCollapsed={handleToggleUserInputCollapsed}
                            onStopThread={props.onStopThread}
                            cardProgress={userInputCardProgress}
                            cardCoverage={userInputCardCoverage}
                            onInputFocusChange={handleOwnedInputFocusChange}
                            drafts={props.activePendingUserInputDrafts}
                            answers={props.activePendingUserInputAnswers}
                            respondingUserInputId={props.respondingUserInputId}
                            onSelectOption={props.onSelectUserInputOption}
                            onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                            onSubmit={props.onSubmitUserInput}
                            onDismiss={props.onDismissUserInput}
                          />
                        ) : null}
                      </Animated.View>
                    ) : null}
                  </ComposerPanels>
                </View>

                <View style={composerSlotHidden ? { display: "none" } : undefined}>
                  {isProviderSubagent ? (
                    <View
                      className="self-center px-3 pt-1.5"
                      style={{
                        width: "100%",
                        maxWidth: contentMaxWidth,
                        paddingBottom: composerBottomInset + 6,
                      }}
                    >
                      <ProviderSubagentBar
                        provider={providerSubagentProvider ?? null}
                        modelLabel={
                          providerSubagentCatalogModel?.name ??
                          formatModelSlugName(props.selectedThread.modelSelection.model)
                        }
                        effortLabel={formatModelSelectionEffort(
                          props.selectedThread.modelSelection,
                          providerSubagentProvider?.models,
                          reportedModelSelection,
                        )}
                        status={props.providerSubagentStatus ?? null}
                        inspect={
                          providerSubagentProvider?.driver === "antigravity"
                            ? {
                                environmentId: props.environmentId,
                                threadId: props.selectedThread.id,
                              }
                            : null
                        }
                        onOpenParent={
                          props.selectedThread.lineage.parentThreadId === null
                            ? null
                            : () =>
                                openLinkedThread({
                                  environmentId: String(props.environmentId),
                                  threadId: String(props.selectedThread.lineage.parentThreadId),
                                })
                        }
                      />
                    </View>
                  ) : (
                    <>
                      <ThreadComposer
                        isDraft={Boolean(props.draftMode)}
                        canOperateThread={props.canOperateThread}
                        reportedModelSelection={reportedModelSelection}
                        editorRef={composerEditorRef}
                        placeholder={
                          props.activePendingApproval
                            ? props.activePendingApproval.supportsFeedback
                              ? "Send feedback to decline this request"
                              : "Send a message to decline and redirect the agent"
                            : "Ask anything"
                        }
                        contentMaxWidth={contentMaxWidth}
                        draftControls={props.draftMode?.controls}
                        connectionState={props.connectionStateLabel}
                        environmentLabel={props.environmentLabel}
                        selectedThread={props.selectedThread}
                        hasCompactableConversation={
                          hasCompactableConversation && !props.isCompacting
                        }
                        serverConfig={props.serverConfig}
                        queueCount={props.selectedThreadQueueCount}
                        activeThreadBusy={props.activeThreadBusy}
                        canStopThread={props.canStopThread}
                        environmentId={props.environmentId}
                        projectCwd={props.threadCwd ?? props.projectWorkspaceRoot}
                        // Keep follow-ups in the draft until server creation succeeds, or rejection strands them in the outbox.
                        sendBlockedReason={
                          props.draftMode
                            ? props.draftMode.sendBlockedReason
                            : props.creationState?.kind === "preparing" &&
                                !props.creationState.serverOwned
                              ? "Starting the task…"
                              : null
                        }
                        interactionLocked={props.draftMode?.interactionLocked}
                        draftKey={props.composerDraftKey ?? undefined}
                        followUpBehavior={
                          props.activePendingApprovals.length > 0 &&
                          props.activePendingUserInput === null
                            ? "steer"
                            : props.followUpBehavior
                        }
                        canSteerActiveTurn={props.canSteerActiveTurn}
                        hidden={composerSlotHidden}
                        queuedEdit={
                          props.queuedRunEdit === null
                            ? null
                            : {
                                existingAttachments: props.queuedRunEdit.existingAttachments,
                                saving: props.isSavingQueuedEdit,
                                onRemoveExistingAttachment: props.onRemoveQueuedEditAttachment,
                              }
                        }
                        bottomInset={composerBottomInset}
                        onChangeDraftMessage={props.onChangeDraftMessage}
                        onPickDraftMedia={props.onPickDraftMedia}
                        onPickDraftFiles={props.onPickDraftFiles}
                        onNativePasteImages={props.onNativePasteImages}
                        onNativePasteText={props.onNativePasteText}
                        onRemoveDraftImage={props.onRemoveDraftImage}
                        onStopThread={props.onStopThread}
                        onResumeQueue={props.onResumeQueue}
                        onSendMessage={handleSendMessage}
                        onShowUsageLimits={showUsageLimits}
                        canSwitchProvider={props.canSwitchThreadProvider}
                        onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
                        onHeightChange={handleComposerHeightChange}
                        onEditorFocusChange={handleOwnedInputFocusChange}
                      />
                    </>
                  )}
                </View>
              </View>
            </Animated.View>
          </ComposerPopoverHost>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}

export * from "./ThreadDetailScreenParts";

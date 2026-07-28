import SwiftUI

/// Main chat surface: header, scrollable timeline, composer. Owns nothing
/// but layout/wiring — all state lives on `AppModel`.
public struct ChatScreen: View {
    let model: AppModel
    let scenery: SceneryStore

    @UIState private var isPinnedToBottom = true
    @UIState private var showSelectableTranscript = false

    public init(model: AppModel, scenery: SceneryStore) {
        self.model = model
        self.scenery = scenery
    }

    /// Whether the selected thread has a live run — drives the plan-strip
    /// mount/dismount animation. Computed out of `body`: the inline
    /// `selectedThread.map { ... } ?? false` closure was the expression that
    /// tipped the Swift 6.2 (Xcode 26.x) type checker over its limit in
    /// release builds (`circular reference` / type-check timeout on CI).
    private var selectedThreadIsActive: Bool {
        model.selectedThread?.status.isLiveTurn ?? false
    }

    /// `PlanRailPolicy.showsRail` for `thread` — see that type for the rule.
    /// Written as statements, not one expression — see
    /// `selectedThreadIsActive` on the Swift 6.2 type-checker limit.
    private func showsPlanRail(_ thread: ChatThread, hasPhoto: Bool) -> Bool {
        let steps = model.threadState(thread.id)?.planProgress?.steps
        let hasSteps = !(steps?.isEmpty ?? true)
        return PlanRailPolicy.showsRail(
            isLiveTurn: thread.status.isLiveTurn, hasPhoto: hasPhoto, hasSteps: hasSteps)
    }

    /// The auto-review progress surface for `thread`. A function rather than an inline
    /// closure in the modifier chain, for the same Swift 6.2 type-checker
    /// reason as `selectedThreadIsActive` above.
    private func autoReviewProgress(_ thread: ChatThread) -> some View {
        AutoReviewProgressOverlay(status: thread.status, threadID: thread.id)
            .padding(.trailing, 22)
            .padding(.bottom, 6)
    }

    /// Identity + status of the thread on screen, so switching to an already
    /// idle thread never reports as "the run just finished".
    private var watchedThreadSnapshot: ThreadStatusSnapshot {
        guard let thread = model.selectedThread else { return ThreadStatusSnapshot() }
        return ThreadStatusSnapshot(
            threadID: thread.id,
            status: thread.status,
            cancellationPending: model.isCancellationPending(for: thread))
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let thread = model.selectedThread {
                let threadKey = model.scopedThreadKey(thread.id)
                let reviewing = model.threadState(thread.id)?.isReviewing == true
                if reviewing {
                    DiffReviewView(model: model, threadID: thread.id)
                        .transition(Motion.paneChange)
                } else {
                    Group {
                    ChatHeaderView(
                        thread: thread,
                        model: model,
                        scenery: scenery,
                        threadKey: threadKey,
                        onCopyThread: { copyThread(thread) },
                        onSelectText: { showSelectableTranscript = true })
                    Divider()
                    VStack(spacing: 0) {
                        // A LazyVStack keeps substantial layout/realization state. Give
                        // every thread its own scroll-view identity so a selection never
                        // inherits an empty/stale realized viewport from the prior chat.
                        ChatTimelineScrollView(
                            model: model, threadID: thread.id,
                            isPinnedToBottom: $isPinnedToBottom
                        )
                        .id(thread.id)
                        // Auto-review runs on the server with no transcript
                        // of its own, so the pet is anchored to the corner of
                        // the timeline rather than dropped into it: it must
                        // not scroll away, and it must not push the composer.
                        .overlay(alignment: .bottomTrailing) {
                            autoReviewProgress(thread)
                        }
                        ChatFollowUpBar(model: model)
                        // One shared row above the composer: the plan rail
                        // takes all the free width on the left, the Unsplash
                        // credit keeps the right edge of the same 1040pt
                        // column. (The credit rides in the layout flow rather
                        // than a floating corner overlay, which used to
                        // overlap the composer glass on narrow windows.)
                        // With a credit on the row, the rail mounts for the
                        // whole live turn and holds its height while the plan
                        // hydrates, so the pill never moves. With no credit
                        // the row exists only for the rail, so it waits for
                        // actual steps rather than reserving empty space that
                        // would push the composer down for every run.
                        let photo = scenery.photo(for: threadKey)
                        let showsPlanRail = showsPlanRail(thread, hasPhoto: photo != nil)
                        if showsPlanRail || photo != nil {
                            HStack(alignment: .bottom, spacing: 10) {
                                if showsPlanRail {
                                    PlanProgressStrip(
                                        model: model, reservesSlotWhileEmpty: photo != nil)
                                } else {
                                    Spacer(minLength: 0)
                                }
                                if let photo {
                                    SceneryAttributionTag(photo: photo)
                                }
                            }
                            .frame(maxWidth: 1040)
                            .padding(.horizontal, 20)
                            .padding(.top, 8)
                        }
                        ComposerBar(
                            model: model,
                            accent: AlpineTheme.accent)
                            .frame(maxWidth: 1040)
                            .padding(.horizontal, 20)
                            .padding(.top, 8)
                            .padding(.bottom, 16)
                            .transition(Motion.paneChange)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // Keep the entire conversation on the full-bleed scenery layer.
                    // SceneryChatBackground supplies the adaptive frost/wash for
                    // long-form legibility; individual controls add glass only where
                    // they need a distinct interactive surface.
                    }
                    // Pane swap animates in both directions: entering review
                    // already carries this on DiffReviewView.
                    .transition(Motion.paneChange)
                }
            } else {
                ChatEmptyStateView()
                    .transition(Motion.materialize)
            }
        }
        // Thread selection is frequent and often keyboard-driven, so the new
        // session renders immediately. Only occasional mode changes animate.
        .animation(
            Motion.structure,
            value: model.selectedThreadID.flatMap { model.threadState($0)?.isReviewing } ?? false
        )
        // The header's git controls unfold when repo status first arrives
        // for a thread.
        .animation(Motion.structure, value: model.selectedVcsStatus()?.isRepo ?? false)
        // The plan strip mounts/dismounts on run start/end; ease the flip so
        // the composer glides instead of jumping.
        .animation(Motion.structure, value: selectedThreadIsActive)
        // The strip's content arrives mid-run (the plan lands after the run
        // starts), which `selectedThreadIsActive` doesn't cover — ease that
        // flip too.
        .animation(
            Motion.structure,
            value: model.selectedThreadID.flatMap { model.threadState($0)?.planProgress } != nil
        )
        // The watched thread finishing, failing, or stopping to ask something
        // is exactly the case macOS banners suppress (see
        // AgentNotificationPolicy), so it lands as a tap instead.
        .onChange(of: watchedThreadSnapshot) { old, new in
            guard let event = ThreadStatusHaptics.event(from: old, to: new) else { return }
            Haptics.play(event)
        }
        .background {
            // The thread's scene as a full chat wallpaper; the wash inside
            // keeps timeline text readable (see SceneryChatBackground).
            // Review mode uses an opaque background inside DiffReviewView.
            if let thread = model.selectedThread,
                model.threadState(thread.id)?.isReviewing != true
            {
                let threadKey = model.scopedThreadKey(thread.id)
                SceneryChatBackground(
                    scenery: scenery, photo: scenery.photo(for: threadKey),
                    setId: scenery.resolvedSetId(forThread: threadKey),
                    fallbackSeed: threadKey)
            } else {
                Rectangle().fill(.background)
            }
        }
        .environment(
            \.openSelectText,
            model.selectedThreadID == nil
                ? nil
                : { @MainActor in showSelectableTranscript = true })
        // Hidden button so ⇧⌘A works without a toolbar item (macOS 26 glass
        // toolbar items must not double glassEffect).
        .background {
            Button("Select Text…") { showSelectableTranscript = true }
                .keyboardShortcut("a", modifiers: [.command, .shift])
                .opacity(0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .disabled(model.selectedThreadID == nil)
        }
        .sheet(isPresented: $showSelectableTranscript) {
            selectableTranscriptSheet
        }
        #if DEBUG
            .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
                guard let key = note.object as? String else { return }
                switch key {
                case "select-text":
                    showSelectableTranscript = true
                case "select-text-done":
                    showSelectableTranscript = false
                default:
                    break
                }
            }
        #endif
        .task(id: model.selectedThreadID) {
            isPinnedToBottom = true
            guard let threadID = model.selectedThreadID else { return }
            async let vcs: Void = model.watchVcsStatus()
            await model.loadTimelineIfNeeded(threadID: threadID)
            await vcs
        }
    }


    private var selectedProjectRoot: String? {
        guard let thread = model.selectedThread else { return nil }
        return model.projects.first { $0.id == thread.projectID }?.path
    }

    private var selectedThreadIsSettled: Bool {
        model.selectedThread?.status.isSettled ?? false
    }

    private var selectableTranscriptSheet: SelectableTranscriptSheet {
        let threadID = model.selectedThreadID ?? ""
        let contentKey =
            "\(threadID):\(model.timelineVersion(threadID: threadID)):\(selectedThreadIsSettled)"
        return SelectableTranscriptSheet(
            items: model.selectedTimeline(),
            threadID: threadID,
            model: model,
            projectRoot: selectedProjectRoot,
            threadIsSettled: selectedThreadIsSettled,
            contentKey: contentKey)
    }

    private func copyThread(_ thread: ChatThread) {
        let projectRoot = model.projects.first { $0.id == thread.projectID }?.path
        let transcript = TranscriptTextBuilder.attributedString(
            from: model.timeline(threadID: thread.id),
            projectRoot: projectRoot,
            threadIsSettled: thread.status.isSettled)
        Pasteboard.copy(
            ThreadTranscriptExport.text(
                title: thread.title,
                projectRoot: projectRoot,
                provider: thread.provider.displayName,
                modelID: thread.modelID,
                transcript: transcript.string))
    }
}

private struct ChatEmptyStateView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Select a thread to start chatting")
                .font(SurgeTypography.chatBody)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

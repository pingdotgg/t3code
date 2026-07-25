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
        model.selectedThread.map {
            $0.status == .running || $0.status == .backgroundWork
        } ?? false
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
                        thread: thread, model: model, scenery: scenery, threadKey: threadKey)
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
                        ChatFollowUpBar(model: model)
                        if thread.status == .running || thread.status == .backgroundWork {
                            PlanProgressStrip(model: model)
                                .frame(maxWidth: 1040)
                                .padding(.horizontal, 20)
                                .padding(.top, 8)
                        }
                        // Unsplash credit rides in the layout flow above the
                        // composer, right-aligned to the same 1040pt column.
                        // A floating corner overlay used to overlap the
                        // composer glass on narrower windows.
                        if let photo = scenery.photo(for: threadKey) {
                            HStack {
                                Spacer(minLength: 0)
                                SceneryAttributionTag(photo: photo)
                            }
                            .frame(maxWidth: 1040)
                            .padding(.horizontal, 20)
                            .padding(.top, 6)
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
            projectRoot: selectedProjectRoot,
            threadIsSettled: selectedThreadIsSettled,
            contentKey: contentKey)
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

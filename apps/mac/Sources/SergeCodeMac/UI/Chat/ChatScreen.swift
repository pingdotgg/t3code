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

    public var body: some View {
        VStack(spacing: 0) {
            if let thread = model.selectedThread {
                let threadKey = model.scopedThreadKey(thread.id)
                let reviewing = model.threadState(thread.id)?.isReviewing == true
                if reviewing {
                    DiffReviewView(model: model, threadID: thread.id)
                        .transition(Motion.paneChange)
                } else if let task = model.focusedSubagentTask(threadID: thread.id) {
                    SubagentInnerThreadView(
                        model: model, threadID: thread.id, task: task,
                        parentTitle: thread.title.isEmpty ? "Thread" : thread.title)
                        .transition(Motion.paneChange)
                } else {
                    ChatHeaderView(
                        thread: thread, model: model, scenery: scenery, threadKey: threadKey)
                    Divider()
                    VStack(spacing: 0) {
                        VcsToolbar(model: model, threadID: thread.id).id(thread.id)
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
                    // Active work is fully opaque. Scenery belongs to the shallow task
                    // header; a ghosted image under long-form work reads as visual noise.
                    .background(Color(nsColor: .textBackgroundColor))
                }
            } else {
                ChatEmptyStateView()
                    .transition(.opacity)
            }
        }
        // Thread selection is frequent and often keyboard-driven, so the new
        // session renders immediately. Only occasional mode changes animate.
        .animation(
            Motion.structure,
            value: model.selectedThreadID.flatMap { model.threadState($0)?.isReviewing } ?? false
        )
        // Drilling into a subagent swaps the same real estate as review mode.
        .animation(
            Motion.structure,
            value: model.selectedThreadID.flatMap {
                model.threadState($0)?.focusedSubagentTaskID
            })
        // The VCS strip unfolds when repo status first arrives for a thread.
        .animation(Motion.structure, value: model.selectedVcsStatus()?.isRepo ?? false)
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
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

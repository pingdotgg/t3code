import SwiftUI

/// Main chat surface: header, scrollable timeline, composer. Owns nothing
/// but layout/wiring — all state lives on `AppModel`.
public struct ChatScreen: View {
    let model: AppModel
    let scenery: SceneryStore

    @UIState private var isPinnedToBottom = true

    public init(model: AppModel, scenery: SceneryStore) {
        self.model = model
        self.scenery = scenery
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let thread = model.selectedThread {
                let reviewing = model.threadState(thread.id)?.isReviewing == true
                if reviewing {
                    DiffReviewView(model: model, threadID: thread.id)
                        .transition(Motion.paneSwap)
                } else {
                    ChatHeaderView(thread: thread, model: model, scenery: scenery)
                    Divider()
                    VcsToolbar(model: model)
                    ChatTimelineScrollView(model: model, isPinnedToBottom: $isPinnedToBottom)
                    ChatFollowUpBar(model: model)
                    PlanProgressStrip(model: model)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                    ComposerBar(
                        model: model,
                        accent: AlpineTheme.accent(
                            palette: scenery.palette(
                                for: scenery.photo(for: thread.id),
                                setId: scenery.resolvedSetId(forThread: thread.id))))
                        // Breathing room against the window edges and sidebars —
                        // the floating glass composer shouldn't touch chrome.
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                        .padding(.bottom, 14)
                        .transition(Motion.paneSwap)
                }
            } else {
                ChatEmptyStateView()
                    .transition(.opacity)
            }
        }
        // Cross-fades the empty state ↔ thread swap; the wallpaper handles
        // its own photo cross-fade in SceneryImageView.
        .animation(Motion.settle, value: model.selectedThreadID)
        .animation(
            Motion.settle,
            value: model.selectedThreadID.flatMap { model.threadState($0)?.isReviewing } ?? false
        )
        // The VCS strip unfolds when repo status first arrives for a thread.
        .animation(Motion.settle, value: model.selectedVcsStatus()?.isRepo ?? false)
        .background {
            // The thread's scene as a full chat wallpaper; the wash inside
            // keeps timeline text readable (see SceneryChatBackground).
            // Review mode uses an opaque background inside DiffReviewView.
            if let thread = model.selectedThread,
                model.threadState(thread.id)?.isReviewing != true
            {
                SceneryChatBackground(
                    scenery: scenery, photo: scenery.photo(for: thread.id),
                    setId: scenery.resolvedSetId(forThread: thread.id),
                    fallbackSeed: thread.id)
            } else {
                Rectangle().fill(.background)
            }
        }
        .task(id: model.selectedThreadID) {
            isPinnedToBottom = true
            guard let threadID = model.selectedThreadID else { return }
            async let vcs: Void = model.watchVcsStatus()
            await model.loadTimelineIfNeeded(threadID: threadID)
            await vcs
        }
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

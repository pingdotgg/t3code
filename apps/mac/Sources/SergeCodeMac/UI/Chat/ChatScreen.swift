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
                ChatHeaderView(thread: thread, model: model, scenery: scenery)
                Divider()
                VcsToolbar(model: model)
                ChatTimelineScrollView(model: model, isPinnedToBottom: $isPinnedToBottom)
                ChatFollowUpBar(model: model)
                PlanProgressStrip(model: model)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                ComposerBar(model: model)
                    // Breathing room against the window edges and sidebars —
                    // the floating glass composer shouldn't touch chrome.
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 14)
            } else {
                ChatEmptyStateView()
                    .transition(.opacity)
            }
        }
        // Cross-fades the empty state ↔ thread swap; the wallpaper handles
        // its own photo cross-fade in SceneryImageView.
        .animation(Motion.settle, value: model.selectedThreadID)
        // The VCS strip unfolds when repo status first arrives for a thread.
        .animation(Motion.settle, value: model.selectedVcsStatus()?.isRepo ?? false)
        .background {
            // The thread's scene as a full chat wallpaper; the wash inside
            // keeps timeline text readable (see SceneryChatBackground).
            if let thread = model.selectedThread {
                SceneryChatBackground(
                    scenery: scenery, photo: scenery.photo(for: thread.id),
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

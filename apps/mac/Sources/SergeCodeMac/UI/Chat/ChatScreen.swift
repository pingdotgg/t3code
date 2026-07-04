import SwiftUI

/// Main chat surface: header, scrollable timeline, composer. Owns nothing
/// but layout/wiring — all state lives on `AppModel`.
public struct ChatScreen: View {
    let model: AppModel

    @UIState private var isPinnedToBottom = true

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let thread = model.selectedThread {
                ChatHeaderView(thread: thread, model: model)
                Divider()
                VcsToolbar(model: model)
                ChatTimelineScrollView(model: model, isPinnedToBottom: $isPinnedToBottom)
                ComposerBar(model: model)
            } else {
                ChatEmptyStateView()
            }
        }
        .background(.background)
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

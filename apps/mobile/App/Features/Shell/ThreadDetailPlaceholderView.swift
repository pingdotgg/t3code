import SwiftUI

struct ThreadDetailPlaceholderView: View {
    let state: ThreadDetailViewState
    @Binding var composerText: String
    let actions: ThreadDetailActions

    var body: some View {
        ZStack {
            ChatWallpaperBackground()
            VStack(alignment: .leading, spacing: MobileDesign.spacing) {
                MobileThreadHeaderView(thread: state.thread, detail: state.detail, state: state.connectionState)
                if state.canInterrupt {
                    Button("Interrupt running turn", systemImage: "stop.circle", action: actions.interrupt)
                        .buttonStyle(.bordered)
                        .disabled(state.isInterrupting)
                }
                if let commandErrorMessage = state.commandErrorMessage {
                    Text(commandErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                if let detail = state.detail {
                    MobileConversationTimelineView(
                        detail: detail,
                        respondedRequestIDs: state.respondedRequestIDs,
                        respondingRequestIDs: state.respondingRequestIDs,
                        onApprove: actions.approve,
                        onUserInput: actions.userInput,
                        onShowDiff: actions.showDiff,
                        onRevertCheckpoint: actions.revertCheckpoint
                    )
                } else if state.serverConnectionState == .notConfigured {
                    MobileSetupInstructionsView()
                } else {
                    ContentUnavailableView(
                        "No Cached Transcript",
                        systemImage: "bubble.left.and.text.bubble.right",
                        description: Text("Select a synced chat while connected to load its transcript.")
                    )
                }
                MobileComposerView(
                    text: $composerText,
                    canSend: state.canSend,
                    isSending: state.isSending,
                    onSend: actions.send
                )
            }
            .padding()
        }
        .navigationTitle(state.thread.title)
    }
}

#Preview {
    NavigationStack {
        ThreadDetailPlaceholderView(
            state: ThreadDetailViewState(
                thread: MobilePreviewData.threads[0],
                detail: MobilePreviewData.threadDetail,
                connectionState: .connected,
                serverConnectionState: .connected,
                canSend: true,
                isSending: false,
                canInterrupt: false,
                isInterrupting: false,
                commandErrorMessage: nil,
                respondedRequestIDs: [],
                respondingRequestIDs: []
            ),
            composerText: .constant(""),
            actions: ThreadDetailActions(
                send: {},
                interrupt: {},
                approve: { _, _ in },
                userInput: { _, _ in },
                showDiff: { _ in },
                revertCheckpoint: { _ in }
            )
        )
    }
}

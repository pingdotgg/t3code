import SwiftUI

struct ThreadDetailViewState {
    let thread: MobileThread
    let detail: MobileThreadDetail?
    let connectionState: MobileConnectionState
    let serverConnectionState: MobileConnectionState
    let canSend: Bool
    let isSending: Bool
    let canInterrupt: Bool
    let isInterrupting: Bool
    let commandErrorMessage: String?
    let respondedRequestIDs: Set<String>
    let respondingRequestIDs: Set<String>
}

struct ThreadDetailActions {
    let send: () -> Void
    let interrupt: () -> Void
    let approve: (String, String) -> Void
    let userInput: (String, String) -> Void
    let showDiff: (MobileCheckpointSummary) -> Void
    let revertCheckpoint: (MobileCheckpointSummary) -> Void
}

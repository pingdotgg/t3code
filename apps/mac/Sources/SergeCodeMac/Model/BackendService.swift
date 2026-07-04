import Foundation

// Seam between the UI and the transport. LiveBackend (T3Kit + SidecarKit)
// and MockBackend both implement this; the UI only ever sees BackendService.

public enum BackendEvent: Sendable {
    case connection(ConnectionPhase)
    case threadUpserted(ChatThread)
    case threadRemoved(id: String)
    case timelineAppended(threadID: String, item: TimelineItem)
    case assistantDelta(threadID: String, messageID: String, delta: String)
    case assistantCompleted(threadID: String, messageID: String)
    case approvalRequested(ApprovalRequest)
    case approvalResolved(id: String)
    case diffInvalidated(threadID: String)
    case providersChanged([ProviderInstance])
}

public protocol BackendService: Sendable {
    /// Long-lived event stream; UI consumes exactly once from AppModel.
    var events: AsyncStream<BackendEvent> { get }

    func start() async
    func stop() async

    func projects() async throws -> [Project]
    func threads() async throws -> [ChatThread]
    func timeline(threadID: String) async throws -> [TimelineItem]
    func providers() async throws -> [ProviderInstance]

    func createThread(projectID: String, provider: ProviderKind) async throws -> ChatThread
    func archiveThread(id: String) async throws
    func sendMessage(threadID: String, text: String) async throws
    func cancelTurn(threadID: String) async throws
    func respondToApproval(id: String, approve: Bool) async throws

    func diff(threadID: String) async throws -> [DiffFile]
    func checkpoints(threadID: String) async throws -> [Checkpoint]
    func restoreCheckpoint(id: String) async throws

    func addProject(path: String) async throws -> Project
}

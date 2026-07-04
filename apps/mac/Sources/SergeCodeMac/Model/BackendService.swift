import Foundation

// Seam between the UI and the transport. LiveBackend (T3Kit + SidecarKit)
// and MockBackend both implement this; the UI only ever sees BackendService.

public enum BackendEvent: Sendable {
    case connection(ConnectionPhase)
    case threadUpserted(ChatThread)
    case threadRemoved(id: String)
    case timelineAppended(threadID: String, item: TimelineItem)
    /// Full replacement of a thread's timeline — emitted when the backend has
    /// re-derived the timeline from a fresh snapshot after the caller already
    /// had one cached (e.g. a reconnect re-subscribe). Consumers should
    /// overwrite their cached timeline for `threadID` wholesale rather than
    /// appending.
    case timelineReset(threadID: String, items: [TimelineItem])
    case assistantDelta(threadID: String, messageID: String, delta: String)
    /// `markdown` is the server's authoritative final text for the message —
    /// callers should replace their accumulated/delta-built text with it
    /// rather than trusting the locally-accumulated deltas, since a delta can
    /// be lossy (see `LiveBackend.assistantDelta(new:old:)`).
    case assistantCompleted(threadID: String, messageID: String, markdown: String)
    case approvalRequested(ApprovalRequest)
    case approvalResolved(id: String)
    case userInputRequested(UserInputRequest)
    case userInputResolved(id: String)
    case diffInvalidated(threadID: String)
    case providersChanged([ProviderInstance])
    case contextWindowUpdated(threadID: String, status: ContextWindowStatus)
    case planProgressUpdated(threadID: String, progress: PlanProgress)
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

    /// Every selectable (instance, model) pair across configured providers.
    func models() async throws -> [ModelOption]

    func createThread(projectID: String, provider: ProviderKind) async throws -> ChatThread
    func archiveThread(id: String) async throws
    func sendMessage(threadID: String, text: String) async throws
    func cancelTurn(threadID: String) async throws
    func respondToApproval(id: String, approve: Bool) async throws
    /// Answer a pending user-input request. `answers` maps each question id
    /// to the selected option labels (single-element unless multi-select) or
    /// one free-form string.
    func respondToUserInput(id: String, answers: [String: [String]]) async throws

    func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws
    func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws
    /// Repoint the thread at a different provider instance/model.
    func setModel(threadID: String, model: ModelOption) async throws
    /// Start an implementation turn from a proposed plan (plan-mode follow-up).
    func implementPlan(threadID: String, planID: String) async throws

    func diff(threadID: String) async throws -> [DiffFile]
    func checkpoints(threadID: String) async throws -> [Checkpoint]
    func restoreCheckpoint(id: String) async throws

    func addProject(path: String) async throws -> Project
}

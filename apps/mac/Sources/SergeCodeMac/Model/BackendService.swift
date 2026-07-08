import Foundation

// Seam between the UI and the transport. LiveBackend (T3Kit + SidecarKit)
// and MockBackend both implement this; the UI only ever sees BackendService.

public enum BackendEvent: Sendable {
    case connection(ConnectionPhase)
    /// Full replacement of the project list — emitted whenever the backend's
    /// project set changes (snapshot, upsert, removal), so consumers never
    /// depend on polling `projects()` at the right moment.
    case projectsChanged([Project])
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
    /// Keyed by thread: a worktree thread's repo status is its worktree's,
    /// not the project checkout's.
    case vcsStatusChanged(threadID: String, status: VcsStatus)
}

public protocol BackendService: Sendable {
    /// Long-lived event stream; UI consumes exactly once from AppModel.
    var events: AsyncStream<BackendEvent> { get }

    func start() async
    func stop() async

    func projects() async throws -> [Project]
    func threads() async throws -> [ChatThread]
    func timeline(threadID: String) async throws -> [TimelineItem]
    /// Drop a thread's live timeline subscription and per-thread caches.
    /// Re-opening later goes through `timeline(threadID:)` which re-subscribes
    /// and returns a fresh authoritative snapshot. Sidebar status continues
    /// via the shell subscription and is unaffected.
    func closeTimeline(threadID: String) async
    func providers() async throws -> [ProviderInstance]

    /// Every selectable (instance, model) pair across configured providers.
    func models() async throws -> [ModelOption]

    // Workspace and VCS calls are keyed by thread, not project: a thread that
    // runs in its own worktree browses/searches/commits that worktree, while
    // local-mode threads resolve to the project checkout.

    /// Fuzzy filename search in the thread's workspace (composer @-mentions).
    func searchWorkspace(threadID: String, query: String) async throws -> [WorkspaceEntry]
    /// Entries under a directory of the thread's workspace ("" = root).
    func listWorkspace(threadID: String, subpath: String) async throws -> [WorkspaceEntry]
    /// Read one workspace file (server truncates very large files).
    func readWorkspaceFile(threadID: String, path: String) async throws -> FilePreview
    /// Open the thread's workspace (or a path inside it) in an external editor.
    func openInEditor(threadID: String, subpath: String?, editor: ExternalEditor) async throws

    /// `title` nil means the backend picks its generic default.
    func createThread(projectID: String, provider: ProviderKind, title: String?) async throws
        -> ChatThread
    func archiveThread(id: String) async throws
    func unarchiveThread(id: String) async throws
    func deleteThread(id: String) async throws
    func sendMessage(threadID: String, text: String, attachments: [OutgoingAttachment]) async throws
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
    /// Set the thread's reasoning-effort option (a choice id from the
    /// model's `effortChoices`). Throws when the model has no effort option.
    func setReasoningEffort(threadID: String, value: String) async throws
    /// Start an implementation turn from a proposed plan (plan-mode follow-up).
    func implementPlan(threadID: String, planID: String) async throws

    func diff(threadID: String) async throws -> [DiffFile]
    func checkpoints(threadID: String) async throws -> [Checkpoint]
    func restoreCheckpoint(id: String) async throws

    func addProject(path: String) async throws -> Project
    /// Renames a project (its display title; the workspace path is unchanged).
    func renameProject(id: String, name: String) async throws
    /// Deletes a project and all of its sessions (force-cascades server-side).
    func deleteProject(id: String) async throws

    /// Start (or keep) a live VCS status subscription for a thread's
    /// workspace; status arrives via `.vcsStatusChanged` events.
    func watchVcsStatus(threadID: String) async throws
    func listBranches(threadID: String, query: String?) async throws -> [BranchRef]
    func switchBranch(threadID: String, name: String) async throws
    func createBranch(threadID: String, name: String) async throws
    func pull(threadID: String) async throws
    /// Runs a stacked commit/push/PR pipeline to completion.
    func runGitAction(
        threadID: String, action: GitAction, commitMessage: String?
    ) async throws -> GitActionOutcome

    /// Server-side settings (the editable subset).
    func settings() async throws -> AppSettings
    /// Applies the full editable subset as a patch; returns the merged result.
    func updateSettings(_ settings: AppSettings) async throws -> AppSettings
    /// Ask the server to re-probe installed provider CLIs.
    func refreshProviders() async throws
    /// Run a provider CLI's own update command.
    func updateProvider(instanceID: String) async throws
}

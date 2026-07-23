import Foundation
import T3Kit

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
    /// Projected `provider.task.stop.failed` activity keyed for the task row.
    case subagentStopFailed(taskId: String, message: String)
}

public protocol BackendService: Sendable {
    /// Returns the event stream for one AppModel lifecycle. A fresh stream is
    /// created for every start so stopping a consumer cannot poison a later
    /// restart.
    func events() async -> AsyncStream<BackendEvent>

    func start() async
    func stop() async

    func projects() async throws -> [Project]
    func threads() async throws -> [ChatThread]
    /// Returns archived threads without relying on the active shell snapshot.
    /// Backends that do not have a separate query can use the default filter.
    func archivedThreads() async throws -> [ChatThread]
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
    func settleThread(id: String) async throws
    func unsettleThread(id: String) async throws
    func deleteThread(id: String) async throws
    func sendMessage(threadID: String, text: String, attachments: [OutgoingAttachment]) async throws
    /// Short-lived HTTP URL for a persisted chat attachment image
    /// (`assets.createUrl` with `{ _tag: "attachment", attachmentId }`).
    func attachmentImageURL(id: String) async throws -> URL
    func cancelTurn(threadID: String) async throws
    /// Stop a single Claude subagent/background task (thread.task.stop).
    func stopTask(threadID: String, taskId: String) async throws
    func respondToApproval(id: String, approve: Bool) async throws
    /// Answer a pending user-input request. `answers` maps each question id
    /// to the selected option labels (single-element unless multi-select) or
    /// one free-form string.
    func respondToUserInput(id: String, answers: [String: [String]]) async throws

    func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws
    func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws
    /// Sets or clears the Advisor/Planner executor model. Pass nil/nil to clear.
    func setExecutorModel(threadID: String, instanceID: String?, modelID: String?) async throws
    /// Repoint the thread at a different provider instance/model.
    func setModel(threadID: String, model: ModelOption) async throws
    /// Set the thread's reasoning-effort option (a choice id from the
    /// model's `effortChoices`). Throws when the model has no effort option.
    func setReasoningEffort(threadID: String, value: String) async throws
    /// Set the thread's service-tier option (a choice id from the model's
    /// `serviceTierChoices`). Throws when the model has no service-tier option.
    func setServiceTier(threadID: String, value: String) async throws
    /// Start an implementation turn from a proposed plan (plan-mode follow-up).
    func implementPlan(threadID: String, planID: String) async throws

    /// Full-thread diff up to the latest completed turn.
    func diff(threadID: String) async throws -> [DiffFile]
    /// Turn-range diff (`fromTurn` exclusive lower bound, `toTurn` inclusive).
    func diff(threadID: String, fromTurn: Int, toTurn: Int) async throws -> [DiffFile]
    func checkpoints(threadID: String) async throws -> [Checkpoint]
    /// Rewind the thread (workspace + history) to `turnCount` completed
    /// turns (0 = empty thread). The server emits `thread.reverted`;
    /// backends must surface a truncated timeline (via `timelineReset`)
    /// and only return once the rewind has been applied, so callers such
    /// as edit-resend can sequence a follow-up send after it.
    func restoreCheckpoint(threadID: String, turnCount: Int) async throws

    func addProject(path: String) async throws -> Project
    /// Renames a project (its display title; the workspace path is unchanged).
    func renameProject(id: String, name: String) async throws
    /// Deletes a project and all of its sessions (force-cascades server-side).
    func deleteProject(id: String) async throws

    /// Start (or keep) a live VCS status subscription for a thread's
    /// workspace; status arrives via `.vcsStatusChanged` events.
    func watchVcsStatus(threadID: String) async throws
    func pullRequestReview(threadID: String, reference: String) async throws
        -> PullRequestReviewSnapshot
    func listBranches(threadID: String, query: String?) async throws -> [BranchRef]
    func switchBranch(threadID: String, name: String) async throws
    func createBranch(threadID: String, name: String) async throws
    func pull(threadID: String) async throws
    /// Runs a stacked commit/push/PR pipeline to completion.
    func runGitAction(
        threadID: String, action: GitAction, commitMessage: String?
    ) async throws -> GitActionOutcome

    // Mobile (iPhone) pairing — Settings ▸ iPhone.

    /// Whether the running sidecar is bound beyond loopback, i.e. reachable
    /// by the mobile app on the local network. False when the user enabled
    /// mobile access after this launch (the bind host is fixed per process).
    func isServerLanReachable() async -> Bool
    /// How remote devices can currently reach this Mac's server: the LAN
    /// bind state plus the tailnet hostname when `tailscale serve` is active
    /// (from the server's advertised endpoints). Defaulted for conformers
    /// that predate tailnet access.
    func remoteAccessStatus() async -> ServerRemoteAccessStatus
    /// Mint a fresh one-time pairing credential and the QR-able pairing URL
    /// the SergeCode mobile app scans to connect to this machine.
    func mintMobilePairing(label: String) async throws -> MobilePairingInfo

    /// Server-side settings (the editable subset).
    func settings() async throws -> AppSettings
    /// Applies the full editable subset as a patch; returns the merged result.
    func updateSettings(_ settings: AppSettings) async throws -> AppSettings
    /// Ask the server to re-probe installed provider CLIs.
    func refreshProviders() async throws
    /// Run a provider CLI's own update command.
    func updateProvider(instanceID: String) async throws

    /// AI-curated scene names + Unsplash queries for a location photo set.
    /// Used by `SceneSetComposer`; fails when the sidecar/model is unavailable.
    func generateScenerySet(location: String) async throws -> GeneratedScenerySet
}

public extension BackendService {
    func archivedThreads() async throws -> [ChatThread] {
        try await threads().filter { $0.status == .archived }
    }
}

public extension BackendService {
    /// Backward-compatible mobile pairing label for existing Settings callers.
    func mintMobilePairing() async throws -> MobilePairingInfo {
        try await mintMobilePairing(label: "iPhone")
    }

    /// Default for conformers without tailnet awareness (test fakes): the
    /// LAN bind state only, no tailnet hostname.
    func remoteAccessStatus() async -> ServerRemoteAccessStatus {
        ServerRemoteAccessStatus(
            lanReachable: await isServerLanReachable(), tailnetHostname: nil)
    }
}

/// How remote devices can reach this Mac's server right now. `lanReachable`
/// reflects the sidecar's launch-captured bind host; `tailnetHostname` is
/// the MagicDNS name (`<machine>.<tailnet>.ts.net`) when `tailscale serve`
/// is active, i.e. the address pairing URLs will actually use.
public struct ServerRemoteAccessStatus: Sendable, Equatable {
    public var lanReachable: Bool
    public var tailnetHostname: String?

    public init(lanReachable: Bool, tailnetHostname: String?) {
        self.lanReachable = lanReachable
        self.tailnetHostname = tailnetHostname
    }
}

/// One freshly-minted mobile pairing handshake: the URL the iPhone scans
/// (`https://<magicdns>/pair#token=<code>` when Tailscale serve is active,
/// otherwise `http://<lan-ip>:<port>/pair#token=<code>` — the same shape the
/// server's headless `serve` prints, apps/server/src/startupAccess.ts
/// `buildPairingUrl`), the raw code for manual entry, and its expiry.
public struct MobilePairingInfo: Sendable, Equatable {
    public let pairingURL: URL
    public let credential: String
    public let expiresAt: Date

    public init(pairingURL: URL, credential: String, expiresAt: Date) {
        self.pairingURL = pairingURL
        self.credential = credential
        self.expiresAt = expiresAt
    }
}

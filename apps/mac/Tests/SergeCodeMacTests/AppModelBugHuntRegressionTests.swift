import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

// Regressions for the launch-ordering and review-mode error bugs: the
// `.connection(.ready)` refresh races the first shell snapshot, so an empty
// refresh must never be read as "these threads are gone", and a failed
// review-diff load must be distinguishable from a scope with no changes.

@Suite("Bug hunt regressions")
@MainActor
struct AppModelBugHuntRegressionTests {
    private func makeThread(id: String, status: ThreadStatus = .idle) -> ChatThread {
        ChatThread(
            id: id, projectID: "proj-1", title: "Thread \(id)", provider: .claude,
            status: status, updatedAt: Date(),
            sessionStatus: "idle")
    }

    @Test("an empty refresh does not drop pinned threads")
    func emptyRefreshKeepsPins() async {
        let backend = StubBackend()
        let model = AppModel(backend: backend)
        let pinned = makeThread(id: "t-pinned-\(UUID().uuidString)")
        model.togglePinned(pinned)
        #expect(model.pinnedThreadIDs.contains(pinned.id))

        // Cold launch: the shell snapshot hasn't landed, so `threads()` is empty.
        await model.refreshAll()

        #expect(model.pinnedThreadIDs.contains(pinned.id))
        model.togglePinned(pinned)
    }

    @Test("a refresh that carries threads still prunes stale pins")
    func populatedRefreshPrunesPins() async {
        let backend = StubBackend()
        let live = makeThread(id: "t-live-\(UUID().uuidString)")
        let gone = makeThread(id: "t-gone-\(UUID().uuidString)")
        backend.threadsResult = [live]
        let model = AppModel(backend: backend)
        model.togglePinned(live)
        model.togglePinned(gone)

        await model.refreshAll()

        #expect(model.pinnedThreadIDs.contains(live.id))
        #expect(!model.pinnedThreadIDs.contains(gone.id))
        model.togglePinned(live)
    }

    @Test("the closed-PR settle sweep waits for a refresh that carries threads")
    func settleSweepArmsOnPopulatedRefresh() async {
        let backend = StubBackend()
        let model = AppModel(backend: backend)

        // Empty launch refresh: the sweep must not burn its single attempt.
        await model.refreshAll()
        #expect(backend.vcsRefreshedThreadIDs.isEmpty)

        let thread = makeThread(id: "t-sweep")
        backend.threadsResult = [thread]
        await model.refreshAll()
        // The sweep runs in a detached Task; give it a turn to issue its calls.
        for _ in 0..<10 where backend.vcsRefreshedThreadIDs.isEmpty {
            await Task.yield()
        }

        #expect(backend.vcsRefreshedThreadIDs == [thread.id])
    }

    @Test("archiving the selected session clears the selection")
    func archiveClearsSelection() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let unselected = makeThread(id: "t-archive-unselected")
        let selected = makeThread(id: "t-archive-selected")
        await backend.insertThreads([unselected, selected])

        model.selectedThreadID = selected.id
        await model.archiveThread(unselected)
        #expect(model.selectedThreadID == selected.id)

        await model.archiveThread(selected)
        #expect(model.selectedThreadID == nil)
    }

    @Test("bulk archive clears the selection only when the selected session archived")
    func bulkArchiveClearsSelection() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let first = makeThread(id: "t-bulk-first")
        let second = makeThread(id: "t-bulk-second")
        let kept = makeThread(id: "t-bulk-keep")
        await backend.insertThreads([first, second, kept])

        model.selectedThreadID = kept.id
        await model.archiveThreads([first])
        #expect(model.selectedThreadID == kept.id)

        model.selectedThreadID = second.id
        await model.archiveThreads([second])
        #expect(model.selectedThreadID == nil)
    }

    @Test("a failed review-diff load records an error instead of an empty diff")
    func failedReviewDiffSurfacesError() async {
        let backend = StubBackend()
        backend.diffFiles = [
            DiffFile(path: "Sources/A.swift", status: .modified, hunks: [])
        ]
        let model = AppModel(backend: backend)
        model.openReview(threadID: "t-review", scope: .allChanges)
        await settleReviewLoad(model, threadID: "t-review")
        #expect(model.reviewDiffError(for: "t-review") == nil)
        #expect(model.threadState("t-review")?.reviewDiff?.count == 1)

        // A failed refresh must keep the diff the user is reading.
        backend.diffShouldFail = true
        await model.loadReviewDiff(threadID: "t-review")
        #expect(model.reviewDiffError(for: "t-review") != nil)
        #expect(model.threadState("t-review")?.reviewDiff?.count == 1)

        // Retry clears the error so the pane leaves the failure state.
        backend.diffShouldFail = false
        await model.loadReviewDiff(threadID: "t-review")
        #expect(model.reviewDiffError(for: "t-review") == nil)
    }

    @Test("closing review clears a stale load failure")
    func closeReviewClearsError() async {
        let backend = StubBackend()
        backend.diffShouldFail = true
        let model = AppModel(backend: backend)
        model.openReview(threadID: "t-review", scope: .allChanges)
        await settleReviewLoad(model, threadID: "t-review")
        #expect(model.reviewDiffError(for: "t-review") != nil)

        model.closeReview(threadID: "t-review")

        #expect(model.reviewDiffError(for: "t-review") == nil)
    }

    /// `openReview` kicks its load off in a detached Task, so awaiting a second
    /// `loadReviewDiff` would only observe the loser of the two — wait for the
    /// newest load to clear the loading flag instead.
    private func settleReviewLoad(_ model: AppModel, threadID: String) async {
        for _ in 0..<100 where model.threadState(threadID)?.isLoadingReviewDiff != false {
            await Task.yield()
        }
    }

    @Test("switching threads clears an error raised on the previous thread")
    func threadSwitchClearsLastError() {
        let model = AppModel(backend: MockBackend())
        model.selectedThreadID = "t-a"
        model.lastError = "boom"

        model.selectedThreadID = "t-b"

        #expect(model.lastError == nil)
    }

    @Test("settings writes reach the server in invocation order")
    func settingsWritesAreSerialized() async {
        let backend = StubBackend()
        backend.delayModelID = "gpt-5.4-mini"
        let model = AppModel(backend: backend)
        var old = try! await backend.settings()
        old.autoReview.modelID = "gpt-5.4-mini"
        var new = old
        new.autoReview.modelID = "gpt-5.6-sol"

        let oldSave = Task { await model.saveSettings(old) }
        await Task.yield()
        let newSave = Task { await model.saveSettings(new) }
        #expect(await oldSave.value)
        #expect(await newSave.value)

        #expect(backend.savedModelIDs == ["gpt-5.4-mini", "gpt-5.6-sol"])
        #expect(backend.storedSettings?.autoReview.modelID == "gpt-5.6-sol")
        #expect(model.settings?.autoReview.modelID == "gpt-5.6-sol")
    }
}

private enum StubBackendError: Error, Sendable {
    case failed
}

/// Minimal `BackendService` double: serves a configurable thread list, can fail
/// diff loads on demand, and records the sweep's one-shot VCS refreshes.
private final class StubBackend: BackendService, @unchecked Sendable {
    private let streamPair = AsyncStream<BackendEvent>.makeStream()

    var threadsResult: [ChatThread] = []
    var diffFiles: [DiffFile] = []
    var diffShouldFail = false
    var delayModelID: String?
    private(set) var savedModelIDs: [String] = []
    private(set) var storedSettings: AppSettings?
    private(set) var vcsRefreshedThreadIDs: [String] = []

    func events() async -> AsyncStream<BackendEvent> { streamPair.stream }

    func start() async {}
    func stop() async { streamPair.continuation.finish() }
    func projects() async throws -> [Project] { [] }
    func threads() async throws -> [ChatThread] { threadsResult }
    func timeline(threadID: String) async throws -> [TimelineItem] { [] }
    func closeTimeline(threadID: String) async {}
    func providers() async throws -> [ProviderInstance] { [] }
    func models() async throws -> [ModelOption] { [] }
    func searchWorkspace(threadID: String, query: String) async throws -> [WorkspaceEntry] { [] }
    func listWorkspace(threadID: String, subpath: String) async throws -> [WorkspaceEntry] { [] }
    func readWorkspaceFile(threadID: String, path: String) async throws -> FilePreview {
        FilePreview(path: path, contents: "", truncated: false)
    }
    func openInEditor(threadID: String, subpath: String?, editor: ExternalEditor) async throws {}
    func createThread(projectID: String, provider: ProviderKind, title: String?) async throws
        -> ChatThread
    {
        fatalError("unused")
    }
    func archiveThread(id: String) async throws {}
    func unarchiveThread(id: String) async throws {}
    func settleThread(id: String) async throws {}
    func unsettleThread(id: String) async throws {}
    func deleteThread(id: String) async throws {}
    func sendMessage(threadID: String, text: String, attachments: [OutgoingAttachment]) async throws
    {}
    func attachmentImageURL(id: String) async throws -> URL {
        throw StubBackendError.failed
    }
    func cancelTurn(threadID: String) async throws {}
    func stopTask(threadID: String, taskId: String) async throws {}
    func respondToApproval(id: String, decision: ApprovalDecision) async throws {}
    func respondToUserInput(id: String, answers: [String: [String]]) async throws {}
    func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws {}
    func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws {}
    func setExecutorModel(
        threadID: String, instanceID: String?, modelID: String?, maxSubAgents: Int?
    ) async throws {}
    func setModel(threadID: String, model: ModelOption) async throws {}
    func setReasoningEffort(threadID: String, value: String) async throws {}
    func setServiceTier(threadID: String, value: String) async throws {}
    func implementPlan(threadID: String, planID: String) async throws {}
    func diff(threadID: String) async throws -> [DiffFile] {
        if diffShouldFail { throw StubBackendError.failed }
        return diffFiles
    }
    func diff(threadID: String, fromTurn: Int, toTurn: Int) async throws -> [DiffFile] {
        if diffShouldFail { throw StubBackendError.failed }
        return diffFiles
    }
    func checkpoints(threadID: String) async throws -> [Checkpoint] { [] }
    func restoreCheckpoint(threadID: String, turnCount: Int) async throws {}
    func addProject(path: String, createWorkspaceRootIfMissing: Bool) async throws -> Project {
        fatalError("unused")
    }
    func renameProject(id: String, name: String) async throws {}
    func deleteProject(id: String) async throws {}
    func watchVcsStatus(threadID: String) async throws {}
    func refreshVcsStatus(threadID: String) async throws {
        vcsRefreshedThreadIDs.append(threadID)
    }
    func pullRequestReview(threadID: String, reference: String) async throws
        -> PullRequestReviewSnapshot
    {
        PullRequestReviewSnapshot(
            provider: "github", number: 0, url: "", conversation: [], threads: [],
            unresolvedThreadCount: 0, truncated: false)
    }
    func listBranches(threadID: String, query: String?) async throws -> [BranchRef] { [] }
    func switchBranch(threadID: String, name: String) async throws {}
    func createBranch(threadID: String, name: String) async throws {}
    func pull(threadID: String) async throws {}
    func runGitAction(threadID: String, action: GitAction, commitMessage: String?) async throws
        -> GitActionOutcome
    {
        fatalError("unused")
    }
    func isServerLanReachable() async -> Bool { false }
    func mintMobilePairing(label: String) async throws -> MobilePairingInfo { fatalError("unused") }
    func settings() async throws -> AppSettings {
        AppSettings(
            assistantStreaming: true,
            providerUpdateChecks: false,
            defaultEnvMode: .local,
            newWorktreesStartFromOrigin: false,
            addProjectBaseDirectory: "")
    }
    func updateSettings(_ settings: AppSettings) async throws -> AppSettings {
        if settings.autoReview.modelID == delayModelID {
            try? await Task.sleep(for: .milliseconds(50))
        }
        savedModelIDs.append(settings.autoReview.modelID)
        storedSettings = settings
        return settings
    }
    func listAutoReviewJobs(projectID: String?, limit: Int?) async throws -> [AppAutoReviewJob] { [] }
    func refreshProviders() async throws {}
    func updateProvider(instanceID: String) async throws {}
}

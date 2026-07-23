import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

// hasLoadedTimeline must only flip on a full history snapshot. A streamed
// append for a not-yet-selected thread must not suppress loadTimelineIfNeeded.

@Suite("AppModel timeline load gate")
@MainActor
struct AppModelTimelineLoadTests {
    @Test("timelineAppended before selection does not suppress history fetch")
    func appendDoesNotSuppressHistoryFetch() async throws {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let threadID = "thread-1"

        let seeded = try await backend.timeline(threadID: threadID)
        #expect(seeded.count > 1, "MockBackend seeds multi-item history for thread-1")

        // Startup stream event before the thread is selected (reproduces the
        // MockBackend subagent demo hazard).
        model.enqueue(
            .timelineAppended(
                threadID: threadID,
                item: .userMessage(
                    id: "early-append", text: "streamed only", at: Date())))
        model.flushPendingEvents()

        #expect(model.threadState(threadID)?.hasLoadedTimeline == false)
        #expect((model.threadState(threadID)?.timeline.count ?? 0) == 1)

        await model.loadTimelineIfNeeded(threadID: threadID)

        let loaded = model.threadState(threadID)?.timeline ?? []
        #expect(model.threadState(threadID)?.hasLoadedTimeline == true)
        #expect(loaded.count > 1, "full seeded history must be fetched")
        #expect(loaded.count == seeded.count)
    }

    @Test("timelineReset still marks history loaded")
    func resetMarksHistoryLoaded() {
        let model = AppModel(backend: MockBackend())
        model.enqueue(
            .timelineReset(
                threadID: "t1",
                items: [
                    .userMessage(id: "u1", text: "hi", at: Date()),
                    .assistantMessage(
                        id: "a1", markdown: "yo", isStreaming: false, at: Date()),
                ]))
        model.flushPendingEvents()

        #expect(model.threadState("t1")?.hasLoadedTimeline == true)
        #expect((model.threadState("t1")?.timeline.count ?? 0) == 2)
    }

    @Test("cold fetch exposes loading state and clears it after snapshot")
    func coldFetchTracksLoadingState() async {
        let backend = BlockingTimelineBackend()
        let model = AppModel(backend: backend)
        let items = [
            TimelineItem.userMessage(id: "cold-user", text: "hello", at: Date())
        ]

        let task = Task { await model.loadTimelineIfNeeded(threadID: "cold") }
        for _ in 0..<20 {
            if backend.timelineCallCount > 0 { break }
            await Task.yield()
        }

        #expect(backend.timelineCallCount == 1)
        #expect(model.threadState("cold")?.isLoadingTimeline == true)
        backend.resolve(items: items)
        await task.value

        #expect(model.threadState("cold")?.isLoadingTimeline == false)
        #expect(model.threadState("cold")?.hasLoadedTimeline == true)
        #expect(model.threadState("cold")?.timeline.map(\.id) == items.map(\.id))
    }

    @Test("failed cold fetch clears loading state")
    func failedColdFetchClearsLoadingState() async {
        let backend = BlockingTimelineBackend()
        let model = AppModel(backend: backend)

        let task = Task { await model.loadTimelineIfNeeded(threadID: "failed") }
        for _ in 0..<20 {
            if backend.timelineCallCount > 0 { break }
            await Task.yield()
        }

        #expect(model.threadState("failed")?.isLoadingTimeline == true)
        backend.fail()
        await task.value

        #expect(model.threadState("failed")?.isLoadingTimeline == false)
        #expect(model.threadState("failed")?.hasLoadedTimeline == false)
    }

    @Test("warm timeline does not enter loading state or fetch")
    func warmTimelineSkipsLoadingFetch() async {
        let backend = BlockingTimelineBackend()
        let model = AppModel(backend: backend)
        model.enqueue(
            .timelineReset(
                threadID: "warm",
                items: [.userMessage(id: "warm-user", text: "already here", at: Date())]))
        model.flushPendingEvents()

        await model.loadTimelineIfNeeded(threadID: "warm")

        #expect(backend.timelineCallCount == 0)
        #expect(model.threadState("warm")?.isLoadingTimeline == false)
        #expect(model.threadState("warm")?.hasLoadedTimeline == true)
    }
}

private enum BlockingTimelineBackendError: Error, Sendable {
    case failed
}

/// A deterministic timeline gate lets the tests observe the loading state
/// while AppModel is suspended in the backend fetch.
private final class BlockingTimelineBackend: BackendService, @unchecked Sendable {
    private let streamPair = AsyncStream<BackendEvent>.makeStream()
    private var pendingTimeline:
        CheckedContinuation<
            Result<[TimelineItem], BlockingTimelineBackendError>, Never
        >?
    private var queuedTimelineResult:
        Result<[TimelineItem], BlockingTimelineBackendError>?

    private(set) var timelineCallCount = 0

    func events() async -> AsyncStream<BackendEvent> { streamPair.stream }

    func start() async {}
    func stop() async { streamPair.continuation.finish() }
    func projects() async throws -> [Project] { [] }
    func threads() async throws -> [ChatThread] { [] }

    func timeline(threadID: String) async throws -> [TimelineItem] {
        timelineCallCount += 1
        let result: Result<[TimelineItem], BlockingTimelineBackendError>
        if let queuedTimelineResult {
            self.queuedTimelineResult = nil
            result = queuedTimelineResult
        } else {
            result = await withCheckedContinuation {
                (continuation: CheckedContinuation<
                    Result<[TimelineItem], BlockingTimelineBackendError>, Never
                >) in
                pendingTimeline = continuation
            }
        }
        return try result.get()
    }

    func resolve(items: [TimelineItem]) {
        finish(.success(items))
    }

    func fail() {
        finish(.failure(.failed))
    }

    private func finish(
        _ result: Result<[TimelineItem], BlockingTimelineBackendError>
    ) {
        if let pendingTimeline {
            self.pendingTimeline = nil
            pendingTimeline.resume(returning: result)
        } else {
            queuedTimelineResult = result
        }
    }

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
    func cancelTurn(threadID: String) async throws {}
    func stopTask(threadID: String, taskId: String) async throws {}
    func respondToApproval(id: String, approve: Bool) async throws {}
    func respondToUserInput(id: String, answers: [String: [String]]) async throws {}
    func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws {}
    func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws {}
    func setExecutorModel(threadID: String, instanceID: String?, modelID: String?) async throws {}
    func setModel(threadID: String, model: ModelOption) async throws {}
    func setReasoningEffort(threadID: String, value: String) async throws {}
    func setServiceTier(threadID: String, value: String) async throws {}
    func implementPlan(threadID: String, planID: String) async throws {}
    func diff(threadID: String) async throws -> [DiffFile] { [] }
    func diff(threadID: String, fromTurn: Int, toTurn: Int) async throws -> [DiffFile] { [] }
    func checkpoints(threadID: String) async throws -> [Checkpoint] { [] }
    func restoreCheckpoint(threadID: String, turnCount: Int) async throws {}
    func addProject(path: String) async throws -> Project { fatalError("unused") }
    func renameProject(id: String, name: String) async throws {}
    func deleteProject(id: String) async throws {}
    func watchVcsStatus(threadID: String) async throws {}
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
    func updateSettings(_ settings: AppSettings) async throws -> AppSettings { settings }
    func refreshProviders() async throws {}
    func updateProvider(instanceID: String) async throws {}
    func generateScenerySet(location: String) async throws -> GeneratedScenerySet {
        fatalError("unused")
    }
}

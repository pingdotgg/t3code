import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

// The model picker's "Recent" scope is a record of what the thread actually
// ran on. Recording it at the tap would let a switch the backend rejected —
// an unreachable provider, a cancelled request — promote a model the thread
// never used, and that wrong entry then outranks real ones in the quick-switch
// menu until eight more selections push it out.

@Suite("Model recency recording")
@MainActor
struct AppModelModelRecencyTests {
    private func makePreferences() -> ModelPickerPreferences {
        let suite = "AppModelModelRecencyTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return ModelPickerPreferences(defaults: defaults)
    }

    private func makeModel(
        backend: RecencyStubBackend, preferences: ModelPickerPreferences
    ) -> AppModel {
        let model = AppModel(backend: backend)
        model.modelPickerPreferences = preferences
        model.selectedThreadID = "t-1"
        return model
    }

    private var option: ModelOption {
        ModelOption(
            instanceID: "codex-a", modelID: "gpt-5", displayName: "GPT-5", provider: .codex,
            isDefault: false)
    }

    @Test("an accepted model switch enters the recents list")
    func acceptedSwitchIsRecorded() async {
        let preferences = makePreferences()
        let model = makeModel(backend: RecencyStubBackend(), preferences: preferences)

        await model.setModel(option)

        #expect(preferences.recents == ["codex/gpt-5"])
    }

    @Test("a rejected model switch leaves recents untouched")
    func rejectedSwitchIsNotRecorded() async {
        let preferences = makePreferences()
        let backend = RecencyStubBackend()
        backend.setModelShouldFail = true
        let model = makeModel(backend: backend, preferences: preferences)

        await model.setModel(option)

        #expect(preferences.recents.isEmpty)
        #expect(model.lastError != nil)
    }

    @Test("an executor model switch records only the model the backend accepted")
    func executorSwitchRecordsOnSuccess() async {
        let preferences = makePreferences()
        let backend = RecencyStubBackend()
        let model = makeModel(backend: backend, preferences: preferences)
        backend.modelsResult = [option]
        await model.refreshAll()
        model.selectedThreadID = "t-1"

        await model.setExecutorModel(instanceID: "codex-a", modelID: "gpt-5")
        // Clearing the executor is not a model selection and must not appear.
        await model.setExecutorModel(instanceID: nil, modelID: nil)

        #expect(preferences.recents == ["codex/gpt-5"])

        backend.setExecutorModelShouldFail = true
        await model.setExecutorModel(instanceID: "codex-a", modelID: "gpt-5")

        #expect(preferences.recents == ["codex/gpt-5"])
    }
}

private enum RecencyStubBackendError: Error, Sendable {
    case failed
}

/// Minimal `BackendService` double whose model-switching calls can be made to
/// fail on demand.
private final class RecencyStubBackend: BackendService, @unchecked Sendable {
    private let streamPair = AsyncStream<BackendEvent>.makeStream()

    var setModelShouldFail = false
    var setExecutorModelShouldFail = false
    var modelsResult: [ModelOption] = []

    func events() async -> AsyncStream<BackendEvent> { streamPair.stream }

    func start() async {}
    func stop() async { streamPair.continuation.finish() }
    func projects() async throws -> [Project] { [] }
    func threads() async throws -> [ChatThread] { [] }
    func timeline(threadID: String) async throws -> [TimelineItem] { [] }
    func closeTimeline(threadID: String) async {}
    func providers() async throws -> [ProviderInstance] { [] }
    func models() async throws -> [ModelOption] { modelsResult }
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
        throw RecencyStubBackendError.failed
    }
    func cancelTurn(threadID: String) async throws {}
    func stopTask(threadID: String, taskId: String) async throws {}
    func respondToApproval(id: String, approve: Bool) async throws {}
    func respondToUserInput(id: String, answers: [String: [String]]) async throws {}
    func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws {}
    func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws {}
    func setExecutorModel(
        threadID: String, instanceID: String?, modelID: String?, maxSubAgents: Int?
    ) async throws {
        if setExecutorModelShouldFail { throw RecencyStubBackendError.failed }
    }
    func setModel(threadID: String, model: ModelOption) async throws {
        if setModelShouldFail { throw RecencyStubBackendError.failed }
    }
    func setReasoningEffort(threadID: String, value: String) async throws {}
    func setServiceTier(threadID: String, value: String) async throws {}
    func implementPlan(threadID: String, planID: String) async throws {}
    func diff(threadID: String) async throws -> [DiffFile] { [] }
    func diff(threadID: String, fromTurn: Int, toTurn: Int) async throws -> [DiffFile] { [] }
    func checkpoints(threadID: String) async throws -> [Checkpoint] { [] }
    func restoreCheckpoint(threadID: String, turnCount: Int) async throws {}
    func addProject(path: String, createWorkspaceRootIfMissing: Bool) async throws -> Project {
        fatalError("unused")
    }
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
    func listAutoReviewJobs(projectID: String?, limit: Int?) async throws -> [AppAutoReviewJob] { [] }
    func refreshProviders() async throws {}
    func updateProvider(instanceID: String) async throws {}
}

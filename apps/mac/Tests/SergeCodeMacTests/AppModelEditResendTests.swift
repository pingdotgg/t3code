import Foundation
import T3Kit
import Testing

@testable import SergeCodeMac

// Edit-then-resend must rewind the thread (server revert) and replace the
// edited user message rather than appending a duplicate turn.

@Suite("AppModel edit-resend")
@MainActor
struct AppModelEditResendTests {
    private func makeModel(backend: any BackendService = MockBackend()) -> AppModel {
        AppModel(backend: backend)
    }

    private func userTexts(_ items: [TimelineItem]) -> [String] {
        items.compactMap {
            if case .userMessage(_, let text, _) = $0 { return text }
            return nil
        }
    }

    private func userIDs(_ items: [TimelineItem]) -> [String] {
        items.compactMap {
            if case .userMessage(let id, _, _) = $0 { return id }
            return nil
        }
    }

    // MARK: - Turn-count mapping (web-client parity)

    @Test("maps user message to checkpoint turnCount - 1")
    func mappingUsesCheckpointTurnCount() {
        let now = Date()
        let timeline: [TimelineItem] = [
            .userMessage(id: "u1", text: "first", at: now),
            .assistantMessage(id: "a1", markdown: "r1", isStreaming: false, at: now),
            .checkpoint(
                Checkpoint(
                    id: "ck1", threadID: "t", label: "Turn 1", createdAt: now, turnCount: 1)),
            .userMessage(id: "u2", text: "second", at: now),
            .assistantMessage(id: "a2", markdown: "r2", isStreaming: false, at: now),
            .checkpoint(
                Checkpoint(
                    id: "ck2", threadID: "t", label: "Turn 2", createdAt: now, turnCount: 2)),
        ]
        #expect(AppModel.revertTurnCount(forUserMessageID: "u1", in: timeline) == 0)
        #expect(AppModel.revertTurnCount(forUserMessageID: "u2", in: timeline) == 1)
    }

    @Test("falls back to 0-based user index when no checkpoint follows")
    func mappingFallsBackToUserIndex() {
        let now = Date()
        let timeline: [TimelineItem] = [
            .userMessage(id: "u1", text: "first", at: now),
            .assistantMessage(id: "a1", markdown: "r1", isStreaming: false, at: now),
            .userMessage(id: "u2", text: "second — stopped mid-turn", at: now),
        ]
        #expect(AppModel.revertTurnCount(forUserMessageID: "u1", in: timeline) == 0)
        #expect(AppModel.revertTurnCount(forUserMessageID: "u2", in: timeline) == 1)
    }

    @Test("unknown message id yields nil")
    func mappingUnknownMessage() {
        let timeline: [TimelineItem] = [
            .userMessage(id: "u1", text: "hi", at: Date())
        ]
        #expect(AppModel.revertTurnCount(forUserMessageID: "missing", in: timeline) == nil)
    }

    // MARK: - AppModel send path (RecordingBackend)

    @Test("edit-resend reverts then sends and drops later turns")
    func editResendReplaces() async throws {
        let now = Date()
        let thread = ChatThread(
            id: "t-edit", projectID: "p1", title: "Edit", provider: .codex,
            status: .idle, updatedAt: now)
        let seeded: [TimelineItem] = [
            .userMessage(id: "u1", text: "first turn", at: now),
            .assistantMessage(id: "a1", markdown: "reply one", isStreaming: false, at: now),
            .userMessage(id: "u2", text: "second turn", at: now),
            .assistantMessage(id: "a2", markdown: "reply two", isStreaming: false, at: now),
        ]
        let backend = RecordingBackend(
            thread: thread,
            initialTimeline: seeded)
        let model = makeModel(backend: backend)
        // Seed AppModel timeline for turn-count mapping (no event loop needed).
        model.enqueue(.threadUpserted(thread))
        model.enqueue(.timelineReset(threadID: thread.id, items: seeded))
        model.flushPendingEvents()
        model.selectedThreadID = thread.id

        await model.send(
            text: "edited first",
            replacingMessageID: "u1",
            replacingMessageThreadID: thread.id)

        // Orchestration: revert to turn 0, then send the edited text.
        #expect(backend.revertCalls.count == 1)
        #expect(backend.revertCalls[0].threadID == "t-edit")
        #expect(backend.revertCalls[0].turnCount == 0)
        #expect(backend.sentTexts == ["edited first"])
        #expect(backend.sentThreadIDs == ["t-edit"])

        // Backend timeline is the authority after revert+send.
        let after = try await backend.timeline(threadID: thread.id)
        #expect(userTexts(after) == ["edited first"])
        #expect(!after.contains {
            if case .assistantMessage(_, let md, _, _) = $0 {
                return md == "reply one" || md == "reply two"
            }
            return false
        })
        #expect(!userTexts(after).contains("first turn"))
        #expect(!userTexts(after).contains("second turn"))

        // Applying the emitted events into AppModel yields the same view.
        for event in backend.emitted {
            model.enqueue(event)
        }
        model.flushPendingEvents()
        let ui = model.threadState(thread.id)?.timeline ?? []
        #expect(userTexts(ui) == ["edited first"])
    }

    @Test("staged edit send on another thread does not truncate the origin")
    func crossThreadSendDoesNotTruncate() async throws {
        let now = Date()
        let threadA = ChatThread(
            id: "t-a", projectID: "p1", title: "A", provider: .codex,
            status: .idle, updatedAt: now)
        let threadB = ChatThread(
            id: "t-b", projectID: "p1", title: "B", provider: .codex,
            status: .idle, updatedAt: now)
        let seededA: [TimelineItem] = [
            .userMessage(id: "u-a", text: "only on A", at: now),
            .assistantMessage(id: "a-a", markdown: "reply A", isStreaming: false, at: now),
        ]
        let backend = RecordingBackend(
            thread: threadA,
            initialTimeline: seededA,
            extraThreads: [threadB])
        let model = makeModel(backend: backend)
        model.enqueue(.threadUpserted(threadA))
        model.enqueue(.timelineReset(threadID: threadA.id, items: seededA))
        model.enqueue(.threadUpserted(threadB))
        model.enqueue(.timelineReset(threadID: threadB.id, items: []))
        model.flushPendingEvents()
        model.selectedThreadID = threadB.id

        await model.send(
            text: "message on B",
            replacingMessageID: "u-a",
            replacingMessageThreadID: threadA.id)

        #expect(backend.revertCalls.isEmpty)
        #expect(backend.sentTexts == ["message on B"])
        #expect(backend.sentThreadIDs == ["t-b"])

        let backendA = try await backend.timeline(threadID: threadA.id)
        #expect(userTexts(backendA) == ["only on A"])
        let backendB = try await backend.timeline(threadID: threadB.id)
        #expect(userTexts(backendB) == ["message on B"])

        // AppModel still holds A's original timeline (no revert event).
        let aItems = model.threadState(threadA.id)?.timeline ?? []
        #expect(userTexts(aItems).contains("only on A"))
        #expect(aItems.count == seededA.count)
    }

    @Test("composer prefill carries edited message identity")
    func prefillCarriesEditIdentity() {
        let model = makeModel()
        model.selectedThreadID = "thread-1"
        model.stageComposerText("rewrite me", editedMessageID: "msg-42")
        let prefill = model.takeComposerPrefill()
        #expect(prefill?.text == "rewrite me")
        #expect(prefill?.editedMessageID == "msg-42")
        #expect(prefill?.editedMessageThreadID == "thread-1")
        #expect(model.takeComposerPrefill() == nil)
    }

    @Test("clearComposerPrefill drops staged edit")
    func clearPrefill() {
        let model = makeModel()
        model.selectedThreadID = "thread-1"
        model.stageComposerText("x", editedMessageID: "m1")
        model.clearComposerPrefill()
        #expect(model.composerPrefill == nil)
    }

    @Test("mock revert keeps earlier turns only")
    func mockRevertTruncates() async throws {
        let backend = MockBackend()
        await backend.start()
        let thread = try await backend.createThread(
            projectID: "project-1", provider: .codex, title: "Mock revert")
        try await backend.sendMessage(threadID: thread.id, text: "first", attachments: [])
        try await backend.sendMessage(threadID: thread.id, text: "second", attachments: [])
        let before = try await backend.timeline(threadID: thread.id)
        #expect(userTexts(before).count == 2)

        try await backend.restoreCheckpoint(threadID: thread.id, turnCount: 1)
        let after = try await backend.timeline(threadID: thread.id)
        #expect(userTexts(after) == ["first"])
        #expect(!userTexts(after).contains("second"))
    }
}

// MARK: - Recording backend

/// Minimal BackendService double: records revert/send, applies timelineReset on
/// revert (same event shape as LiveBackend/MockBackend), appends on send.
@MainActor
private final class RecordingBackend: BackendService, @unchecked Sendable {
    let eventStream: AsyncStream<BackendEvent>
    private let continuation: AsyncStream<BackendEvent>.Continuation

    private(set) var revertCalls: [(threadID: String, turnCount: Int)] = []
    private(set) var sentTexts: [String] = []
    private(set) var sentThreadIDs: [String] = []
    /// Events that would have gone to AppModel's stream (for deterministic
    /// re-application in tests that don't run the live event loop).
    private(set) var emitted: [BackendEvent] = []

    private var timelines: [String: [TimelineItem]]
    private var threads: [String: ChatThread]

    init(
        thread: ChatThread,
        initialTimeline: [TimelineItem],
        extraThreads: [ChatThread] = []
    ) {
        let (stream, continuation) = AsyncStream<BackendEvent>.makeStream()
        self.eventStream = stream
        self.continuation = continuation
        self.timelines = [thread.id: initialTimeline]
        var threads = [thread.id: thread]
        for extra in extraThreads {
            threads[extra.id] = extra
            self.timelines[extra.id] = []
        }
        self.threads = threads
    }

    func events() async -> AsyncStream<BackendEvent> { eventStream }
    func start() async {}
    func stop() async { continuation.finish() }

    func projects() async throws -> [Project] { [] }
    func threads() async throws -> [ChatThread] { Array(threads.values) }
    func timeline(threadID: String) async throws -> [TimelineItem] {
        timelines[threadID] ?? []
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
    func pullRequestReview(threadID: String, reference: String) async throws
        -> PullRequestReviewSnapshot
    {
        fatalError("unused")
    }
    func createThread(projectID: String, provider: ProviderKind, title: String?) async throws
        -> ChatThread
    {
        fatalError("unused")
    }
    func archiveThread(id: String) async throws {}
    func unarchiveThread(id: String) async throws {}
    func deleteThread(id: String) async throws {}
    func generateScenerySet(location: String) async throws -> GeneratedScenerySet {
        fatalError("unused")
    }

    func sendMessage(threadID: String, text: String, attachments: [OutgoingAttachment]) async throws
    {
        sentTexts.append(text)
        sentThreadIDs.append(threadID)
        let item = TimelineItem.userMessage(id: "sent-\(sentTexts.count)", text: text, at: Date())
        timelines[threadID, default: []].append(item)
        let event = BackendEvent.timelineAppended(threadID: threadID, item: item)
        emitted.append(event)
        continuation.yield(event)
    }

    func cancelTurn(threadID: String) async throws {}
    func stopTask(threadID: String, taskId: String) async throws {}
    func respondToApproval(id: String, approve: Bool) async throws {}
    func respondToUserInput(id: String, answers: [String: [String]]) async throws {}
    func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws {}
    func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws {}
    func setModel(threadID: String, model: ModelOption) async throws {}
    func setReasoningEffort(threadID: String, value: String) async throws {}
    func setServiceTier(threadID: String, value: String) async throws {}
    func implementPlan(threadID: String, planID: String) async throws {}
    func diff(threadID: String) async throws -> [DiffFile] { [] }
    func diff(threadID: String, fromTurn: Int, toTurn: Int) async throws -> [DiffFile] { [] }
    func checkpoints(threadID: String) async throws -> [Checkpoint] { [] }

    func restoreCheckpoint(threadID: String, turnCount: Int) async throws {
        revertCalls.append((threadID, turnCount))
        let retained = timelineRetaining(turnCount: turnCount, from: timelines[threadID] ?? [])
        timelines[threadID] = retained
        let event = BackendEvent.timelineReset(threadID: threadID, items: retained)
        emitted.append(event)
        continuation.yield(event)
    }

    func addProject(path: String) async throws -> Project {
        Project(id: "p", name: "p", path: path)
    }
    func renameProject(id: String, name: String) async throws {}
    func deleteProject(id: String) async throws {}
    func watchVcsStatus(threadID: String) async throws {}
    func listBranches(threadID: String, query: String?) async throws -> [BranchRef] { [] }
    func switchBranch(threadID: String, name: String) async throws {}
    func createBranch(threadID: String, name: String) async throws {}
    func pull(threadID: String) async throws {}
    func runGitAction(threadID: String, action: GitAction, commitMessage: String?) async throws
        -> GitActionOutcome
    {
        GitActionOutcome(success: true, title: "ok")
    }
    func isServerLanReachable() async -> Bool { false }
    func mintMobilePairing(label: String) async throws -> MobilePairingInfo {
        MobilePairingInfo(
            pairingURL: URL(string: "http://127.0.0.1/pair#token=x")!,
            credential: "x", expiresAt: Date())
    }
    func settings() async throws -> AppSettings {
        AppSettings(
            assistantStreaming: true, providerUpdateChecks: true, defaultEnvMode: .local,
            newWorktreesStartFromOrigin: false, addProjectBaseDirectory: "~/Documents")
    }
    func updateSettings(_ settings: AppSettings) async throws -> AppSettings { settings }
    func refreshProviders() async throws {}
    func updateProvider(instanceID: String) async throws {}

    private func timelineRetaining(turnCount: Int, from items: [TimelineItem]) -> [TimelineItem] {
        guard turnCount > 0 else { return [] }
        var userCount = 0
        var retained: [TimelineItem] = []
        for item in items {
            if case .userMessage = item {
                userCount += 1
                if userCount > turnCount { break }
            }
            retained.append(item)
        }
        return retained
    }
}

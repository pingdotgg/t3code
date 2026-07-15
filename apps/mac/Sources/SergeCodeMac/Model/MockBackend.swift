import Foundation
import T3Kit

// Deterministic-but-alive fake backend for UI work without the Node sidecar.
// All mutable state lives behind an actor; the public API is the BackendService
// protocol (Sendable, async). Events are pushed through a fresh AsyncStream
// per AppModel lifecycle so restart tests behave like the live backend.

private enum MockBackendError: Error, LocalizedError {
    case emptyLocation
    case threadNotFound(String)
    case taskNotFound(threadID: String, taskId: String)
    var errorDescription: String? {
        switch self {
        case .emptyLocation: "Location must not be empty."
        case .threadNotFound(let id): "Thread not found: \(id)."
        case .taskNotFound(let threadID, let taskId):
            "Task '\(taskId)' not found on thread \(threadID)."
        }
    }
}

public final class MockBackend: BackendService, @unchecked Sendable {
    private let state: MockState

    public init(seedVariant: String? = nil) {
        self.state = MockState(seedVariant: seedVariant)
    }

    public func events() async -> AsyncStream<BackendEvent> {
        await state.events()
    }

    public func start() async {
        await state.start()
    }

    public func stop() async {
        await state.stop()
    }

    public func projects() async throws -> [Project] {
        await state.projects()
    }

    public func threads() async throws -> [ChatThread] {
        await state.threads()
    }

    public func timeline(threadID: String) async throws -> [TimelineItem] {
        await state.timeline(threadID: threadID)
    }

    public func closeTimeline(threadID: String) async {
        // Mock has no live subscriptions to tear down.
    }

    #if DEBUG
        /// Probe hook: toggle server stall state on a thread.
        public func probeSetThreadHealth(threadID: String, stalled: Bool) async {
            await state.setThreadHealth(threadID: threadID, stalled: stalled)
        }

        /// Probe hook: spawn a sibling-agent thread (optionally stalled).
        @discardableResult
        public func probeCreateSiblingAgent(
            name: String, provider: ProviderKind, projectID: String, stalled: Bool
        ) async -> ChatThread {
            await state.createSiblingAgent(
                name: name, provider: provider, projectID: projectID, stalled: stalled)
        }

        /// Probe hook: append a `session.exited` stderr disclosure row.
        public func probeAppendSessionExit(
            threadID: String, summary: String, stderrTail: String
        ) async {
            await state.appendSessionExit(
                threadID: threadID, summary: summary, stderrTail: stderrTail)
        }
    #endif

    public func providers() async throws -> [ProviderInstance] {
        await state.providers()
    }

    public func createThread(
        projectID: String, provider: ProviderKind, title: String?
    ) async throws -> ChatThread {
        await state.createThread(projectID: projectID, provider: provider, title: title)
    }

    public func archiveThread(id: String) async throws {
        await state.archiveThread(id: id)
    }

    public func unarchiveThread(id: String) async throws {
        await state.unarchiveThread(id: id)
    }

    public func deleteThread(id: String) async throws {
        await state.deleteThread(id: id)
    }

    public func isServerLanReachable() async -> Bool {
        // The mock pretends the LAN bind is active so the pairing UI is
        // fully exercisable without a real sidecar.
        MobileAccessPreference.isEnabled
    }

    public func mintMobilePairing(label: String) async throws -> MobilePairingInfo {
        MobilePairingInfo(
            pairingURL: URL(string: "http://192.168.1.42:3773/pair#token=MOCKPAIR2345")!,
            credential: "MOCKPAIR2345",
            expiresAt: Date().addingTimeInterval(5 * 60))
    }

    public func settings() async throws -> AppSettings {
        await state.settings
    }

    public func updateSettings(_ settings: AppSettings) async throws -> AppSettings {
        await state.updateSettings(settings)
    }

    public func refreshProviders() async throws {}

    public func updateProvider(instanceID: String) async throws {}

    public func generateScenerySet(location: String) async throws -> GeneratedScenerySet {
        let trimmed = location.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw MockBackendError.emptyLocation
        }
        // Deterministic fixture for UI/dev without the model CLI.
        let slug = trimmed.lowercased()
        let locations: [GeneratedSceneryLocation] = (1...14).map { index in
            let name = "\(trimmed) Viewpoint \(index)"
            return GeneratedSceneryLocation(
                name: name,
                query: "\(name) \(slug)",
                timeOfDay: index == 3 ? .dawn : nil,
                season: index == 7 ? .winter : nil)
        }
        return GeneratedScenerySet(
            sceneNames: locations.map(\.name),
            queries: [
                GeneratedSceneryQuery(text: "\(slug) landscape"),
                GeneratedSceneryQuery(text: "\(slug) mountains", timeOfDay: .day),
                GeneratedSceneryQuery(text: "\(slug) sunrise", timeOfDay: .dawn),
                GeneratedSceneryQuery(text: "\(slug) coast"),
                GeneratedSceneryQuery(text: "\(slug) autumn colors", season: .autumn),
            ],
            locations: locations)
    }

    public func watchVcsStatus(threadID: String) async throws {
        await state.emitVcsStatus(threadID: threadID)
    }

    public func pullRequestReview(threadID: String, reference: String) async throws
        -> PullRequestReviewSnapshot
    {
        let bot = PullRequestReviewAuthor(
            login: "coderabbitai[bot]", avatarURL: nil, isBot: true)
        let now = Date()
        let inline = PullRequestReviewComment(
            id: "mock-inline-review", author: bot, authorAssociation: "CONTRIBUTOR",
            body: "Guard this failure path so a reconnect cannot discard the pending review.",
            url: "https://github.com/SergeSerb2/SergeCode/pull/1#discussion_r1",
            createdAt: now, updatedAt: now, reviewState: nil)
        let summary = PullRequestReviewComment(
            id: "mock-review-summary", author: bot, authorAssociation: "CONTRIBUTOR",
            body: "I found one actionable issue and left it inline.",
            url: "https://github.com/SergeSerb2/SergeCode/pull/1#pullrequestreview-1",
            createdAt: now, updatedAt: now, reviewState: "COMMENTED")
        return PullRequestReviewSnapshot(
            provider: "github", number: Int(reference) ?? 1,
            url: "https://github.com/SergeSerb2/SergeCode/pull/1",
            conversation: [summary],
            threads: [
                PullRequestReviewThread(
                    id: "mock-thread", isResolved: false, isOutdated: false,
                    path: "apps/mac/Sources/SergeCodeMac/Model/LiveBackend.swift",
                    line: 2142, originalLine: 2140, diffSide: "RIGHT", comments: [inline])
            ],
            unresolvedThreadCount: 1, truncated: false)
    }

    public func listBranches(threadID: String, query: String?) async throws -> [BranchRef] {
        [
            BranchRef(name: "main", isCurrent: false, isDefault: true, isRemote: false),
            BranchRef(name: "feat/native-mac-app", isCurrent: true, isDefault: false, isRemote: false),
            BranchRef(name: "fix/sidebar-scroll", isCurrent: false, isDefault: false, isRemote: false),
        ]
        .filter { branch in
            query.map { branch.name.localizedCaseInsensitiveContains($0) } ?? true
        }
    }

    public func switchBranch(threadID: String, name: String) async throws {
        await state.emitVcsStatus(threadID: threadID, branch: name)
    }

    public func createBranch(threadID: String, name: String) async throws {
        await state.emitVcsStatus(threadID: threadID, branch: name)
    }

    public func pull(threadID: String) async throws {}

    public func runGitAction(
        threadID: String, action: GitAction, commitMessage: String?
    ) async throws -> GitActionOutcome {
        try? await Task.sleep(nanoseconds: 400_000_000)
        if action == .mergePR {
            await state.emitVcsStatus(
                threadID: threadID,
                branch: "feat/native-mac-app",
                prState: .merged,
                reviewDecision: .approved,
                unresolvedReviewThreadCount: 0)
            return GitActionOutcome(
                success: true, title: "Merged PR #1",
                prURL: "https://github.com/SergeSerb2/SergeCode/pull/1")
        }
        return GitActionOutcome(
            success: true, title: "\(action.displayName) finished",
            detail: commitMessage,
            prURL: action == .commitPushPR ? "https://github.com/SergeSerb2/SergeCode/pull/1" : nil)
    }

    public func sendMessage(
        threadID: String, text: String, attachments: [OutgoingAttachment]
    ) async throws {
        await state.sendMessage(threadID: threadID, text: text, attachments: attachments)
    }

    public func searchWorkspace(threadID: String, query: String) async throws -> [WorkspaceEntry] {
        await state.searchWorkspace(query: query)
    }

    public func listWorkspace(threadID: String, subpath: String) async throws -> [WorkspaceEntry] {
        await state.searchWorkspace(query: "")
    }

    public func readWorkspaceFile(threadID: String, path: String) async throws -> FilePreview {
        FilePreview(
            path: path,
            contents: "// mock contents of \(path)\nimport Foundation\n\nlet answer = 42\n",
            truncated: false)
    }

    public func openInEditor(
        threadID: String, subpath: String?, editor: ExternalEditor
    ) async throws {}

    public func cancelTurn(threadID: String) async throws {
        await state.cancelTurn(threadID: threadID)
    }

    public func stopTask(threadID: String, taskId: String) async throws {
        try await state.stopTask(threadID: threadID, taskId: taskId)
    }

    public func respondToApproval(id: String, approve: Bool) async throws {
        await state.respondToApproval(id: id, approve: approve)
    }

    public func models() async throws -> [ModelOption] {
        await state.models()
    }

    public func respondToUserInput(id: String, answers: [String: [String]]) async throws {
        await state.respondToUserInput(id: id, answers: answers)
    }

    public func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws {
        await state.setRuntimeMode(threadID: threadID, mode: mode)
    }

    public func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws {
        await state.setInteractionMode(threadID: threadID, mode: mode)
    }

    public func setModel(threadID: String, model: ModelOption) async throws {
        await state.setModel(threadID: threadID, model: model)
    }

    public func setReasoningEffort(threadID: String, value: String) async throws {
        await state.setReasoningEffort(threadID: threadID, value: value)
    }

    public func setServiceTier(threadID: String, value: String) async throws {
        await state.setServiceTier(threadID: threadID, value: value)
    }

    public func implementPlan(threadID: String, planID: String) async throws {
        await state.setInteractionMode(threadID: threadID, mode: .normal)
        await state.sendMessage(threadID: threadID, text: "Implement the proposed plan.")
    }

    public func diff(threadID: String) async throws -> [DiffFile] {
        await state.diff(threadID: threadID)
    }

    public func diff(threadID: String, fromTurn: Int, toTurn: Int) async throws -> [DiffFile] {
        await state.diff(threadID: threadID, fromTurn: fromTurn, toTurn: toTurn)
    }

    public func checkpoints(threadID: String) async throws -> [Checkpoint] {
        await state.checkpoints(threadID: threadID)
    }

    public func restoreCheckpoint(threadID: String, turnCount: Int) async throws {
        await state.restoreCheckpoint(threadID: threadID, turnCount: turnCount)
    }

    public func addProject(path: String) async throws -> Project {
        await state.addProject(path: path)
    }

    public func renameProject(id: String, name: String) async throws {
        await state.renameProject(id: id, name: name)
    }

    public func deleteProject(id: String) async throws {
        await state.deleteProject(id: id)
    }
}

// MARK: - Actor-isolated mutable state + demo data

private actor MockState {
    private let seedVariant: String?
    private let primaryThreadID: String

    private var eventContinuation: AsyncStream<BackendEvent>.Continuation?

    private var projectsByID: [String: Project] = [:]
    private var threadsByID: [String: ChatThread] = [:]
    private var timelinesByThread: [String: [TimelineItem]] = [:]
    private var diffsByThread: [String: [DiffFile]] = [:]
    /// Scoped turn-range diffs keyed by `"threadID:from:to"`.
    private var scopedDiffs: [String: [DiffFile]] = [:]
    private var checkpointsByThread: [String: [Checkpoint]] = [:]
    private var approvalsByID: [String: ApprovalRequest] = [:]
    private var providerList: [ProviderInstance] = []
    private var backgroundAgentsByThread: [String: Int] = [:]
    /// Task IDs stopped via `stopTask`, grouped by thread so deletion can prune them.
    private var cancelledTaskIDsByThread: [String: Set<String>] = [:]

    private struct StreamingKey: Hashable {
        let threadID: String
        let messageID: String
    }

    /// Owned streaming tasks keyed by the thread and assistant message they serve.
    private var streamingTasks: [StreamingKey: Task<Void, Never>] = [:]
    /// Ordered active message IDs let overlapping sends settle only after the
    /// final active turn completes.
    private var inFlightMessageIDsByThread: [String: [String]] = [:]
    private var currentTurnByThread: [String: String] = [:]

    private var started = false
    private var counter = 0
    private var lifecycleTask: Task<Void, Never>?
    private var connectionWobbleTask: Task<Void, Never>?

    init(seedVariant: String?) {
        let normalizedVariant = seedVariant?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.seedVariant = normalizedVariant?.isEmpty == false ? normalizedVariant : nil
        self.primaryThreadID = self.seedVariant.map {
            "\(Self.variantSlug($0))-thread-1"
        } ?? "thread-1"
        // `seed()` used to run as an instance method here, but Swift 6 forbids
        // calling actor-isolated instance methods from a synchronous actor
        // init (the actor isn't considered "isolated" yet at that point).
        // Moved the seed computation into a `nonisolated static` factory that
        // builds the same values without touching `self`, then assigned here.
        let seed = MockState.makeSeed(seedVariant: seedVariant)
        self.projectsByID = seed.projects
        self.threadsByID = seed.threads
        self.timelinesByThread = seed.timelines
        self.diffsByThread = seed.diffs
        self.scopedDiffs = seed.scopedDiffs
        self.checkpointsByThread = seed.checkpoints
        self.approvalsByID = seed.approvals
        self.providerList = seed.providers
        self.backgroundAgentsByThread = Dictionary(
            uniqueKeysWithValues: seed.threads.values.compactMap { thread in
                thread.backgroundAgentCount > 0 ? (thread.id, thread.backgroundAgentCount) : nil
            })
    }

    private func nextID(_ prefix: String) -> String {
        counter += 1
        return "\(prefix)-\(counter)"
    }

    // MARK: Lifecycle

    func events() -> AsyncStream<BackendEvent> {
        let (stream, continuation) = AsyncStream<BackendEvent>.makeStream()
        eventContinuation = continuation
        return stream
    }

    func stop() {
        started = false
        lifecycleTask?.cancel()
        lifecycleTask = nil
        connectionWobbleTask?.cancel()
        connectionWobbleTask = nil
        cancelStreamingTasks()
        eventContinuation = nil
    }

    func start() async {
        guard !started else { return }
        started = true
        emit(.connection(.launchingServer))
        try? await Task.sleep(nanoseconds: 250_000_000)
        emit(.connection(.connecting))
        try? await Task.sleep(nanoseconds: 250_000_000)
        emit(.connection(.ready))
        emit(.providersChanged(providerList))
        for thread in threadsByID.values {
            emit(.threadUpserted(thread))
        }
        for approval in approvalsByID.values {
            emit(.approvalRequested(approval))
        }
        emit(
            .contextWindowUpdated(
                threadID: primaryThreadID,
                status: ContextWindowStatus(usedTokens: 72_000, maxTokens: 200_000)))
        emit(
            .planProgressUpdated(
                threadID: primaryThreadID,
                progress: PlanProgress(
                    steps: [
                        PlanStep(id: 0, title: "Reproduce the scroll jump", status: .completed),
                        PlanStep(id: 1, title: "Pin sort to explicit reorder", status: .inProgress),
                        PlanStep(id: 2, title: "Verify with 200-thread seed", status: .pending),
                    ],
                    explanation: nil)))
        lifecycleTask = Task { await self.runSubagentLifecycleDemo() }
        if seedVariant != nil {
            connectionWobbleTask = Task { await self.runConnectionWobble() }
        }
    }

    private func emit(_ event: BackendEvent) {
        eventContinuation?.yield(event)
    }

    private func cancelStreamingTasks(for threadID: String? = nil) {
        let keys = streamingTasks.keys.filter { key in
            threadID == nil || key.threadID == threadID
        }
        for key in keys {
            streamingTasks[key]?.cancel()
            streamingTasks[key] = nil
        }

        if let threadID {
            inFlightMessageIDsByThread[threadID] = nil
            currentTurnByThread[threadID] = nil
        } else {
            inFlightMessageIDsByThread.removeAll()
            currentTurnByThread.removeAll()
        }
    }

    private func finishStreamingTask(_ key: StreamingKey, completed: Bool) {
        streamingTasks[key] = nil

        let wasCurrent = currentTurnByThread[key.threadID] == key.messageID
        var remaining = inFlightMessageIDsByThread[key.threadID] ?? []
        remaining.removeAll { $0 == key.messageID }
        if remaining.isEmpty {
            inFlightMessageIDsByThread[key.threadID] = nil
            if wasCurrent {
                currentTurnByThread[key.threadID] = nil
            }
        } else {
            inFlightMessageIDsByThread[key.threadID] = remaining
            if wasCurrent {
                currentTurnByThread[key.threadID] = remaining.last
            }
        }

        guard completed, wasCurrent, remaining.isEmpty else { return }
        guard var thread = threadsByID[key.threadID] else { return }
        if thread.status != .archived && thread.status != .error
            && thread.status != .waitingApproval
        {
            thread.status = idleStatus(for: key.threadID)
        }
        thread.backgroundAgentCount = backgroundAgentsByThread[key.threadID] ?? 0
        thread.updatedAt = Date()
        threadsByID[key.threadID] = thread
        emit(.threadUpserted(thread))
    }

    // MARK: Reads

    func projects() -> [Project] {
        Array(projectsByID.values).sorted { $0.name < $1.name }
    }

    func threads() -> [ChatThread] {
        Array(threadsByID.values)
    }

    func timeline(threadID: String) -> [TimelineItem] {
        timelinesByThread[threadID] ?? []
    }

    func providers() -> [ProviderInstance] {
        providerList
    }

    func diff(threadID: String) -> [DiffFile] {
        diffsByThread[threadID] ?? []
    }

    func diff(threadID: String, fromTurn: Int, toTurn: Int) -> [DiffFile] {
        // Mirror LiveBackend: invalid ranges have no diff.
        guard toTurn > 0, toTurn > fromTurn else { return [] }
        let key = "\(threadID):\(fromTurn):\(toTurn)"
        if let scoped = scopedDiffs[key] { return scoped }
        // Fallback: filter full diff by paths touched by the checkpoint at toTurn.
        let checkpoints = checkpointsByThread[threadID] ?? []
        guard let target = checkpoints.first(where: { $0.turnCount == toTurn }) else {
            return []
        }
        let paths = Set(target.files.map(\.path))
        // Tools-only checkpoints (no file edits) have no scoped diff — falling
        // back to the full thread diff would show unrelated changes.
        if paths.isEmpty { return [] }
        return (diffsByThread[threadID] ?? []).filter { paths.contains($0.path) }
    }

    func checkpoints(threadID: String) -> [Checkpoint] {
        checkpointsByThread[threadID] ?? []
    }

    // MARK: Commands

    func createThread(projectID: String, provider: ProviderKind, title: String?) -> ChatThread {
        let thread = ChatThread(
            id: nextID("thread"),
            projectID: projectID,
            title: title ?? "New \(provider.displayName) thread",
            provider: provider,
            status: .idle,
            updatedAt: Date()
        )
        threadsByID[thread.id] = thread
        timelinesByThread[thread.id] = []
        diffsByThread[thread.id] = []
        checkpointsByThread[thread.id] = []
        emit(.threadUpserted(thread))
        return thread
    }

    func archiveThread(id: String) {
        guard var thread = threadsByID[id] else { return }
        cancelStreamingTasks(for: id)
        thread.status = .archived
        thread.updatedAt = Date()
        threadsByID[id] = thread
        emit(.threadUpserted(thread))
    }

    func unarchiveThread(id: String) {
        guard var thread = threadsByID[id], thread.status == .archived else { return }
        thread.status = idleStatus(for: id)
        thread.backgroundAgentCount = backgroundAgentsByThread[id] ?? 0
        thread.updatedAt = Date()
        threadsByID[id] = thread
        emit(.threadUpserted(thread))
    }

    func deleteThread(id: String) {
        guard threadsByID.removeValue(forKey: id) != nil else { return }
        cancelStreamingTasks(for: id)
        cancelledTaskIDsByThread[id] = nil
        timelinesByThread[id] = nil
        backgroundAgentsByThread[id] = nil
        emit(.threadRemoved(id: id))
    }

    private(set) var settings = AppSettings(
        assistantStreaming: true, providerUpdateChecks: true, defaultEnvMode: .local,
        newWorktreesStartFromOrigin: false, addProjectBaseDirectory: "~/Documents/Dev")

    func updateSettings(_ new: AppSettings) -> AppSettings {
        settings = new
        return new
    }

    func searchWorkspace(query: String) -> [WorkspaceEntry] {
        let all = [
            WorkspaceEntry(path: "Sources/SergeCodeMac/Model/AppModel.swift", isDirectory: false),
            WorkspaceEntry(path: "Sources/SergeCodeMac/Model/LiveBackend.swift", isDirectory: false),
            WorkspaceEntry(path: "Sources/SergeCodeMac/UI/Chat", isDirectory: true),
            WorkspaceEntry(path: "Sources/T3Kit/T3Client.swift", isDirectory: false),
            WorkspaceEntry(path: "Tests/T3KitTests/T3KitTests.swift", isDirectory: false),
            WorkspaceEntry(path: "Package.swift", isDirectory: false),
        ]
        let lowered = query.lowercased()
        return lowered.isEmpty ? all : all.filter { $0.path.lowercased().contains(lowered) }
    }

    func sendMessage(threadID: String, text: String, attachments: [OutgoingAttachment] = []) async {
        guard var thread = threadsByID[threadID] else { return }

        let attachmentSuffix =
            attachments.isEmpty
            ? "" : "\n\n(\(attachments.count) attachment\(attachments.count == 1 ? "" : "s"))"
        let userItem = TimelineItem.userMessage(
            id: nextID("msg"), text: text + attachmentSuffix, at: Date())
        timelinesByThread[threadID, default: []].append(userItem)
        emit(.timelineAppended(threadID: threadID, item: userItem))

        thread.status = .running
        thread.backgroundAgentCount = backgroundAgentsByThread[threadID] ?? 0
        thread.updatedAt = Date()
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))

        let messageID = nextID("asst")
        let key = StreamingKey(threadID: threadID, messageID: messageID)
        let reply = MockState.canned(for: text)
        let isPerfStream = text.trimmingCharacters(in: .whitespacesAndNewlines) == "/perf-stream"
        let chunks = isPerfStream
            ? MockState.byteChunks(reply, size: 64)
            : MockState.chunk(reply, size: 24)

        // Seed the streaming message so the timeline has a placeholder before
        // the first delta lands.
        let placeholder = TimelineItem.assistantMessage(id: messageID, markdown: "", isStreaming: true, at: Date())
        timelinesByThread[threadID, default: []].append(placeholder)
        emit(.timelineAppended(threadID: threadID, item: placeholder))

        inFlightMessageIDsByThread[threadID, default: []].append(messageID)
        currentTurnByThread[threadID] = messageID
        let task = Task {
            await self.streamMessage(
                key: key, chunks: chunks, reply: reply, isPerfStream: isPerfStream)
        }
        streamingTasks[key] = task
        await task.value
    }

    private func streamMessage(
        key: StreamingKey, chunks: [String], reply: String, isPerfStream: Bool
    ) async {
        var completed = false
        defer { finishStreamingTask(key, completed: completed) }

        for chunk in chunks {
            guard !Task.isCancelled else { return }
            do {
                try await Task.sleep(
                    nanoseconds: isPerfStream ? 2_000_000 : 80_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            emit(.assistantDelta(threadID: key.threadID, messageID: key.messageID, delta: chunk))
        }

        guard !Task.isCancelled else { return }
        emit(.assistantCompleted(threadID: key.threadID, messageID: key.messageID, markdown: reply))
        completed = true
    }

    func cancelTurn(threadID: String) {
        guard var thread = threadsByID[threadID] else { return }
        thread.status = idleStatus(for: threadID)
        thread.backgroundAgentCount = backgroundAgentsByThread[threadID] ?? 0
        thread.updatedAt = Date()
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
        let notice = TimelineItem.notice(id: nextID("notice"), text: "Turn cancelled.", at: Date())
        timelinesByThread[threadID, default: []].append(notice)
        emit(.timelineAppended(threadID: threadID, item: notice))
    }

    func stopTask(threadID: String, taskId: String) throws {
        guard threadsByID[threadID] != nil else {
            throw MockBackendError.threadNotFound(threadID)
        }
        guard var timeline = timelinesByThread[threadID] else {
            throw MockBackendError.taskNotFound(threadID: threadID, taskId: taskId)
        }
        let now = Date()
        for index in timeline.indices {
            if case .subagentTask(var task) = timeline[index], task.taskId == taskId {
                cancelledTaskIDsByThread[threadID, default: []].insert(taskId)
                task.state = .stopped
                task.lastActivityAt = now
                task.duration = task.duration ?? now.timeIntervalSince(task.startedAt)
                task.latestProgress = task.latestProgress ?? "Stopped"
                let item = TimelineItem.subagentTask(task)
                timeline[index] = item
                timelinesByThread[threadID] = timeline
                emit(.timelineAppended(threadID: threadID, item: item))

                // Drop this agent from the active background count.
                let remaining = max(0, (backgroundAgentsByThread[threadID] ?? 0) - 1)
                backgroundAgentsByThread[threadID] = remaining > 0 ? remaining : nil
                if var thread = threadsByID[threadID] {
                    thread.backgroundAgentCount = remaining
                    if thread.status == .backgroundWork, remaining == 0 {
                        thread.status = .idle
                    }
                    thread.updatedAt = now
                    threadsByID[threadID] = thread
                    emit(.threadUpserted(thread))
                }
                return
            }
        }
        throw MockBackendError.taskNotFound(threadID: threadID, taskId: taskId)
    }

    // MARK: Probe injection (subagent-stability verification)

    /// Sets (or clears) server `session.health` stall state on a thread, as if
    /// a `session.health` activity had folded into its projection.
    func setThreadHealth(threadID: String, stalled: Bool) {
        guard var thread = threadsByID[threadID] else { return }
        let lastActivityAt = Date().addingTimeInterval(stalled ? -180 : 0)
        thread.health = ThreadHealth(
            stalled: stalled, lastActivityAt: lastActivityAt,
            stalledSince: stalled ? lastActivityAt : nil)
        thread.updatedAt = Date()
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
    }

    /// Spawns a running sibling-agent thread (`Agent: <name>`), optionally
    /// already stalled, mirroring an MCP `agent_spawn`.
    func createSiblingAgent(
        name: String, provider: ProviderKind, projectID: String, stalled: Bool
    ) -> ChatThread {
        let id = nextID("agent-thread")
        let lastActivityAt = Date().addingTimeInterval(stalled ? -240 : -5)
        let thread = ChatThread(
            id: id, projectID: projectID, title: "Agent: \(name)", provider: provider,
            status: .running, updatedAt: Date(),
            health: ThreadHealth(
                stalled: stalled, lastActivityAt: lastActivityAt,
                stalledSince: stalled ? lastActivityAt : nil))
        threadsByID[id] = thread
        timelinesByThread[id] = []
        emit(.threadUpserted(thread))
        return thread
    }

    /// Appends a `session.exited` transcript row carrying stderr, as if a
    /// provider CLI process had died.
    func appendSessionExit(threadID: String, summary: String, stderrTail: String) {
        let item = TimelineItem.sessionExit(
            id: nextID("exit"), summary: summary, stderrTail: stderrTail, at: Date())
        timelinesByThread[threadID, default: []].append(item)
        emit(.timelineAppended(threadID: threadID, item: item))
    }

    func models() -> [ModelOption] {
        let claudeEfforts = [
            EffortChoice(id: "low", label: "Low", isDefault: false),
            EffortChoice(id: "medium", label: "Medium", isDefault: false),
            EffortChoice(id: "high", label: "High", isDefault: true),
            EffortChoice(id: "max", label: "Max", isDefault: false),
        ]
        return [
            ModelOption(
                instanceID: "provider-claude", modelID: "claude-fable-5",
                displayName: "Fable 5", provider: .claude, isDefault: true,
                effortOptionID: "effort", effortChoices: claudeEfforts),
            ModelOption(
                instanceID: "provider-claude", modelID: "claude-opus-4-8",
                displayName: "Opus 4.8", provider: .claude, isDefault: false,
                effortOptionID: "effort", effortChoices: claudeEfforts),
            ModelOption(
                instanceID: "provider-claude-synthero", modelID: "claude-sonnet-5",
                displayName: "Sonnet 5", provider: .claudeSynthero, isDefault: true,
                effortOptionID: "effort", effortChoices: claudeEfforts),
            ModelOption(
                instanceID: "provider-codex", modelID: "gpt-5.2-codex",
                displayName: "GPT-5.2 Codex", provider: .codex, isDefault: true,
                effortOptionID: "reasoningEffort",
                effortChoices: [
                    EffortChoice(id: "low", label: "Low", isDefault: false),
                    EffortChoice(id: "medium", label: "Medium", isDefault: true),
                    EffortChoice(id: "high", label: "High", isDefault: false),
                    EffortChoice(id: "xhigh", label: "Extra High", isDefault: false),
                ],
                serviceTierOptionID: "serviceTier",
                serviceTierChoices: [
                    EffortChoice(id: "default", label: "Standard", isDefault: true),
                    EffortChoice(id: "priority", label: "Fast", isDefault: false),
                ]),
            ModelOption(
                instanceID: "provider-cursor", modelID: "composer-2",
                displayName: "Composer 2", provider: .cursor, isDefault: true),
            ModelOption(
                instanceID: "provider-grok", modelID: "grok-4.5",
                displayName: "Grok 4.5", provider: .grok, isDefault: true,
                effortOptionID: "reasoningEffort",
                effortChoices: [
                    EffortChoice(id: "low", label: "Low", isDefault: false),
                    EffortChoice(id: "medium", label: "Medium", isDefault: false),
                    EffortChoice(id: "high", label: "High", isDefault: true),
                ]),
            ModelOption(
                instanceID: "provider-fugu", modelID: "fugu",
                displayName: "Fugu", provider: .fugu, isDefault: true,
                effortOptionID: "reasoningEffort",
                effortChoices: [
                    EffortChoice(id: "high", label: "High", isDefault: true),
                    EffortChoice(id: "xhigh", label: "Extra High", isDefault: false),
                    EffortChoice(id: "max", label: "Max", isDefault: false),
                ]),
            ModelOption(
                instanceID: "provider-fugu", modelID: "fugu-ultra",
                displayName: "Fugu Ultra", provider: .fugu, isDefault: false,
                effortOptionID: "reasoningEffort",
                effortChoices: [
                    EffortChoice(id: "high", label: "High", isDefault: false),
                    EffortChoice(id: "xhigh", label: "Extra High", isDefault: true),
                    EffortChoice(id: "max", label: "Max", isDefault: false),
                ]),
        ]
    }

    func emitVcsStatus(
        threadID: String,
        branch: String = "feat/native-mac-app",
        prState: PullRequestState? = nil,
        reviewDecision: PullRequestReviewDecision? = nil,
        unresolvedReviewThreadCount: Int? = nil
    ) {
        let hasOpenPR = prState == .open || prState == .merged
        emit(
            .vcsStatusChanged(
                threadID: threadID,
                status: VcsStatus(
                    isRepo: true, branch: branch, isDefaultBranch: branch == "main",
                    changedFileCount: prState == .merged ? 0 : 3,
                    insertions: prState == .merged ? 0 : 120,
                    deletions: prState == .merged ? 0 : 14,
                    aheadCount: prState == .merged ? 0 : 2,
                    behindCount: 0, hasUpstream: true,
                    prNumber: hasOpenPR ? 1 : nil,
                    prTitle: hasOpenPR ? "Native mac app" : nil,
                    prURL: hasOpenPR ? "https://github.com/SergeSerb2/SergeCode/pull/1" : nil,
                    prState: prState,
                    reviewDecision: reviewDecision,
                    unresolvedReviewThreadCount: unresolvedReviewThreadCount)))
    }

    func respondToUserInput(id: String, answers: [String: [String]]) {
        emit(.userInputResolved(id: id))
        let summary = answers.values.flatMap { $0 }.joined(separator: ", ")
        let notice = TimelineItem.notice(
            id: nextID("notice"), text: "Answered: \(summary)", at: Date())
        timelinesByThread[primaryThreadID, default: []].append(notice)
        emit(.timelineAppended(threadID: primaryThreadID, item: notice))
    }

    func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) {
        guard var thread = threadsByID[threadID] else { return }
        thread.runtimeMode = mode
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
    }

    func setInteractionMode(threadID: String, mode: ThreadInteractionMode) {
        guard var thread = threadsByID[threadID] else { return }
        thread.interactionMode = mode
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
    }

    func setModel(threadID: String, model: ModelOption) {
        guard var thread = threadsByID[threadID] else { return }
        thread.modelInstanceID = model.instanceID
        thread.modelID = model.modelID
        thread.provider = model.provider
        thread.reasoningEffort = nil
        thread.serviceTier = nil
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
    }

    func setReasoningEffort(threadID: String, value: String) {
        guard var thread = threadsByID[threadID] else { return }
        thread.reasoningEffort = value
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
    }

    func setServiceTier(threadID: String, value: String) {
        guard var thread = threadsByID[threadID] else { return }
        thread.serviceTier = value
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
    }

    func respondToApproval(id: String, approve: Bool) {
        guard let approval = approvalsByID.removeValue(forKey: id) else { return }
        emit(.approvalResolved(id: id))

        guard var thread = threadsByID[approval.threadID] else { return }
        thread.status = approve ? .running : idleStatus(for: approval.threadID)
        thread.backgroundAgentCount = backgroundAgentsByThread[approval.threadID] ?? 0
        thread.updatedAt = Date()
        threadsByID[approval.threadID] = thread
        emit(.threadUpserted(thread))

        let follow = TimelineItem.toolEvent(
            id: nextID("tool"),
            name: approval.kind == .command ? "run_command" : "edit_file",
            detail: approve ? "Approved: \(approval.title)" : "Denied: \(approval.title)",
            kind: approval.kind == .command ? .command : .fileChange,
            status: approve ? .succeeded : .failed,
            at: Date(),
            output: approve && approval.kind == .command
                ? "Build complete!\nBuilding for debugging...\nBuild complete! (0.42s)"
                : nil,
            outputIsError: !approve
        )
        timelinesByThread[approval.threadID, default: []].append(follow)
        emit(.timelineAppended(threadID: approval.threadID, item: follow))

        if approve {
            emit(.diffInvalidated(threadID: approval.threadID))
        }
    }

    /// Rewinds mock state to `turnCount` and emits a full `timelineReset`,
    /// mirroring LiveBackend's `thread.reverted` handling: the timeline keeps
    /// only the first `turnCount` user turns, checkpoints beyond the turn
    /// disappear, and the full diff drops files only they touched.
    func restoreCheckpoint(threadID: String, turnCount: Int) {
        let checkpoints = checkpointsByThread[threadID] ?? []
        let checkpoint = checkpoints.first(where: { $0.turnCount == turnCount })
        let label = checkpoint?.label ?? "Turn \(turnCount)"

        // Rewind mock state before invalidating, so the refresh the
        // invalidation triggers reads post-restore data.
        let kept = checkpoints.filter { $0.turnCount <= turnCount }
        let keptPaths = Set(kept.flatMap { $0.files.map(\.path) })
        let removedPaths = Set(
            checkpoints.filter { $0.turnCount > turnCount }.flatMap { $0.files.map(\.path) }
        ).subtracting(keptPaths)
        checkpointsByThread[threadID] = kept
        if !removedPaths.isEmpty {
            diffsByThread[threadID] = (diffsByThread[threadID] ?? [])
                .filter { !removedPaths.contains($0.path) }
        }
        for key in scopedDiffs.keys where key.hasPrefix("\(threadID):") {
            if let toTurn = key.split(separator: ":").last.flatMap({ Int($0) }),
                toTurn > turnCount
            {
                scopedDiffs[key] = nil
            }
        }

        // Truncate the timeline and reset wholesale so AppModel replaces its
        // cache (same event shape LiveBackend uses for `thread.reverted`).
        let retained = Self.timelineRetaining(
            turnCount: turnCount, from: timelinesByThread[threadID] ?? [])
        timelinesByThread[threadID] = retained
        emit(.timelineReset(threadID: threadID, items: retained))

        let notice = TimelineItem.notice(
            id: nextID("notice"),
            text: "Restored checkpoint “\(label)”.",
            at: Date()
        )
        timelinesByThread[threadID, default: []].append(notice)
        emit(.timelineAppended(threadID: threadID, item: notice))
        emit(.diffInvalidated(threadID: threadID))
    }

    static func timelineRetaining(turnCount: Int, from items: [TimelineItem]) -> [TimelineItem] {
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

    func addProject(path: String) -> Project {
        let name = (path as NSString).lastPathComponent
        let project = Project(id: nextID("project"), name: name.isEmpty ? path : name, path: path)
        projectsByID[project.id] = project
        emit(.projectsChanged(projects()))
        return project
    }

    func renameProject(id: String, name: String) {
        guard var project = projectsByID[id] else { return }
        project.name = name
        projectsByID[id] = project
        emit(.projectsChanged(projects()))
    }

    func deleteProject(id: String) {
        guard projectsByID.removeValue(forKey: id) != nil else { return }
        emit(.projectsChanged(projects()))
        for (threadID, thread) in threadsByID where thread.projectID == id {
            threadsByID[threadID] = nil
            timelinesByThread[threadID] = nil
            diffsByThread[threadID] = nil
            checkpointsByThread[threadID] = nil
            backgroundAgentsByThread[threadID] = nil
            emit(.threadRemoved(id: threadID))
        }
    }

    private func runSubagentLifecycleDemo() async {
        let threadID = primaryThreadID
        updateSubagentDemo(
            threadID: threadID, state: .running, progress: "Using Read...", duration: nil,
            activeCount: 1)
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        guard !Task.isCancelled, started else { return }
        updateSubagentDemo(
            threadID: threadID, state: .running, progress: "Using Grep...", duration: nil,
            activeCount: 1)
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        guard !Task.isCancelled, started else { return }
        updateSubagentDemo(
            threadID: threadID, state: .completed,
            progress: "Found the status projection and timeline mapping points.",
            duration: 9, activeCount: 0)
    }

    private func runConnectionWobble() async {
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        guard !Task.isCancelled, started else { return }
        emit(.connection(.reconnecting(attempt: 1)))

        try? await Task.sleep(nanoseconds: 900_000_000)
        guard !Task.isCancelled, started else { return }
        emit(.connection(.ready))
    }

    private func updateSubagentDemo(
        threadID: String, state: SubagentTaskState, progress: String, duration: TimeInterval?,
        activeCount: Int
    ) {
        let demoTaskId = "mock-subagent-1"
        // Authoritative stop: cancelled tasks stay stopped even if the demo
        // lifecycle would otherwise revive them.
        if cancelledTaskIDsByThread[threadID]?.contains(demoTaskId) == true { return }
        guard var thread = threadsByID[threadID] else { return }
        backgroundAgentsByThread[threadID] = activeCount > 0 ? activeCount : nil
        thread.backgroundAgentCount = activeCount
        if thread.status != .running && thread.status != .waitingApproval && thread.status != .error
            && thread.status != .archived
        {
            thread.status = activeCount > 0 ? .backgroundWork : .idle
        }
        thread.updatedAt = Date()
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))

        // Fold onto the seeded task the way the live projection does: progress
        // accumulates, so the inner thread has a transcript to show. Replacing
        // the item wholesale would erase every earlier update.
        let now = Date()
        var task =
            existingSubagentTask(taskId: demoTaskId, threadID: threadID)
            ?? SubagentTaskItem(
                taskId: demoTaskId, taskType: "reviewer",
                description: "Audit subagent timeline and status handling",
                state: state, latestProgress: progress,
                startedAt: now.addingTimeInterval(-(duration ?? 2)), duration: duration)
        task.state = state
        task.latestProgress = progress
        task.lastActivityAt = now
        // Settle against the task's own start so the header duration agrees
        // with the progress offsets the inner thread prints.
        task.duration = duration == nil ? task.duration : now.timeIntervalSince(task.startedAt)
        if task.progressLog.last?.text != progress {
            task.progressLog.append(
                SubagentTaskProgressEntry(at: now, toolName: nil, text: progress))
        }
        let item = TimelineItem.subagentTask(task)
        timelinesByThread[threadID, default: []].upsertTimelineItem(item)
        emit(.timelineAppended(threadID: threadID, item: item))
    }

    private func existingSubagentTask(taskId: String, threadID: String) -> SubagentTaskItem? {
        for item in timelinesByThread[threadID] ?? [] {
            if case .subagentTask(let task) = item, task.taskId == taskId { return task }
        }
        return nil
    }

    private func idleStatus(for threadID: String) -> ThreadStatus {
        (backgroundAgentsByThread[threadID] ?? 0) > 0 ? .backgroundWork : .idle
    }

    // MARK: - Seed data

    /// Plain-data bundle returned by `makeSeed()`. Only exists so seeding can
    /// run as a `nonisolated static` factory (no access to actor-isolated
    /// `self`) and still be assigned to stored properties from within `init`.
    private struct Seed {
        var projects: [String: Project]
        var threads: [String: ChatThread]
        var timelines: [String: [TimelineItem]]
        var diffs: [String: [DiffFile]]
        var scopedDiffs: [String: [DiffFile]]
        var checkpoints: [String: [Checkpoint]]
        var approvals: [String: ApprovalRequest]
        var providers: [ProviderInstance]

        func applyingVariant(_ variant: String, slug: String) -> Seed {
            func projectID(_ id: String) -> String { "\(slug)-\(id)" }
            func threadID(_ id: String) -> String { "\(slug)-\(id)" }
            func scopedKey(_ key: String) -> String {
                guard let separator = key.firstIndex(of: ":") else {
                    return threadID(key)
                }
                return threadID(String(key[..<separator])) + String(key[separator...])
            }

            let displayVariant = variant
                .split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" })
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")

            let remappedProjects = Dictionary(uniqueKeysWithValues: projects.values.map { project in
                var remapped = project
                remapped.id = projectID(project.id)
                switch project.id {
                case "project-1":
                    remapped.name = "infra-tools"
                    remapped.path = "/Users/studio/infra-tools"
                case "project-2":
                    remapped.name = "studio-web"
                    remapped.path = "/Users/studio/studio-web"
                default:
                    remapped.name = "\(displayVariant) \(project.name)"
                }
                return (remapped.id, remapped)
            })

            let remappedThreads = Dictionary(uniqueKeysWithValues: threads.values.map { thread in
                var remapped = thread
                remapped.id = threadID(thread.id)
                remapped.projectID = projectID(thread.projectID)
                switch thread.id {
                case "thread-1": remapped.title = "Provision runners for \(displayVariant)"
                case "thread-2": remapped.title = "Audit remote build setup"
                case "thread-3": remapped.title = "Tune studio deployment dashboards"
                case "thread-4": remapped.title = "Investigate remote build error"
                case "thread-5": remapped.title = "Surface the Grok provider"
                case "thread-6": remapped.title = "Surface the Fugu provider"
                default: remapped.title = "\(displayVariant) \(thread.title)"
                }
                return (remapped.id, remapped)
            })

            func remapTimelineItem(_ item: TimelineItem) -> TimelineItem {
                switch item {
                case .approval(var request):
                    request.threadID = threadID(request.threadID)
                    return .approval(request)
                case .userInput(var request):
                    request.threadID = threadID(request.threadID)
                    return .userInput(request)
                case .usageLimit(var notice):
                    notice.threadID = threadID(notice.threadID)
                    return .usageLimit(notice)
                case .checkpoint(var checkpoint):
                    checkpoint.threadID = threadID(checkpoint.threadID)
                    return .checkpoint(checkpoint)
                case .plan(var plan):
                    plan.threadID = threadID(plan.threadID)
                    return .plan(plan)
                default:
                    return item
                }
            }

            let remappedTimelines = Dictionary(uniqueKeysWithValues: timelines.map { key, items in
                (threadID(key), items.map(remapTimelineItem))
            })
            let remappedDiffs = Dictionary(uniqueKeysWithValues: diffs.map { key, files in
                (threadID(key), files)
            })
            let remappedScopedDiffs = Dictionary(uniqueKeysWithValues: scopedDiffs.map { key, files in
                (scopedKey(key), files)
            })
            let remappedCheckpoints = Dictionary(uniqueKeysWithValues: checkpoints.map { key, values in
                (
                    threadID(key),
                    values.map { checkpoint in
                        var remapped = checkpoint
                        remapped.threadID = threadID(checkpoint.threadID)
                        return remapped
                    }
                )
            })
            let remappedApprovals = Dictionary(uniqueKeysWithValues: approvals.map { key, approval in
                var remapped = approval
                remapped.threadID = threadID(approval.threadID)
                return (key, remapped)
            })

            return Seed(
                projects: remappedProjects,
                threads: remappedThreads,
                timelines: remappedTimelines,
                diffs: remappedDiffs,
                scopedDiffs: remappedScopedDiffs,
                checkpoints: remappedCheckpoints,
                approvals: remappedApprovals,
                providers: providers
            )
        }
    }

    private static func makeSeed(seedVariant: String? = nil) -> Seed {
        let now = Date()

        var projectsByID: [String: Project] = [:]
        var threadsByID: [String: ChatThread] = [:]
        var timelinesByThread: [String: [TimelineItem]] = [:]
        var diffsByThread: [String: [DiffFile]] = [:]
        var scopedDiffs: [String: [DiffFile]] = [:]
        var checkpointsByThread: [String: [Checkpoint]] = [:]
        var approvalsByID: [String: ApprovalRequest] = [:]

        let projectA = Project(id: "project-1", name: "SergeCode", path: "/Users/serge/Documents/Dev/SergeCode")
        let projectB = Project(id: "project-2", name: "ios-companion", path: "/Users/serge/Documents/Dev/ios-companion")
        projectsByID[projectA.id] = projectA
        projectsByID[projectB.id] = projectB

        let providerList: [ProviderInstance] = [
            ProviderInstance(id: "provider-claude", kind: .claude, availability: .available, version: "1.4.2"),
            ProviderInstance(id: "provider-claude-synthero", kind: .claudeSynthero, availability: .authRequired, version: nil),
            ProviderInstance(id: "provider-codex", kind: .codex, availability: .available, version: "0.9.0"),
            ProviderInstance(id: "provider-cursor", kind: .cursor, availability: .authRequired, version: nil),
            ProviderInstance(id: "provider-grok", kind: .grok, availability: .available, version: "0.2.91"),
            ProviderInstance(id: "provider-fugu", kind: .fugu, availability: .available, version: "0.1.0"),
            ProviderInstance(id: "provider-opencode", kind: .opencode, availability: .missing, version: nil),
        ]

        let thread1 = ChatThread(
            id: "thread-1",
            projectID: projectA.id,
            title: "Fix sidebar scroll jank",
            provider: .claude,
            status: .backgroundWork,
            updatedAt: now.addingTimeInterval(-60),
            backgroundAgentCount: 1
        )
        let thread2 = ChatThread(
            id: "thread-2",
            projectID: projectA.id,
            title: "Wire up MockBackend",
            provider: .codex,
            status: .waitingApproval,
            updatedAt: now.addingTimeInterval(-300),
            modelInstanceID: "provider-codex",
            modelID: "gpt-5.2-codex"
        )
        let thread3 = ChatThread(
            id: "thread-3",
            projectID: projectB.id,
            title: "Rewrite pricing copy",
            provider: .cursor,
            status: .idle,
            updatedAt: now.addingTimeInterval(-3_600)
        )
        let thread4 = ChatThread(
            id: "thread-4",
            projectID: projectB.id,
            title: "Investigate build error",
            provider: .opencode,
            status: .error,
            updatedAt: now.addingTimeInterval(-7_200)
        )
        let thread5 = ChatThread(
            id: "thread-5",
            projectID: projectA.id,
            title: "Surface Grok provider",
            provider: .grok,
            status: .idle,
            updatedAt: now.addingTimeInterval(-10_800)
        )
        let thread6 = ChatThread(
            id: "thread-6",
            projectID: projectA.id,
            title: "Surface Fugu provider",
            provider: .fugu,
            status: .idle,
            updatedAt: now.addingTimeInterval(-14_400)
        )

        for thread in [thread1, thread2, thread3, thread4, thread5, thread6] {
            threadsByID[thread.id] = thread
        }

        timelinesByThread[thread1.id] = MockState.timelineForSidebarThread(at: now)
        timelinesByThread[thread2.id] = MockState.timelineForApprovalThread(at: now)
        timelinesByThread[thread3.id] = MockState.timelineForPricingThread(at: now)
        timelinesByThread[thread4.id] = MockState.timelineForErrorThread(at: now)

        let sidebarDiff = MockState.diffForSidebarThread()
        let longLineDiff = MockState.diffForLongLineFile()
        let pairedDiff = MockState.diffForPairedIntraline()
        // Full thread-1 diff: multi-file including long lines + paired changes.
        diffsByThread[thread1.id] = sidebarDiff + longLineDiff + pairedDiff
        diffsByThread[thread2.id] = MockState.diffForMockBackendThread()
        diffsByThread[thread3.id] = MockState.diffForPricingThread()
        diffsByThread[thread4.id] = MockState.diffForErrorThread()

        // Scoped subsets for turn-range review.
        scopedDiffs["\(thread1.id):0:1"] = Array(sidebarDiff.prefix(1))
        scopedDiffs["\(thread1.id):1:2"] = Array(sidebarDiff.dropFirst()) + longLineDiff
        scopedDiffs["\(thread1.id):2:3"] = pairedDiff
        scopedDiffs["\(thread2.id):0:1"] = MockState.diffForMockBackendThread()
        scopedDiffs["\(thread3.id):0:1"] = MockState.diffForPricingThread()

        checkpointsByThread[thread1.id] = [
            Checkpoint(
                id: "ckpt-1a", threadID: thread1.id, label: "Before scroll refactor",
                createdAt: now.addingTimeInterval(-600), turnCount: 1, status: .ready,
                files: [
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/Views/SidebarView.swift",
                        kind: "modified", additions: 2, deletions: 1),
                ],
                assistantMessageId: "t1-a1"),
            Checkpoint(
                id: "ckpt-1b", threadID: thread1.id, label: "After ScrollView fix",
                createdAt: now.addingTimeInterval(-120), turnCount: 2, status: .ready,
                files: [
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/Model/AppModel.swift",
                        kind: "modified", additions: 1, deletions: 0),
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/Support/Constants.swift",
                        kind: "modified", additions: 1, deletions: 1),
                ]),
            Checkpoint(
                id: "ckpt-1c", threadID: thread1.id, label: "Intraline polish",
                createdAt: now.addingTimeInterval(-30), turnCount: 3, status: .missing,
                files: [
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/UI/Theme/Colors.swift",
                        kind: "modified", additions: 1, deletions: 1),
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/UI/Shell/RootChrome.swift", kind: "added",
                        additions: 4, deletions: 0),
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/UI/Shell/SidebarChrome.swift", kind: "modified",
                        additions: 2, deletions: 1),
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/UI/Chat/BubbleStyle.swift", kind: "modified",
                        additions: 1, deletions: 1),
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/UI/Composer/DraftStore.swift", kind: "modified",
                        additions: 3, deletions: 2),
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/Model/Entities.swift", kind: "modified",
                        additions: 5, deletions: 1),
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/Model/ThreadState.swift", kind: "modified",
                        additions: 2, deletions: 0),
                ]),
            // Empty files + matching assistantMessageId → "Ran N tools" caption in ChangesTimelineView.
            Checkpoint(
                id: "ckpt-1d", threadID: thread1.id, label: "Turn 4",
                createdAt: now.addingTimeInterval(-10), turnCount: 4, status: .ready,
                files: [],
                assistantMessageId: "t1-a3"),
        ]
        checkpointsByThread[thread2.id] = [
            Checkpoint(
                id: "ckpt-2a", threadID: thread2.id, label: "Initial MockBackend skeleton",
                createdAt: now.addingTimeInterval(-900), turnCount: 1, status: .ready,
                files: [
                    CheckpointFile(
                        path: "Sources/SergeCodeMac/Model/MockBackend.swift",
                        kind: "added", additions: 5, deletions: 0),
                ]),
        ]
        checkpointsByThread[thread3.id] = [
            Checkpoint(
                id: "ckpt-3a", threadID: thread3.id, label: "First pricing draft",
                createdAt: now.addingTimeInterval(-4_000), turnCount: 1, status: .error,
                files: [
                    CheckpointFile(
                        path: "src/pages/pricing.tsx", kind: "modified", additions: 1, deletions: 1),
                ]),
        ]
        checkpointsByThread[thread4.id] = []

        let approval = ApprovalRequest(
            id: "approval-1",
            threadID: thread2.id,
            kind: .command,
            title: "Run swift build --package-path apps/mac",
            detail: "Codex wants to run a build to confirm MockBackend compiles before continuing.",
            createdAt: now.addingTimeInterval(-30)
        )
        approvalsByID[approval.id] = approval

        let seed = Seed(
            projects: projectsByID,
            threads: threadsByID,
            timelines: timelinesByThread,
            diffs: diffsByThread,
            scopedDiffs: scopedDiffs,
            checkpoints: checkpointsByThread,
            approvals: approvalsByID,
            providers: providerList
        )

        guard let seedVariant, !seedVariant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return seed
        }
        return seed.applyingVariant(seedVariant, slug: variantSlug(seedVariant))
    }

    private static func variantSlug(_ value: String) -> String {
        let slug = value
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return slug.isEmpty ? "variant" : slug
    }

    private static func timelineForSidebarThread(at now: Date) -> [TimelineItem] {
        [
            // Keep one early fixture item on yesterday's calendar day so the
            // UI probe visibly exercises the transcript day separator.
            .userMessage(id: "t1-u1", text: "The sidebar list jumps around when new threads arrive. Can you fix it?", at: now.addingTimeInterval(-26 * 3600)),
            .assistantMessage(
                id: "t1-a1",
                markdown: """
                Looked at `Sources/SergeCodeMac/Views/SidebarView.swift:24`. The \
                list re-sorts on every `threadUpserted` \
                event, which causes the scroll offset to jump. I'll pin the sort to \
                only run when the thread list actually changes order.

                ```swift
                threads.sort { $0.updatedAt > $1.updatedAt }
                ```

                I'll wrap this in an `if needsResort` check.
                """,
                isStreaming: false,
                at: now.addingTimeInterval(-480)
            ),
            .subagentTask(
                SubagentTaskItem(
                    taskId: "mock-subagent-1", taskType: "reviewer",
                    description: "Audit subagent timeline and status handling",
                    subagentType: "Explore", model: "claude-sonnet-5",
                    state: .running, latestProgress: "Reading SubagentTaskAggregator...",
                    lastToolName: "read_file",
                    startedAt: now.addingTimeInterval(-460),
                    lastActivityAt: now.addingTimeInterval(-20), duration: nil,
                    progressLog: [
                        SubagentTaskProgressEntry(
                            at: now.addingTimeInterval(-455), toolName: nil,
                            text: "Starting delegated review..."),
                        SubagentTaskProgressEntry(
                            at: now.addingTimeInterval(-300), toolName: "grep",
                            text: "Collecting subagent task call sites"),
                        SubagentTaskProgressEntry(
                            at: now.addingTimeInterval(-20), toolName: "read_file",
                            text: "Reading SubagentTaskAggregator..."),
                    ])),
            .subagentTask(
                SubagentTaskItem(
                    taskId: "mock-subagent-2", taskType: "general-purpose",
                    description: "Summarize scroll-jump reports",
                    subagentType: "Explore", model: "claude-haiku-4-5",
                    state: .completed,
                    latestProgress:
                        "Three reports share one cause: the thread list re-sorts on every "
                        + "threadUpserted event, so the scroll offset jumps mid-render.",
                    lastToolName: "grep", usageSummary: "18420 tokens · 6 tools",
                    startedAt: now.addingTimeInterval(-430),
                    lastActivityAt: now.addingTimeInterval(-360), duration: 70,
                    progressLog: [
                        SubagentTaskProgressEntry(
                            at: now.addingTimeInterval(-425), toolName: "grep",
                            text: "Searching issue reports for scroll jumps"),
                        SubagentTaskProgressEntry(
                            at: now.addingTimeInterval(-360), toolName: nil,
                            text:
                                "Three reports share one cause: the thread list re-sorts on every "
                                + "threadUpserted event, so the scroll offset jumps mid-render."),
                    ])),
            .toolEvent(
                id: "t1-tool1", name: "read_file",
                detail: "Sources/SergeCodeMac/Views/SidebarView.swift", kind: .fileRead,
                status: .succeeded, at: now.addingTimeInterval(-470),
                output: "struct SidebarView: View {\n    var body: some View { … }\n}",
                outputIsError: false),
            .toolEvent(
                id: "t1-tool2", name: "edit_file",
                detail: """
                    Edit: {"file_path":"Sources/SergeCodeMac/Model/AppModel.swift","old_string":"threads.sort { $0.updatedAt > $1.updatedAt }\\nreturn threads","new_string":"if needsResort {\\n  threads.sort { $0.updatedAt > $1.updatedAt }\\n}\\nreturn threads"}
                    """,
                kind: .fileChange,
                status: .succeeded, at: now.addingTimeInterval(-200),
                output: nil, outputIsError: false),
            .checkpoint(
                Checkpoint(
                    id: "ckpt-1a", threadID: "thread-1", label: "Before scroll refactor",
                    createdAt: now.addingTimeInterval(-600), turnCount: 1)),
            .userMessage(id: "t1-u2", text: "Nice, that feels a lot smoother now.", at: now.addingTimeInterval(-90)),
            .plan(ProposedPlan(
                id: "t1-plan1",
                threadID: "thread-1",
                markdown: """
                ## Plan: stop the sidebar scroll jumping
                1. Pin the sort in `Sources/SergeCodeMac/Views/SidebarView.swift:24` \
                to run only on explicit reorder events.
                2. Keep scroll anchored to the selected row during upserts.
                """,
                isImplemented: false,
                createdAt: now.addingTimeInterval(-80)
            )),
            .userInput(UserInputRequest(
                id: "input-1",
                threadID: "thread-1",
                questions: [
                    UserInputQuestionItem(
                        id: "q1",
                        header: "Sort strategy",
                        question: "Should archived threads keep their position or sink to the bottom?",
                        options: [
                            UserInputOption(label: "Keep position", detail: "Least surprising while a thread is open"),
                            UserInputOption(label: "Sink to bottom", detail: "Keeps active work on top"),
                        ],
                        multiSelect: false),
                ],
                createdAt: now.addingTimeInterval(-40)
            )),
            // Read-only verify turn: tools only, no file edits → empty checkpoint files + "Ran N tools".
            .userMessage(
                id: "t1-u3",
                text: "Can you double-check the fix without editing anything?",
                at: now.addingTimeInterval(-20)),
            .toolEvent(
                id: "t1-tool10", name: "read_file",
                detail: "Sources/SergeCodeMac/Views/SidebarView.swift", kind: .fileRead,
                status: .succeeded, at: now.addingTimeInterval(-18),
                output: "if needsResort { threads.sort { $0.updatedAt > $1.updatedAt } }\n",
                outputIsError: false),
            .toolEvent(
                id: "t1-tool11", name: "grep",
                detail: "needsResort", kind: .fileRead,
                status: .succeeded, at: now.addingTimeInterval(-16),
                output: "Sources/SergeCodeMac/Views/SidebarView.swift:31: if needsResort {\n",
                outputIsError: false),
            .toolEvent(
                id: "t1-tool12", name: "read_file",
                detail: "Sources/SergeCodeMac/Model/AppModel.swift", kind: .fileRead,
                status: .succeeded, at: now.addingTimeInterval(-14),
                output: "func threadUpserted(_ thread: ChatThread) { … }\n",
                outputIsError: false),
            .assistantMessage(
                id: "t1-a3",
                markdown: """
                Verified without changes. The `needsResort` guard keeps scroll \
                stable on upserts, and nothing else looks off.
                """,
                isStreaming: false,
                at: now.addingTimeInterval(-12)
            ),
        ]
    }

    private static func timelineForApprovalThread(at now: Date) -> [TimelineItem] {
        [
            .userMessage(id: "t2-u1", text: "Build out MockBackend so we can develop the UI without the Node sidecar.", at: now.addingTimeInterval(-950)),
            .assistantMessage(
                id: "t2-a1",
                markdown: """
                Sketched `Sources/SergeCodeMac/Model/MockBackend.swift:12` with \
                seeded projects, threads, and a fake streaming reply. Before I \
                run the build to sanity-check it, I need your go-ahead since \
                this shells out.
                """,
                isStreaming: false,
                at: now.addingTimeInterval(-900)
            ),
            .toolEvent(
                id: "t2-tool1", name: "write_file",
                detail: "Sources/SergeCodeMac/Model/MockBackend.swift", kind: .fileChange,
                status: .succeeded, at: now.addingTimeInterval(-890),
                output: nil, outputIsError: false),
            .checkpoint(
                Checkpoint(
                    id: "ckpt-2a", threadID: "thread-2", label: "Initial MockBackend skeleton",
                    createdAt: now.addingTimeInterval(-900), turnCount: 1)),
            .approval(ApprovalRequest(
                id: "approval-1",
                threadID: "thread-2",
                kind: .command,
                title: "Run swift build --package-path apps/mac",
                detail: "Codex wants to run a build to confirm MockBackend compiles before continuing.",
                createdAt: now.addingTimeInterval(-30)
            )),
        ]
    }

    private static func timelineForPricingThread(at now: Date) -> [TimelineItem] {
        [
            .userMessage(id: "t3-u1", text: "Rewrite the pricing page copy to sound less salesy.", at: now.addingTimeInterval(-4_200)),
            .assistantMessage(
                id: "t3-a1",
                markdown: """
                Done — trimmed the adjectives and led each tier with what the \
                customer can actually do, not how "powerful" it is.
                """,
                isStreaming: false,
                at: now.addingTimeInterval(-4_100)
            ),
            .toolEvent(
                id: "t3-tool1", name: "edit_file", detail: "src/pages/pricing.tsx",
                kind: .fileChange, status: .succeeded, at: now.addingTimeInterval(-4_050),
                output: nil, outputIsError: false),
            .checkpoint(
                Checkpoint(
                    id: "ckpt-3a", threadID: "thread-3", label: "First pricing draft",
                    createdAt: now.addingTimeInterval(-4_000), turnCount: 1, status: .error)),
            .notice(id: "t3-n1", text: "Thread idle for 1 hour.", at: now.addingTimeInterval(-3_600)),
        ]
    }

    private static func timelineForErrorThread(at now: Date) -> [TimelineItem] {
        [
            .userMessage(id: "t4-u1", text: "The build is failing on CI, can you take a look?", at: now.addingTimeInterval(-7_500)),
            .toolEvent(
                id: "t4-tool1", name: "run_command", detail: "npm run build", kind: .command,
                status: .failed, at: now.addingTimeInterval(-7_400),
                output: """
                Error: Cannot find module '@t3tools/contracts'
                Require stack:
                - /workspace/apps/mac/Sources/SergeCodeMac/SergeCodeApp.swift
                npm ERR! code 1
                npm ERR! Exit status 1
                """,
                outputIsError: true),
            .assistantMessage(
                id: "t4-a1",
                markdown: """
                The build fails with `Cannot find module '@t3tools/contracts'`. \
                That package isn't declared as a workspace dependency in this \
                package's `package.json`. I hit an error trying to install it \
                directly, so I stopped rather than guess at the fix.
                """,
                isStreaming: false,
                at: now.addingTimeInterval(-7_350)
            ),
            .notice(id: "t4-n1", text: "OpenCode provider became unavailable mid-session.", at: now.addingTimeInterval(-7_200)),
        ]
    }

    private static func diffForSidebarThread() -> [DiffFile] {
        [
            DiffFile(
                path: "Sources/SergeCodeMac/Views/SidebarView.swift",
                status: .modified,
                hunks: [
                    DiffHunk(header: "@@ -40,7 +40,10 @@ struct SidebarView", lines: [
                        DiffLine(kind: .context, text: "        List(model.threads) { thread in", oldNumber: 40, newNumber: 40),
                        DiffLine(kind: .deletion, text: "            ThreadRow(thread: thread)", oldNumber: 41, newNumber: nil),
                        DiffLine(kind: .addition, text: "            ThreadRow(thread: thread)", oldNumber: nil, newNumber: 41),
                        DiffLine(kind: .addition, text: "                .id(thread.id)", oldNumber: nil, newNumber: 42),
                        DiffLine(kind: .context, text: "        }", oldNumber: 42, newNumber: 43),
                    ]),
                ]
            ),
            DiffFile(
                path: "Sources/SergeCodeMac/Model/AppModel.swift",
                status: .modified,
                hunks: [
                    DiffHunk(header: "@@ -63,7 +63,9 @@ private func apply", lines: [
                        DiffLine(kind: .context, text: "            if let index = threads.firstIndex(where: { $0.id == thread.id }) {", oldNumber: 63, newNumber: 63),
                        DiffLine(kind: .context, text: "                threads[index] = thread", oldNumber: 64, newNumber: 64),
                        DiffLine(kind: .addition, text: "                threads.sort { $0.updatedAt > $1.updatedAt }", oldNumber: nil, newNumber: 65),
                        DiffLine(kind: .context, text: "            } else {", oldNumber: 65, newNumber: 66),
                    ]),
                ]
            ),
        ]
    }

    /// Very long lines to exercise soft-wrap in review mode.
    private static func diffForLongLineFile() -> [DiffFile] {
        let longOld =
            "    let message = \"This is an intentionally very long string constant that used to force horizontal scrolling in the narrow inspector and should now soft-wrap at word boundaries with a hanging indent past the gutter in the full-width review mode without ever breaking mid-word.\""
        let longNew =
            "    let message = \"This is an intentionally very long string constant that soft-wraps at word boundaries with a hanging indent past the gutter in full-width review mode, never breaking mid-word, and never requiring horizontal panning.\""
        return [
            DiffFile(
                path: "Sources/SergeCodeMac/Support/Constants.swift",
                status: .modified,
                hunks: [
                    DiffHunk(header: "@@ -1,5 +1,5 @@", lines: [
                        DiffLine(kind: .context, text: "enum Constants {", oldNumber: 1, newNumber: 1),
                        DiffLine(kind: .deletion, text: longOld, oldNumber: 2, newNumber: nil),
                        DiffLine(kind: .addition, text: longNew, oldNumber: nil, newNumber: 2),
                        DiffLine(kind: .context, text: "}", oldNumber: 3, newNumber: 3),
                    ]),
                ]
            ),
        ]
    }

    /// Paired deletion/addition for intraline highlight exercise.
    private static func diffForPairedIntraline() -> [DiffFile] {
        [
            DiffFile(
                path: "Sources/SergeCodeMac/UI/Theme/Colors.swift",
                status: .modified,
                hunks: [
                    DiffHunk(header: "@@ -10,7 +10,7 @@ enum Colors", lines: [
                        DiffLine(kind: .context, text: "    static let accent = Color.blue", oldNumber: 10, newNumber: 10),
                        DiffLine(kind: .deletion, text: "    static let danger = Color.red", oldNumber: 11, newNumber: nil),
                        DiffLine(kind: .addition, text: "    static let danger = Color.orange", oldNumber: nil, newNumber: 11),
                        DiffLine(kind: .context, text: "    static let muted = Color.gray", oldNumber: 12, newNumber: 12),
                    ]),
                ]
            ),
        ]
    }

    private static func diffForMockBackendThread() -> [DiffFile] {
        [
            DiffFile(
                path: "Sources/SergeCodeMac/Model/MockBackend.swift",
                status: .added,
                hunks: [
                    DiffHunk(header: "@@ -0,0 +1,12 @@", lines: [
                        DiffLine(kind: .addition, text: "import Foundation", oldNumber: nil, newNumber: 1),
                        DiffLine(kind: .addition, text: "", oldNumber: nil, newNumber: 2),
                        DiffLine(kind: .addition, text: "public final class MockBackend: BackendService {", oldNumber: nil, newNumber: 3),
                        DiffLine(kind: .addition, text: "    // seeded demo state lives here", oldNumber: nil, newNumber: 4),
                        DiffLine(kind: .addition, text: "}", oldNumber: nil, newNumber: 5),
                    ]),
                ]
            ),
        ]
    }

    private static func diffForPricingThread() -> [DiffFile] {
        [
            DiffFile(
                path: "src/pages/pricing.tsx",
                status: .modified,
                hunks: [
                    DiffHunk(header: "@@ -12,8 +12,8 @@ export function PricingPage", lines: [
                        DiffLine(kind: .context, text: "      <h2>Pro</h2>", oldNumber: 12, newNumber: 12),
                        DiffLine(kind: .deletion, text: "      <p>Unlock the full power of our platform.</p>", oldNumber: 13, newNumber: nil),
                        DiffLine(kind: .addition, text: "      <p>Run unlimited projects and invite your whole team.</p>", oldNumber: nil, newNumber: 13),
                        DiffLine(kind: .context, text: "      <Price amount={29} />", oldNumber: 14, newNumber: 14),
                    ]),
                ]
            ),
        ]
    }

    private static func diffForErrorThread() -> [DiffFile] {
        [
            DiffFile(
                path: "package.json",
                status: .modified,
                hunks: [
                    DiffHunk(header: "@@ -8,6 +8,7 @@", lines: [
                        DiffLine(kind: .context, text: "  \"dependencies\": {", oldNumber: 8, newNumber: 8),
                        DiffLine(kind: .context, text: "    \"react\": \"^18.3.0\",", oldNumber: 9, newNumber: 9),
                        DiffLine(kind: .deletion, text: "    \"react-dom\": \"^18.3.0\"", oldNumber: 10, newNumber: nil),
                        DiffLine(kind: .addition, text: "    \"react-dom\": \"^18.3.0\",", oldNumber: nil, newNumber: 10),
                        DiffLine(kind: .addition, text: "    \"@t3tools/contracts\": \"workspace:*\"", oldNumber: nil, newNumber: 11),
                        DiffLine(kind: .context, text: "  },", oldNumber: 11, newNumber: 12),
                    ]),
                ]
            ),
        ]
    }

    private static let perfStreamMarkdown = makePerfStreamMarkdown()

    private static func canned(for text: String) -> String {
        if text.trimmingCharacters(in: .whitespacesAndNewlines) == "/perf-stream" {
            return perfStreamMarkdown
        }
        return """
        Got it — working on “\(text)”.

        Here's a quick summary of what I'll do:
        1. Inspect the relevant files.
        2. Make a small, focused change.
        3. Report back with a diff.

        ```swift
        // example
        func handle() {
            print("done")
        }
        ```

        Let me know if you'd like a different approach.
        """
    }

    private static func makePerfStreamMarkdown() -> String {
        var document = String()
        document.reserveCapacity(150_000)

        for section in 1...300 {
            document += "## Section \(section)\n\n"
            document +=
                "Section \(section) covers `section-\(section)` with **bold emphasis** and [a stable link](https://example.com/perf/\(section)). This deterministic prose exercises wrapping, caching, and incremental updates.\n\n"
            document +=
                "The stream keeps **incremental output** realistic, revisits `markdown.parse`, and follows [the repeatable fixture](https://example.com/perf/fixture). It preserves stable ordering on every run.\n\n"

            if section == 150 {
                document += "| Metric | Value | Notes |\n| --- | ---: | --- |\n| sections | 300 | deterministic |\n| stream chunk | 64 bytes | 2 ms cadence |\n\n"
            }

            if section.isMultiple(of: 6) {
                document += "```swift\n"
                for line in 1...25 {
                    document += "let section\(section)Value\(line) = \(section * line)\n"
                }
                document += "```\n\n"
            }
        }

        return document
    }

    private static func chunk(_ text: String, size: Int) -> [String] {
        var result: [String] = []
        var current = text.startIndex
        while current < text.endIndex {
            let end = text.index(current, offsetBy: size, limitedBy: text.endIndex) ?? text.endIndex
            result.append(String(text[current..<end]))
            current = end
        }
        return result
    }

    private static func byteChunks(_ text: String, size: Int) -> [String] {
        let bytes = Array(text.utf8)
        var result: [String] = []
        result.reserveCapacity((bytes.count + size - 1) / size)
        var start = 0
        while start < bytes.count {
            let end = min(start + size, bytes.count)
            result.append(String(decoding: bytes[start..<end], as: UTF8.self))
            start = end
        }
        return result
    }
}

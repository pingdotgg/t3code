import Foundation
import Observation

@Observable
@MainActor
public final class AppModel {
    public private(set) var connection: ConnectionPhase = .launchingServer
    public private(set) var projects: [Project] = []
    public private(set) var threads: [ChatThread] = []
    public private(set) var timelines: [String: [TimelineItem]] = [:]
    public private(set) var providers: [ProviderInstance] = []
    public private(set) var diffs: [String: [DiffFile]] = [:]
    public private(set) var checkpoints: [String: [Checkpoint]] = [:]
    public private(set) var models: [ModelOption] = []
    public private(set) var contextWindows: [String: ContextWindowStatus] = [:]
    public private(set) var planProgress: [String: PlanProgress] = [:]
    /// Keyed by threadID (a worktree thread's status is its worktree's).
    public private(set) var vcsStatuses: [String: VcsStatus] = [:]
    /// Outcome of the most recent git action, shown as a transient banner.
    public var lastGitActionOutcome: GitActionOutcome?

    public var selectedThreadID: String?
    public var lastError: String?

    /// In-app dictation (mic → local ASR → on-device cleanup → composer).
    public let dictation = DictationController()

    /// Text staged for the composer by a timeline action (Edit on a sent
    /// message). The composer consumes it via `takeComposerPrefill`. A fresh
    /// UUID per staging makes repeat edits of the same text observable.
    public private(set) var composerPrefill: ComposerPrefill?

    /// In-memory outgoing queue, scoped by thread. Items are lost on app restart.
    public private(set) var queuedMessagesByThread: [String: [QueuedOutgoingMessage]] = [:]

    public struct ComposerPrefill: Equatable, Sendable {
        public let id: UUID
        public let text: String
    }

    private let backend: any BackendService
    private var eventTask: Task<Void, Never>?
    private var queuedSendInFlightThreadIDs: Set<String> = []
    private var queuedRetryTokensByThread: [String: UUID] = [:]

    private let maxQueuedSendAttempts = 3
    private let queuedSendRetryDelay: UInt64 = 2_000_000_000

    public init(backend: any BackendService) {
        self.backend = backend
    }

    public var selectedThread: ChatThread? {
        threads.first { $0.id == selectedThreadID }
    }

    public func selectedTimeline() -> [TimelineItem] {
        selectedThreadID.flatMap { timelines[$0] } ?? []
    }

    public var selectedQueuedMessages: [QueuedOutgoingMessage] {
        selectedThreadID.flatMap { queuedMessagesByThread[$0] } ?? []
    }

    // MARK: - Lifecycle

    public func start() {
        guard eventTask == nil else { return }
        let stream = backend.events
        let backend = backend
        eventTask = Task { [weak self] in
            async let _ = backend.start()
            for await event in stream {
                self?.apply(event)
            }
        }
    }

    public func shutdown() async {
        eventTask?.cancel()
        eventTask = nil
        await backend.stop()
    }

    private func apply(_ event: BackendEvent) {
        switch event {
        case .connection(let phase):
            connection = phase
            if phase == .ready {
                Task { await refreshAll() }
            }
        case .projectsChanged(let list):
            projects = list
        case .threadUpserted(let thread):
            // Update in place: `updatedAt` bumps on every activity while a
            // thread runs, so resorting here made sidebar rows jump around
            // mid-conversation. Order is recomputed only on refreshAll.
            let previousStatus: ThreadStatus?
            if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                previousStatus = threads[index].status
                threads[index] = thread
            } else {
                previousStatus = nil
                // New rows still slot in by the sidebar's sort key: snapshot
                // replays after a reconnect arrive as upserts, and blind
                // insertion at 0 would show them in reverse snapshot order.
                let index = threads.firstIndex { $0.updatedAt < thread.updatedAt } ?? threads.count
                threads.insert(thread, at: index)
            }
            if shouldSendQueuedMessage(previousStatus: previousStatus, newStatus: thread.status) {
                dequeueNextQueuedMessageIfNeeded(threadID: thread.id)
            }
        case .threadRemoved(let id):
            threads.removeAll { $0.id == id }
            vcsStatuses[id] = nil
            queuedMessagesByThread[id] = nil
            queuedSendInFlightThreadIDs.remove(id)
            queuedRetryTokensByThread[id] = nil
            if selectedThreadID == id { selectedThreadID = nil }
        case .timelineAppended(let threadID, let item):
            // Upsert: lifecycle updates arrive with the stable row id of an
            // earlier item (tool call updated -> completed, streaming
            // reasoning text) and must replace it, not stack.
            timelines[threadID, default: []].upsertTimelineItem(item)
        case .timelineReset(let threadID, let items):
            timelines[threadID] = items
        case .assistantDelta(let threadID, let messageID, let delta):
            appendDelta(threadID: threadID, messageID: messageID, delta: delta)
        case .assistantCompleted(let threadID, let messageID, let markdown):
            finishStreaming(threadID: threadID, messageID: messageID, markdown: markdown)
        case .approvalRequested, .userInputRequested:
            break
        case .approvalResolved(let id), .userInputResolved(let id):
            for threadID in timelines.keys {
                if let index = timelines[threadID]?.firstIndex(where: { $0.id == id }) {
                    timelines[threadID]?.remove(at: index)
                    break
                }
            }
        case .diffInvalidated(let threadID):
            // Diff invalidation always coincides with a checkpoint change
            // (new checkpoint completed, or a revert pruned some), so refresh
            // both — an open Checkpoints inspector stays current.
            Task {
                await refreshDiff(threadID: threadID)
                await refreshCheckpoints(threadID: threadID)
            }
        case .providersChanged(let list):
            providers = list
            Task { await refreshModels() }
        case .contextWindowUpdated(let threadID, let status):
            contextWindows[threadID] = status
        case .planProgressUpdated(let threadID, let progress):
            planProgress[threadID] = progress
        case .vcsStatusChanged(let threadID, let status):
            vcsStatuses[threadID] = status
        }
    }

    private func appendDelta(threadID: String, messageID: String, delta: String) {
        var items = timelines[threadID] ?? []
        for (index, item) in items.enumerated() {
            if case .assistantMessage(let id, let markdown, _, let at) = item, id == messageID {
                items[index] = .assistantMessage(id: id, markdown: markdown + delta, isStreaming: true, at: at)
                timelines[threadID] = items
                return
            }
        }
        items.append(.assistantMessage(id: messageID, markdown: delta, isStreaming: true, at: Date()))
        timelines[threadID] = items
    }

    private func finishStreaming(threadID: String, messageID: String, markdown: String) {
        guard var items = timelines[threadID] else { return }
        for (index, item) in items.enumerated() {
            if case .assistantMessage(let id, _, _, let at) = item, id == messageID {
                items[index] = .assistantMessage(id: id, markdown: markdown, isStreaming: false, at: at)
                timelines[threadID] = items
                return
            }
        }
    }

    // MARK: - Queries

    public func refreshAll() async {
        do {
            async let projects = backend.projects()
            async let threads = backend.threads()
            async let providers = backend.providers()
            async let models = backend.models()
            let previousStatuses = Dictionary(uniqueKeysWithValues: self.threads.map { ($0.id, $0.status) })
            let refreshedThreads = try await threads.sorted { $0.updatedAt > $1.updatedAt }
            self.projects = try await projects
            self.threads = refreshedThreads
            self.providers = try await providers
            self.models = try await models
            for thread in refreshedThreads
            where shouldSendQueuedMessage(
                previousStatus: previousStatuses[thread.id], newStatus: thread.status)
            {
                dequeueNextQueuedMessageIfNeeded(threadID: thread.id)
            }
        } catch {
            lastError = String(describing: error)
        }
    }

    public func refreshModels() async {
        do {
            models = try await backend.models()
        } catch {
            lastError = String(describing: error)
        }
    }

    public func loadTimelineIfNeeded(threadID: String) async {
        guard timelines[threadID] == nil else { return }
        do {
            timelines[threadID] = try await backend.timeline(threadID: threadID)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func refreshDiff(threadID: String) async {
        do {
            diffs[threadID] = try await backend.diff(threadID: threadID)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func refreshCheckpoints(threadID: String) async {
        do {
            checkpoints[threadID] = try await backend.checkpoints(threadID: threadID)
        } catch {
            lastError = String(describing: error)
        }
    }

    // MARK: - Commands

    /// Stages `text` for the composer (Edit action on a sent message).
    public func stageComposerText(_ text: String) {
        composerPrefill = ComposerPrefill(id: UUID(), text: text)
    }

    /// Marks the staged prefill consumed. Returns it, or nil if already taken.
    public func takeComposerPrefill() -> ComposerPrefill? {
        defer { composerPrefill = nil }
        return composerPrefill
    }

    public func enqueueMessage(text: String, attachments: [OutgoingAttachment] = []) {
        guard let threadID = selectedThreadID else { return }
        enqueueMessage(threadID: threadID, text: text, attachments: attachments)
    }

    @discardableResult
    public func takeQueuedMessage(id: String, from threadID: String) -> QueuedOutgoingMessage? {
        guard var queue = queuedMessagesByThread[threadID],
            let index = queue.firstIndex(where: { $0.id == id })
        else { return nil }
        let message = queue.remove(at: index)
        setQueuedMessages(queue, for: threadID)
        return message
    }

    public func removeQueuedMessage(id: String, from threadID: String) {
        _ = takeQueuedMessage(id: id, from: threadID)
    }

    public func sendQueuedMessageNow(id: String, from threadID: String) async {
        guard let message = takeQueuedMessage(id: id, from: threadID) else { return }
        await sendQueuedMessage(message, threadID: threadID)
    }

    public func send(text: String, attachments: [OutgoingAttachment] = []) async {
        guard let threadID = selectedThreadID else { return }
        await sendAndReport(threadID: threadID, text: text, attachments: attachments)
    }

    private func enqueueMessage(
        threadID: String, text: String, attachments: [OutgoingAttachment]
    ) {
        guard !(text.isEmpty && attachments.isEmpty) else { return }
        let message = QueuedOutgoingMessage(text: text, attachments: attachments)
        queuedMessagesByThread[threadID, default: []].append(message)
    }

    private func shouldSendQueuedMessage(
        previousStatus: ThreadStatus?, newStatus: ThreadStatus
    ) -> Bool {
        guard let previousStatus else { return false }
        return previousStatus != .idle && newStatus == .idle
    }

    private func dequeueNextQueuedMessageIfNeeded(
        threadID: String, expectedMessageID: String? = nil
    ) {
        guard !queuedSendInFlightThreadIDs.contains(threadID) else { return }
        guard threadStatus(for: threadID) == .idle else { return }
        if let expectedMessageID, queuedMessagesByThread[threadID]?.first?.id != expectedMessageID {
            return
        }
        queuedRetryTokensByThread[threadID] = nil
        guard let message = takeFirstQueuedMessage(from: threadID) else { return }
        queuedSendInFlightThreadIDs.insert(threadID)
        Task { await sendQueuedMessage(message, threadID: threadID, tracksDequeue: true) }
    }

    private func takeFirstQueuedMessage(from threadID: String) -> QueuedOutgoingMessage? {
        guard var queue = queuedMessagesByThread[threadID], !queue.isEmpty else { return nil }
        let message = queue.removeFirst()
        setQueuedMessages(queue, for: threadID)
        return message
    }

    private func sendQueuedMessage(
        _ message: QueuedOutgoingMessage, threadID: String, tracksDequeue: Bool = false
    ) async {
        var failedMessage: QueuedOutgoingMessage?
        do {
            try await sendMessage(
                threadID: threadID, text: message.text, attachments: message.attachments)
        } catch {
            var message = message
            message.sendAttempts += 1
            failedMessage = message
            requeue(message, atFrontOf: threadID)
            lastError = String(describing: error)
        }
        if tracksDequeue {
            queuedSendInFlightThreadIDs.remove(threadID)
        }
        if let failedMessage {
            scheduleQueuedSendRetryIfNeeded(failedMessage, threadID: threadID)
        }
    }

    private func sendAndReport(
        threadID: String, text: String, attachments: [OutgoingAttachment]
    ) async {
        do {
            try await sendMessage(threadID: threadID, text: text, attachments: attachments)
        } catch {
            lastError = String(describing: error)
        }
    }

    private func sendMessage(
        threadID: String, text: String, attachments: [OutgoingAttachment]
    ) async throws {
        guard !(text.isEmpty && attachments.isEmpty) else { return }
        try await backend.sendMessage(threadID: threadID, text: text, attachments: attachments)
    }

    private func threadStatus(for threadID: String) -> ThreadStatus? {
        threads.first { $0.id == threadID }?.status
    }

    private func scheduleQueuedSendRetryIfNeeded(
        _ message: QueuedOutgoingMessage, threadID: String
    ) {
        guard message.sendAttempts < maxQueuedSendAttempts else { return }
        guard threadStatus(for: threadID) == .idle else { return }
        guard queuedMessagesByThread[threadID]?.first?.id == message.id else { return }
        guard queuedRetryTokensByThread[threadID] == nil else { return }

        let token = UUID()
        let retryDelay = queuedSendRetryDelay
        queuedRetryTokensByThread[threadID] = token
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: retryDelay)
            await self?.dequeueScheduledQueuedMessage(
                threadID: threadID, expectedMessageID: message.id, token: token)
        }
    }

    private func dequeueScheduledQueuedMessage(
        threadID: String, expectedMessageID: String, token: UUID
    ) {
        guard queuedRetryTokensByThread[threadID] == token else { return }
        queuedRetryTokensByThread[threadID] = nil
        dequeueNextQueuedMessageIfNeeded(threadID: threadID, expectedMessageID: expectedMessageID)
    }

    private func requeue(_ message: QueuedOutgoingMessage, atFrontOf threadID: String) {
        queuedMessagesByThread[threadID, default: []].insert(message, at: 0)
    }

    private func setQueuedMessages(_ messages: [QueuedOutgoingMessage], for threadID: String) {
        if messages.isEmpty {
            queuedMessagesByThread[threadID] = nil
        } else {
            queuedMessagesByThread[threadID] = messages
        }
    }

    public func searchWorkspace(query: String) async -> [WorkspaceEntry] {
        guard let threadID = selectedThreadID else { return [] }
        do {
            return try await backend.searchWorkspace(threadID: threadID, query: query)
        } catch {
            // Mention search is best-effort UI sugar; a transient failure
            // should not surface as a banner error.
            return []
        }
    }

    /// Slash commands for the selected thread's provider instance.
    public var selectedThreadSlashCommands: [SlashCommandInfo] {
        guard let thread = selectedThread else { return [] }
        if let instanceID = thread.modelInstanceID,
            let instance = providers.first(where: { $0.id == instanceID })
        {
            return instance.slashCommands
        }
        return providers.first { $0.kind == thread.provider }?.slashCommands ?? []
    }

    @discardableResult
    public func createThread(
        projectID: String, provider: ProviderKind, title: String? = nil
    ) async -> ChatThread? {
        do {
            let thread = try await backend.createThread(
                projectID: projectID, provider: provider, title: title)
            selectedThreadID = thread.id
            return thread
        } catch {
            lastError = String(describing: error)
            return nil
        }
    }

    public func respond(to approval: ApprovalRequest, approve: Bool) async {
        do {
            try await backend.respondToApproval(id: approval.id, approve: approve)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func respond(to request: UserInputRequest, answers: [String: [String]]) async {
        do {
            try await backend.respondToUserInput(id: request.id, answers: answers)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func setRuntimeMode(_ mode: ThreadRuntimeMode) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setRuntimeMode(threadID: threadID, mode: mode)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func setInteractionMode(_ mode: ThreadInteractionMode) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setInteractionMode(threadID: threadID, mode: mode)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func setModel(_ model: ModelOption) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setModel(threadID: threadID, model: model)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func setReasoningEffort(_ value: String) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setReasoningEffort(threadID: threadID, value: value)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func implementPlan(_ plan: ProposedPlan) async {
        do {
            try await backend.implementPlan(threadID: plan.threadID, planID: plan.id)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func cancelCurrentTurn() async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.cancelTurn(threadID: threadID)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func restoreCheckpoint(_ checkpoint: Checkpoint) async {
        do {
            try await backend.restoreCheckpoint(id: checkpoint.id)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func addProject(path: String) async {
        do {
            _ = try await backend.addProject(path: path)
            await refreshAll()
        } catch {
            lastError = String(describing: error)
        }
    }

    /// Every session of a project, archived included — the delete cascade
    /// removes archived threads too, so the confirmation must count them.
    public func sessionCount(for project: Project) -> Int {
        threads.count { $0.projectID == project.id }
    }

    public func renameProject(_ project: Project, to name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != project.name else { return }
        do {
            try await backend.renameProject(id: project.id, name: trimmed)
            // Backends emit .projectsChanged too; update in place so the
            // sidebar reflects the rename even before that lands.
            if let index = projects.firstIndex(where: { $0.id == project.id }) {
                projects[index].name = trimmed
            }
        } catch {
            lastError = String(describing: error)
        }
    }

    /// Deletes the project and every session in it.
    public func deleteProject(_ project: Project) async {
        do {
            try await backend.deleteProject(id: project.id)
            if selectedThread?.projectID == project.id {
                selectedThreadID = nil
            }
            threads.removeAll { $0.projectID == project.id }
            projects.removeAll { $0.id == project.id }
        } catch {
            lastError = String(describing: error)
        }
    }

    // MARK: - Mobile pairing (Settings ▸ iPhone)

    public func isServerLanReachable() async -> Bool {
        await backend.isServerLanReachable()
    }

    /// Throws so the settings tab can render the failure inline rather than
    /// routing through the global `lastError` banner.
    public func mintMobilePairing() async throws -> MobilePairingInfo {
        try await backend.mintMobilePairing()
    }

    // MARK: - Settings / providers / archive

    public private(set) var settings: AppSettings?

    public func loadSettings() async {
        do {
            settings = try await backend.settings()
        } catch {
            lastError = String(describing: error)
        }
    }

    public func saveSettings(_ new: AppSettings) async {
        do {
            settings = try await backend.updateSettings(new)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func refreshProviders() async {
        do {
            try await backend.refreshProviders()
        } catch {
            lastError = String(describing: error)
        }
    }

    public func updateProvider(instanceID: String) async {
        do {
            try await backend.updateProvider(instanceID: instanceID)
        } catch {
            lastError = String(describing: error)
        }
    }

    // MARK: - Workspace files

    public func listWorkspace(subpath: String) async -> [WorkspaceEntry] {
        guard let threadID = selectedThreadID else { return [] }
        do {
            return try await backend.listWorkspace(threadID: threadID, subpath: subpath)
        } catch {
            lastError = String(describing: error)
            return []
        }
    }

    public func readWorkspaceFile(path: String) async -> FilePreview? {
        guard let threadID = selectedThreadID else { return nil }
        do {
            return try await backend.readWorkspaceFile(threadID: threadID, path: path)
        } catch {
            lastError = String(describing: error)
            return nil
        }
    }

    public func openInEditor(subpath: String?, editor: ExternalEditor) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.openInEditor(threadID: threadID, subpath: subpath, editor: editor)
        } catch {
            lastError = String(describing: error)
        }
    }

    // MARK: - Git / VCS

    public func selectedVcsStatus() -> VcsStatus? {
        guard let threadID = selectedThreadID else { return nil }
        return vcsStatuses[threadID]
    }

    public func watchVcsStatus() async {
        guard let threadID = selectedThreadID else { return }
        try? await backend.watchVcsStatus(threadID: threadID)
    }

    public func listBranches(query: String?) async -> [BranchRef] {
        guard let threadID = selectedThreadID else { return [] }
        do {
            return try await backend.listBranches(threadID: threadID, query: query)
        } catch {
            lastError = String(describing: error)
            return []
        }
    }

    public func switchBranch(_ name: String) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.switchBranch(threadID: threadID, name: name)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func createBranch(_ name: String) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.createBranch(threadID: threadID, name: name)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func pull() async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.pull(threadID: threadID)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func runGitAction(_ action: GitAction, commitMessage: String?) async {
        guard let threadID = selectedThreadID else { return }
        do {
            lastGitActionOutcome = try await backend.runGitAction(
                threadID: threadID, action: action, commitMessage: commitMessage)
        } catch {
            lastGitActionOutcome = GitActionOutcome(
                success: false, title: "Git action failed", detail: String(describing: error))
        }
    }

    public var archivedThreads: [ChatThread] {
        threads.filter { $0.status == .archived }
    }

    public func archiveThread(_ thread: ChatThread) async {
        do {
            try await backend.archiveThread(id: thread.id)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func unarchiveThread(_ thread: ChatThread) async {
        do {
            try await backend.unarchiveThread(id: thread.id)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func deleteThread(_ thread: ChatThread) async {
        do {
            try await backend.deleteThread(id: thread.id)
        } catch {
            lastError = String(describing: error)
        }
    }
}

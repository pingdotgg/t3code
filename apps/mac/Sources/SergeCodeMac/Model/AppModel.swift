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

    public var selectedThreadID: String?
    public var lastError: String?

    private let backend: any BackendService
    private var eventTask: Task<Void, Never>?

    public init(backend: any BackendService) {
        self.backend = backend
    }

    public var selectedThread: ChatThread? {
        threads.first { $0.id == selectedThreadID }
    }

    public func selectedTimeline() -> [TimelineItem] {
        selectedThreadID.flatMap { timelines[$0] } ?? []
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
        case .threadUpserted(let thread):
            if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                threads[index] = thread
            } else {
                threads.append(thread)
            }
            threads.sort { $0.updatedAt > $1.updatedAt }
        case .threadRemoved(let id):
            threads.removeAll { $0.id == id }
            if selectedThreadID == id { selectedThreadID = nil }
        case .timelineAppended(let threadID, let item):
            timelines[threadID, default: []].append(item)
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
            Task { await refreshDiff(threadID: threadID) }
        case .providersChanged(let list):
            providers = list
            Task { await refreshModels() }
        case .contextWindowUpdated(let threadID, let status):
            contextWindows[threadID] = status
        case .planProgressUpdated(let threadID, let progress):
            planProgress[threadID] = progress
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
            self.projects = try await projects
            self.threads = try await threads.sorted { $0.updatedAt > $1.updatedAt }
            self.providers = try await providers
            self.models = try await models
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

    public func send(text: String, attachments: [OutgoingAttachment] = []) async {
        guard let threadID = selectedThreadID, !(text.isEmpty && attachments.isEmpty) else { return }
        do {
            try await backend.sendMessage(threadID: threadID, text: text, attachments: attachments)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func searchWorkspace(query: String) async -> [WorkspaceEntry] {
        guard let projectID = selectedThread?.projectID else { return [] }
        do {
            return try await backend.searchWorkspace(projectID: projectID, query: query)
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

    public func createThread(projectID: String, provider: ProviderKind) async {
        do {
            let thread = try await backend.createThread(projectID: projectID, provider: provider)
            selectedThreadID = thread.id
        } catch {
            lastError = String(describing: error)
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

import Foundation
import Observation

@Observable
@MainActor
public final class AppModel {
    public private(set) var connection: ConnectionPhase = .launchingServer
    public private(set) var projects: [Project] = []
    public private(set) var threads: [ChatThread] = []
    public private(set) var timelines: [String: [TimelineItem]] = [:]
    public private(set) var pendingApprovals: [ApprovalRequest] = []
    public private(set) var providers: [ProviderInstance] = []
    public private(set) var diffs: [String: [DiffFile]] = [:]
    public private(set) var checkpoints: [String: [Checkpoint]] = [:]

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

    public func approvals(for threadID: String) -> [ApprovalRequest] {
        pendingApprovals.filter { $0.threadID == threadID }
    }

    // MARK: - Lifecycle

    public func start() {
        guard eventTask == nil else { return }
        let stream = backend.events
        eventTask = Task { [weak self] in
            await self?.backend.start()
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
        case .assistantDelta(let threadID, let messageID, let delta):
            appendDelta(threadID: threadID, messageID: messageID, delta: delta)
        case .assistantCompleted(let threadID, let messageID):
            finishStreaming(threadID: threadID, messageID: messageID)
        case .approvalRequested(let request):
            pendingApprovals.append(request)
        case .approvalResolved(let id):
            pendingApprovals.removeAll { $0.id == id }
        case .diffInvalidated(let threadID):
            Task { await refreshDiff(threadID: threadID) }
        case .providersChanged(let list):
            providers = list
        }
    }

    private func appendDelta(threadID: String, messageID: String, delta: String) {
        guard var items = timelines[threadID] else { return }
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

    private func finishStreaming(threadID: String, messageID: String) {
        guard var items = timelines[threadID] else { return }
        for (index, item) in items.enumerated() {
            if case .assistantMessage(let id, let markdown, _, let at) = item, id == messageID {
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
            self.projects = try await projects
            self.threads = try await threads.sorted { $0.updatedAt > $1.updatedAt }
            self.providers = try await providers
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

    public func send(text: String) async {
        guard let threadID = selectedThreadID, !text.isEmpty else { return }
        do {
            try await backend.sendMessage(threadID: threadID, text: text)
        } catch {
            lastError = String(describing: error)
        }
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
}

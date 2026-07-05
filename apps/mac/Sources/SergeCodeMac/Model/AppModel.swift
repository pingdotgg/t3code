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

    private let backend: any BackendService
    private var eventTask: Task<Void, Never>?

    // MARK: - Event intake buffers
    //
    // Streaming backends emit one event per wire chunk. Applying each one
    // individually made every token of every thread a separate @Observable
    // mutation — and, because `timelines` and friends are single stored
    // properties, a separate invalidation of every view reading them. Events
    // are buffered and applied as one transaction per ~33ms tick instead:
    // one property write per touched thread per flush.

    /// Bounds pending-buffer growth under bursts: past this, flush now.
    static let maxPendingEvents = 256

    @ObservationIgnored private var pendingEvents: [BackendEvent] = []
    @ObservationIgnored private var flushScheduled = false
    /// threadID → (messageID, index) of the actively streaming assistant
    /// message, so per-token appends skip the O(n) timeline scan. Entries
    /// are validated against the array before use — a stale index costs one
    /// rescan, never a wrong write.
    @ObservationIgnored private var streamingIndex: [String: (messageID: String, index: Int)] = [:]
    /// Approval/user-input request id → threadID, so resolving one is a
    /// keyed removal instead of a scan across every thread's timeline.
    @ObservationIgnored private var interactionThreadByID: [String: String] = [:]

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
                self?.enqueue(event)
            }
        }
    }

    public func shutdown() async {
        flushPendingEvents()
        eventTask?.cancel()
        eventTask = nil
        await backend.stop()
    }

    // MARK: - Event intake

    /// Internal (not private) so the batch reducer is unit-testable.
    func enqueue(_ event: BackendEvent) {
        pendingEvents.append(event)
        // Connection changes flush immediately: reconnect UX must be
        // instant, and the `.ready → refreshAll()` path must not trail the
        // events buffered behind it.
        if case .connection = event {
            flushPendingEvents()
            return
        }
        if pendingEvents.count >= Self.maxPendingEvents {
            flushPendingEvents()
            return
        }
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard !flushScheduled else { return }
        flushScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(33))
            self?.flushPendingEvents()
        }
    }

    func flushPendingEvents() {
        flushScheduled = false
        guard !pendingEvents.isEmpty else { return }
        let events = pendingEvents
        pendingEvents.removeAll(keepingCapacity: true)
        applyBatch(events)
    }

    /// Applies a batch in arrival order, but stages timeline mutations in a
    /// scratch dictionary so each touched thread gets exactly one
    /// `timelines[threadID] = …` write per flush (one observation
    /// invalidation), no matter how many events landed for it.
    private func applyBatch(_ events: [BackendEvent]) {
        var touched: [String: [TimelineItem]] = [:]

        func currentItems(_ threadID: String) -> [TimelineItem] {
            touched[threadID] ?? timelines[threadID] ?? []
        }

        // A run of deltas for the same message collapses to one string
        // concatenation and one array write.
        var deltaThreadID: String?
        var deltaMessageID = ""
        var deltaText = ""
        func flushPendingDelta() {
            guard let threadID = deltaThreadID else { return }
            var items = currentItems(threadID)
            applyDelta(threadID: threadID, messageID: deltaMessageID, delta: deltaText, items: &items)
            touched[threadID] = items
            deltaThreadID = nil
            deltaText = ""
        }

        func resolveInteraction(_ id: String) {
            func removeItem(threadID: String) -> Bool {
                var items = currentItems(threadID)
                guard let index = items.firstIndex(where: { $0.id == id }) else { return false }
                items.remove(at: index)
                touched[threadID] = items
                // Removal shifts indices; the streaming index self-validates,
                // but drop it so the next delta rescans instead of racing.
                streamingIndex[threadID] = nil
                return true
            }

            if let threadID = interactionThreadByID.removeValue(forKey: id),
                removeItem(threadID: threadID)
            {
                return
            }
            // Fallback for items that predate the map (e.g. from a snapshot
            // loaded via loadTimelineIfNeeded rather than an event).
            for threadID in Set(timelines.keys).union(touched.keys) {
                if removeItem(threadID: threadID) {
                    return
                }
            }
        }

        for event in events {
            if case .assistantDelta(let threadID, let messageID, let delta) = event {
                if deltaThreadID == threadID, deltaMessageID == messageID {
                    deltaText += delta
                } else {
                    flushPendingDelta()
                    deltaThreadID = threadID
                    deltaMessageID = messageID
                    deltaText = delta
                }
                continue
            }
            flushPendingDelta()

            switch event {
            case .timelineAppended(let threadID, let item):
                // Upsert: lifecycle updates arrive with the stable row id of
                // an earlier item (tool call updated -> completed, streaming
                // reasoning text) and must replace it, not stack.
                var items = currentItems(threadID)
                items.upsertTimelineItem(item)
                touched[threadID] = items
                recordInteraction(item, threadID: threadID)
            case .timelineReset(let threadID, let items):
                touched[threadID] = items
                streamingIndex[threadID] = nil
                for item in items { recordInteraction(item, threadID: threadID) }
            case .assistantCompleted(let threadID, let messageID, let markdown):
                var items = currentItems(threadID)
                finishStreaming(
                    threadID: threadID, messageID: messageID, markdown: markdown, items: &items)
                touched[threadID] = items
            case .approvalResolved(let id), .userInputResolved(let id):
                resolveInteraction(id)
            default:
                applyNonTimeline(event)
            }
        }
        flushPendingDelta()

        for (threadID, items) in touched {
            timelines[threadID] = items
        }
    }

    private func applyNonTimeline(_ event: BackendEvent) {
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
            if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                threads[index] = thread
            } else {
                // New rows still slot in by the sidebar's sort key: snapshot
                // replays after a reconnect arrive as upserts, and blind
                // insertion at 0 would show them in reverse snapshot order.
                let index = threads.firstIndex { $0.updatedAt < thread.updatedAt } ?? threads.count
                threads.insert(thread, at: index)
            }
        case .threadRemoved(let id):
            threads.removeAll { $0.id == id }
            vcsStatuses[id] = nil
            if selectedThreadID == id { selectedThreadID = nil }
        case .approvalRequested, .userInputRequested:
            break
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
        case .timelineAppended, .timelineReset, .assistantDelta, .assistantCompleted,
            .approvalResolved, .userInputResolved:
            // Timeline events are staged by applyBatch; never reach here.
            assertionFailure("timeline event routed past the batch reducer")
        }
    }

    private func recordInteraction(_ item: TimelineItem, threadID: String) {
        switch item {
        case .approval(let request):
            interactionThreadByID[request.id] = threadID
        case .userInput(let request):
            interactionThreadByID[request.id] = threadID
        default:
            break
        }
    }

    private func applyDelta(
        threadID: String, messageID: String, delta: String, items: inout [TimelineItem]
    ) {
        if let cached = streamingIndex[threadID], cached.messageID == messageID,
            items.indices.contains(cached.index),
            case .assistantMessage(let id, let markdown, _, let at) = items[cached.index],
            id == messageID
        {
            items[cached.index] = .assistantMessage(
                id: id, markdown: markdown + delta, isStreaming: true, at: at)
            return
        }
        for (index, item) in items.enumerated() {
            if case .assistantMessage(let id, let markdown, _, let at) = item, id == messageID {
                items[index] = .assistantMessage(
                    id: id, markdown: markdown + delta, isStreaming: true, at: at)
                streamingIndex[threadID] = (messageID, index)
                return
            }
        }
        items.append(.assistantMessage(id: messageID, markdown: delta, isStreaming: true, at: Date()))
        streamingIndex[threadID] = (messageID, items.count - 1)
    }

    private func finishStreaming(
        threadID: String, messageID: String, markdown: String, items: inout [TimelineItem]
    ) {
        defer {
            if streamingIndex[threadID]?.messageID == messageID {
                streamingIndex[threadID] = nil
            }
        }
        if let cached = streamingIndex[threadID], cached.messageID == messageID,
            items.indices.contains(cached.index),
            case .assistantMessage(let id, _, _, let at) = items[cached.index], id == messageID
        {
            items[cached.index] = .assistantMessage(
                id: id, markdown: markdown, isStreaming: false, at: at)
            return
        }
        for (index, item) in items.enumerated() {
            if case .assistantMessage(let id, _, _, let at) = item, id == messageID {
                items[index] = .assistantMessage(
                    id: id, markdown: markdown, isStreaming: false, at: at)
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

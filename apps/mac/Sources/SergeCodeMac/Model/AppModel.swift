import Foundation
import Observation

@Observable
@MainActor
public final class AppModel {
    public private(set) var connection: ConnectionPhase = .launchingServer
    public private(set) var projects: [Project] = []
    public private(set) var threads: [ChatThread] = []
    public private(set) var providers: [ProviderInstance] = []
    public private(set) var models: [ModelOption] = []
    /// Low-frequency usage-limit card actions — stays flat on AppModel (not ThreadState).
    public private(set) var usageLimitActions: [String: UsageLimitActionState] = [:]
    /// Outcome of the most recent git action, shown as a transient banner.
    public var lastGitActionOutcome: GitActionOutcome?

    /// Selected thread. Updates the recent-selection LRU and prunes excess
    /// timeline subscriptions (selected + 3 most recently selected others).
    public var selectedThreadID: String? {
        didSet {
            guard let id = selectedThreadID else { return }
            recentlySelected.removeAll { $0 == id }
            recentlySelected.insert(id, at: 0)
            pruneTimelineSubscriptions()
        }
    }
    public var lastError: String?

    /// Per-thread `@Observable` children. The dictionary itself only mutates
    /// on first-touch create and `threadRemoved` — rare — so streaming a
    /// token on thread B never dirties views bound to thread A's child.
    private var threadStates: [String: ThreadState] = [:]

    /// MRU order of selected thread IDs (front = most recent / current).
    /// Drives timeline subscription eviction; ignored by Observation.
    @ObservationIgnored private var recentlySelected: [String] = []

    /// Keep the selected thread plus this many other recently selected ones
    /// subscribed. Beyond that, `closeTimeline` drops the live subscription.
    static let timelineSubscriptionKeepCount = 4

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
    private var usageLimitResumeTasks: [String: Task<Void, Never>] = [:]
    private var dismissedUsageLimitIDs: Set<String> = []

    private static let usageLimitContinuationPrompt =
        "Continue the interrupted task from where you stopped."

    private var queuedSendInFlightThreadIDs: Set<String> = []
    private var queuedRetryTokensByThread: [String: UUID] = [:]

    private let maxQueuedSendAttempts = 3
    private let queuedSendRetryDelay: UInt64 = 2_000_000_000

    // MARK: - Event intake buffers
    //
    // Streaming backends emit one event per wire chunk. Applying each one
    // individually made every token a separate @Observable mutation on the
    // touched thread's `ThreadState`. Events are buffered and applied as one
    // transaction per ~33ms tick instead: one property write per touched
    // thread per flush.

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
    /// Fresh `updatedAt` when a threadUpserted differs only by timestamp —
    /// the sidebar array is left alone so rows don't jump, but new-thread
    /// insertion still sorts against the real latest activity time.
    @ObservationIgnored private var effectiveUpdatedAt: [String: Date] = [:]

    public init(backend: any BackendService) {
        self.backend = backend
    }

    /// Lookup only — does not create a `ThreadState`.
    public func threadState(_ threadID: String) -> ThreadState? {
        threadStates[threadID]
    }

    /// Get-or-create. Inserting a new entry is the only write to
    /// `threadStates` outside of `threadRemoved`.
    private func state(creating threadID: String) -> ThreadState {
        if let existing = threadStates[threadID] {
            return existing
        }
        let created = ThreadState()
        threadStates[threadID] = created
        return created
    }

    /// Version of the stored timeline for `threadID` (0 if never written).
    public func timelineVersion(threadID: String) -> Int {
        threadStates[threadID]?.timelineVersion ?? 0
    }

    public var selectedThread: ChatThread? {
        threads.first { $0.id == selectedThreadID }
    }

    public func selectedTimeline() -> [TimelineItem] {
        selectedThreadID.flatMap { threadStates[$0]?.timeline } ?? []
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
    /// `ThreadState.timeline = …` write per flush (one observation
    /// invalidation on that child only), no matter how many events landed
    /// for it.
    private func applyBatch(_ events: [BackendEvent]) {
        var touched: [String: [TimelineItem]] = [:]

        func currentItems(_ threadID: String) -> [TimelineItem] {
            touched[threadID] ?? threadStates[threadID]?.timeline ?? []
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
            for threadID in Set(threadStates.keys).union(touched.keys) {
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
                guard !isDismissedUsageLimit(item) else { break }
                // Upsert: lifecycle updates arrive with the stable row id of
                // an earlier item (tool call updated -> completed, streaming
                // reasoning text) and must replace it, not stack.
                var items = currentItems(threadID)
                items.upsertTimelineItem(item)
                touched[threadID] = items
                recordInteraction(item, threadID: threadID)
            case .timelineReset(let threadID, let items):
                let filtered = items.filter { !isDismissedUsageLimit($0) }
                touched[threadID] = filtered
                streamingIndex[threadID] = nil
                for item in filtered { recordInteraction(item, threadID: threadID) }
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
            let state = self.state(creating: threadID)
            state.timeline = items
            state.timelineVersion += 1
            state.hasLoadedTimeline = true
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
            // When only `updatedAt` changed, skip the array write entirely —
            // rewriting threads[index] invalidates every sidebar row — and
            // stash the fresh timestamp for insertion-position searches.
            let previousStatus: ThreadStatus?
            if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                previousStatus = threads[index].status
                let existing = threads[index]
                if existing.displayEquivalent(to: thread) {
                    effectiveUpdatedAt[thread.id] = thread.updatedAt
                } else {
                    threads[index] = thread
                    effectiveUpdatedAt[thread.id] = nil
                }
            } else {
                previousStatus = nil
                // New rows still slot in by the sidebar's sort key: snapshot
                // replays after a reconnect arrive as upserts, and blind
                // insertion at 0 would show them in reverse snapshot order.
                let incomingAt = thread.updatedAt
                let index = threads.firstIndex {
                    let existingAt = effectiveUpdatedAt[$0.id] ?? $0.updatedAt
                    return existingAt < incomingAt
                } ?? threads.count
                threads.insert(thread, at: index)
                effectiveUpdatedAt[thread.id] = nil
            }
            if shouldSendQueuedMessage(previousStatus: previousStatus, newStatus: thread.status) {
                dequeueNextQueuedMessageIfNeeded(threadID: thread.id)
            }
        case .threadRemoved(let id):
            threads.removeAll { $0.id == id }
            threadStates[id] = nil
            effectiveUpdatedAt[id] = nil
            recentlySelected.removeAll { $0 == id }
            cancelUsageLimitResumeTasks(threadID: id)
            queuedMessagesByThread[id] = nil
            queuedSendInFlightThreadIDs.remove(id)
            queuedRetryTokensByThread[id] = nil
            TimelineDisplayCache.evict(threadID: id)
            if selectedThreadID == id { selectedThreadID = nil }
        case .approvalRequested, .userInputRequested:
            break
        case .diffInvalidated(let threadID):
            // Diff invalidation always coincides with a checkpoint change
            // (new checkpoint completed, or a revert pruned some), so refresh
            // both — and reload review mode if it's open for this thread.
            Task {
                await refreshDiff(threadID: threadID)
                await refreshCheckpoints(threadID: threadID)
                if threadState(threadID)?.isReviewing == true {
                    await loadReviewDiff(threadID: threadID)
                }
            }
        case .providersChanged(let list):
            providers = list
            Task { await refreshModels() }
        case .contextWindowUpdated(let threadID, let status):
            state(creating: threadID).contextWindow = status
        case .planProgressUpdated(let threadID, let progress):
            state(creating: threadID).planProgress = progress
        case .vcsStatusChanged(let threadID, let status):
            state(creating: threadID).vcsStatus = status
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

    private func isDismissedUsageLimit(_ item: TimelineItem) -> Bool {
        guard case .usageLimit(let notice) = item else { return false }
        return dismissedUsageLimitIDs.contains(notice.id)
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
            let previousStatuses = Dictionary(uniqueKeysWithValues: self.threads.map { ($0.id, $0.status) })
            let refreshedThreads = try await threads.sorted { $0.updatedAt > $1.updatedAt }
            self.projects = try await projects
            self.threads = refreshedThreads
            self.providers = try await providers
            self.models = try await models
            self.effectiveUpdatedAt.removeAll(keepingCapacity: true)
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
        let state = self.state(creating: threadID)
        guard !state.hasLoadedTimeline else { return }
        do {
            let items = try await backend.timeline(threadID: threadID)
            state.timeline = items.filter { !isDismissedUsageLimit($0) }
            state.timelineVersion += 1
            state.hasLoadedTimeline = true
            for item in state.timeline {
                recordInteraction(item, threadID: threadID)
            }
        } catch {
            lastError = String(describing: error)
        }
    }

    public func refreshDiff(threadID: String) async {
        do {
            state(creating: threadID).diff = try await backend.diff(threadID: threadID)
        } catch {
            lastError = String(describing: error)
        }
    }

    public func refreshCheckpoints(threadID: String) async {
        do {
            state(creating: threadID).checkpoints = try await backend.checkpoints(threadID: threadID)
        } catch {
            lastError = String(describing: error)
        }
    }

    // MARK: - Diff review mode

    /// Enter main-area review for a scope, optionally focusing a file path.
    public func openReview(
        threadID: String, scope: ReviewScope, focusPath: String? = nil
    ) {
        let ts = state(creating: threadID)
        ts.reviewScope = scope
        ts.reviewSelectedPath = focusPath
        ts.isReviewing = true
        ts.reviewDiff = nil
        ts.isLoadingReviewDiff = true
        Task { await loadReviewDiff(threadID: threadID) }
    }

    public func closeReview(threadID: String) {
        guard let ts = threadStates[threadID] else { return }
        ts.isReviewing = false
        ts.reviewScope = nil
        ts.reviewSelectedPath = nil
        ts.reviewDiff = nil
        ts.isLoadingReviewDiff = false
    }

    public func closeReview() {
        guard let threadID = selectedThreadID else { return }
        closeReview(threadID: threadID)
    }

    public func selectReviewFile(threadID: String, path: String?) {
        state(creating: threadID).reviewSelectedPath = path
    }

    public func loadReviewDiff(threadID: String) async {
        let ts = state(creating: threadID)
        guard let scope = ts.reviewScope else {
            ts.isLoadingReviewDiff = false
            return
        }
        ts.isLoadingReviewDiff = true
        do {
            let files: [DiffFile]
            switch scope {
            case .allChanges:
                files = try await backend.diff(threadID: threadID)
            case .checkpoint(let fromTurn, let toTurn, _):
                files = try await backend.diff(
                    threadID: threadID, fromTurn: fromTurn, toTurn: toTurn)
            }
            // Scope may have changed while the request was in flight.
            guard ts.reviewScope == scope else { return }
            ts.reviewDiff = files
            if let path = ts.reviewSelectedPath,
                files.contains(where: { $0.path == path })
            {
                // Keep focused path.
            } else {
                ts.reviewSelectedPath = files.first?.path
            }
        } catch {
            lastError = String(describing: error)
            if ts.reviewScope == scope {
                ts.reviewDiff = []
            }
        }
        ts.isLoadingReviewDiff = false
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

    /// Provider kinds that have at least one available provider instance with
    /// at least one selectable model. New-session entry points use this list
    /// instead of `ProviderKind.allCases` so unavailable/auth-required
    /// providers such as an unconfigured Claude Synthero cannot be selected
    /// and then fail with `noProviderForKind`.
    public var runnableProviderKinds: [ProviderKind] {
        let availableInstanceIDs = Set(
            providers
                .filter { $0.availability == .available }
                .map(\.id))
        return ProviderKind.allCases.filter { kind in
            models.contains { option in
                option.provider == kind && availableInstanceIDs.contains(option.instanceID)
            }
        }
    }

    /// Provider kinds that exist in the current server provider list. This is
    /// intentionally broader than `runnableProviderKinds`: new-session pickers
    /// should still show configured but auth-required providers (for example
    /// Claude Synthero before its token is entered) with a disabled action and
    /// a clear readiness hint instead of disappearing entirely.
    public var configuredProviderKinds: [ProviderKind] {
        ProviderKind.allCases.filter { kind in
            providers.contains { $0.kind == kind } || models.contains { $0.provider == kind }
        }
    }

    public func canCreateThread(with provider: ProviderKind) -> Bool {
        runnableProviderKinds.contains(provider)
    }

    public func providerAvailability(for provider: ProviderKind) -> ProviderAvailability? {
        let instances = providers.filter { $0.kind == provider }
        guard !instances.isEmpty else { return nil }
        if instances.contains(where: { $0.availability == .available }) {
            return .available
        }
        if instances.contains(where: { $0.availability == .authRequired }) {
            return .authRequired
        }
        return .missing
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

    public func waitForUsageLimitReset(_ notice: UsageLimitNotice) {
        guard let resetsAt = notice.resetsAt else { return }
        usageLimitResumeTasks[notice.id]?.cancel()
        let resumeAt = resetsAt.addingTimeInterval(90)
        usageLimitActions[notice.id] = .waiting(resumeAt: resumeAt)
        usageLimitResumeTasks[notice.id] = Task { [weak self] in
            let delay = max(0, resumeAt.timeIntervalSinceNow)
            let nanoseconds = UInt64(min(delay, 60 * 60 * 24 * 14) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            await self?.continueAfterUsageLimit(notice, model: nil)
        }
    }

    public func switchModelAfterUsageLimit(_ notice: UsageLimitNotice, to model: ModelOption) async {
        usageLimitResumeTasks[notice.id]?.cancel()
        await continueAfterUsageLimit(notice, model: model)
    }

    public func dismissUsageLimit(_ notice: UsageLimitNotice) {
        dismissedUsageLimitIDs.insert(notice.id)
        usageLimitResumeTasks[notice.id]?.cancel()
        usageLimitResumeTasks[notice.id] = nil
        usageLimitActions[notice.id] = nil
        for state in threadStates.values {
            if state.timeline.contains(where: { $0.id == notice.id }) {
                state.timeline.removeAll { $0.id == notice.id }
                state.timelineVersion += 1
            }
        }
    }

    private func continueAfterUsageLimit(_ notice: UsageLimitNotice, model: ModelOption?) async {
        do {
            if let model {
                usageLimitActions[notice.id] = .switching(modelName: model.displayName)
                try await backend.setModel(threadID: notice.threadID, model: model)
            } else {
                usageLimitActions[notice.id] = .resuming
            }
            try await backend.sendMessage(
                threadID: notice.threadID,
                text: Self.usageLimitContinuationPrompt,
                attachments: [])
            usageLimitActions[notice.id] = .continued
        } catch {
            let message = String(describing: error)
            usageLimitActions[notice.id] = .failed(message)
            lastError = message
        }
        usageLimitResumeTasks[notice.id] = nil
    }

    private func cancelUsageLimitResumeTasks(threadID: String) {
        let noticeIDs =
            threadStates[threadID]?.timeline.compactMap { item -> String? in
                guard case .usageLimit(let notice) = item else { return nil }
                return notice.id
            } ?? []
        for id in noticeIDs {
            usageLimitResumeTasks[id]?.cancel()
            usageLimitResumeTasks[id] = nil
            usageLimitActions[id] = nil
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
            try await backend.restoreCheckpoint(
                threadID: checkpoint.threadID, turnCount: checkpoint.turnCount)
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
        selectedThreadID.flatMap { threadStates[$0]?.vcsStatus }
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
            await releaseTimeline(threadID: thread.id)
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
            await releaseTimeline(threadID: thread.id)
        } catch {
            lastError = String(describing: error)
        }
    }

    // MARK: - Timeline subscription LRU

    /// Pure eviction policy: `recent` is MRU-first (index 0 = selected).
    /// Returns IDs past the `keep` window. Empty when under the limit.
    static func evictionCandidates(recent: [String], keep: Int) -> [String] {
        guard keep >= 0, recent.count > keep else { return [] }
        return Array(recent.dropFirst(keep))
    }

    /// Tear down backend timeline subscription and local timeline cache so a
    /// later selection refetches via `loadTimelineIfNeeded`.
    private func releaseTimeline(threadID: String) async {
        recentlySelected.removeAll { $0 == threadID }
        await backend.closeTimeline(threadID: threadID)
        if let state = threadStates[threadID] {
            state.timeline = []
            state.hasLoadedTimeline = false
        }
        TimelineDisplayCache.evict(threadID: threadID)
    }

    private func pruneTimelineSubscriptions() {
        let toEvict = Self.evictionCandidates(
            recent: recentlySelected, keep: Self.timelineSubscriptionKeepCount)
        guard !toEvict.isEmpty else { return }
        recentlySelected.removeAll { toEvict.contains($0) }
        for threadID in toEvict {
            // Never drop the currently selected thread, even if it somehow
            // appears past the keep window.
            guard threadID != selectedThreadID else { continue }
            // Detached close can race a re-select of this thread. Re-check
            // eviction under MainActor before clearing state / closing so a
            // rescued thread keeps its timeline and subscription.
            Task {
                guard threadID != self.selectedThreadID
                    && !self.recentlySelected.contains(threadID)
                else { return }
                if let state = self.threadStates[threadID] {
                    state.timeline = []
                    state.hasLoadedTimeline = false
                }
                TimelineDisplayCache.evict(threadID: threadID)
                await self.backend.closeTimeline(threadID: threadID)
            }
        }
    }
}

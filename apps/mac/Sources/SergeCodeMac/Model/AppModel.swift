import Foundation
import Observation

public enum SidebarMoveDirection: Sendable {
    case up, down
}

@Observable
@MainActor
public final class AppModel {
    public let deviceID: DeviceID
    public let deviceName: String?
    public let capabilities: BackendCapabilities

    public private(set) var connection: ConnectionPhase = .launchingServer
    public private(set) var projects: [Project] = []
    public private(set) var threads: [ChatThread] = []
    public private(set) var archivedThreads: [ChatThread] = []
    public private(set) var archivedThreadsLoading = false
    public private(set) var archivedThreadsError: String?
    /// Thread IDs pinned locally in the macOS client. Pinning is intentionally
    /// client-local: it is sidebar organization, not server thread metadata.
    public private(set) var pinnedThreadIDs: Set<String>
    /// Saved sidebar order keyed by project. Refreshes only merge new rows;
    /// they never replace an existing manual arrangement.
    public private(set) var manualThreadOrder: [String: [String]]
    public private(set) var providers: [ProviderInstance] = []
    public private(set) var models: [ModelOption] = []
    /// Server-catalog display names keyed by model slug for timeline badges.
    public private(set) var modelDisplayNames: [String: String] = [:]
    /// Low-frequency usage-limit card actions — stays flat on AppModel (not ThreadState).
    public private(set) var usageLimitActions: [String: UsageLimitActionState] = [:]
    /// Per-task stop failures for subagent rows (`taskId` → message). Transient;
    /// cleared on the next successful stop, a new stop attempt, or task state change.
    public private(set) var subagentStopErrors: [String: String] = [:]
    /// Cross-thread task projection. The task rows survive timeline eviction;
    /// only the live flag changes when a thread leaves the subscription LRU.
    let subagentTaskAggregator = SubagentTaskAggregator()
    /// Outcome of the most recent git action per thread, shown as a transient
    /// banner. Per-thread so a push/PR result from thread A never bleeds into
    /// thread B after a switch.
    public private(set) var lastGitActionOutcomeByThread: [String: GitActionOutcome] = [:]

    /// The most recent git-action outcome for `threadID`, if any.
    public func lastGitActionOutcome(for threadID: String) -> GitActionOutcome? {
        lastGitActionOutcomeByThread[threadID]
    }

    /// Compatibility accessor for the currently selected thread. The UI call
    /// sites (VcsToolbar) still read/clear this flat name; a later batch
    /// rewires them to the per-thread accessor above.
    public var lastGitActionOutcome: GitActionOutcome? {
        get { selectedThreadID.flatMap { lastGitActionOutcomeByThread[$0] } }
        set {
            guard let threadID = selectedThreadID else { return }
            lastGitActionOutcomeByThread[threadID] = newValue
        }
    }

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
    /// Retained timeline history is bounded even after its live subscription
    /// is closed. Keep the newest suffix so a later selection has useful
    /// stale content to render immediately.
    static let maxRetainedTimelineItems = 500

    /// In-app dictation (mic → local ASR → on-device cleanup → composer).
    /// Multiple device models may share one controller so ASR stays a single
    /// process-wide resource.
    public let dictation: DictationController

    /// Text staged for the composer by a timeline action (Edit on a sent
    /// message). The composer consumes it via `takeComposerPrefill`. A fresh
    /// UUID per staging makes repeat edits of the same text observable.
    public private(set) var composerPrefill: ComposerPrefill?

    /// In-memory outgoing queue, scoped by thread. Items are lost on app restart.
    public private(set) var queuedMessagesByThread: [String: [QueuedOutgoingMessage]] = [:]

    public struct ComposerPrefill: Equatable, Sendable {
        public let id: UUID
        public let threadID: String
        public let text: String
        /// When set, the next send rewinds the thread to just before this
        /// message (server revert) and the edited text replaces it.
        public let editedMessageID: String?
        /// Thread the edited message belongs to — discarded if the send
        /// targets a different thread, so edit-resend cannot rewind another
        /// thread even though composer drafts themselves are per-thread.
        public let editedMessageThreadID: String?

        public init(
            id: UUID, threadID: String, text: String, editedMessageID: String? = nil,
            editedMessageThreadID: String? = nil
        ) {
            self.id = id
            self.threadID = threadID
            self.text = text
            self.editedMessageID = editedMessageID
            self.editedMessageThreadID = editedMessageThreadID
        }
    }

    private let backend: any BackendService
    private var eventTask: Task<Void, Never>?
    private var usageLimitResumeTasks: [String: Task<Void, Never>] = [:]
    private var dismissedUsageLimitIDs: Set<String> = []

    private static let legacyPinnedThreadIDsKey = "SergeCode.pinnedThreadIDs"
    private static let pinnedThreadIDsKeyPrefix = "SergeCode.pinnedThreadIDs"
    private static let manualThreadOrderKey = "SergeCode.manualThreadOrder"

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
    /// threadID → latest review-diff load; older in-flight loads must not
    /// commit results (see loadReviewDiff).
    @ObservationIgnored private var reviewDiffLoadTokens: [String: UUID] = [:]
    /// threadID → latest diff/checkpoint refresh token. `.diffInvalidated` can
    /// fire rapidly (checkpoint completed, then reverted); only the newest
    /// refresh per thread may write its result, so out-of-order responses can't
    /// leave stale diff/checkpoint state.
    @ObservationIgnored private var refreshDiffTokens: [String: UUID] = [:]
    @ObservationIgnored private var refreshCheckpointsTokens: [String: UUID] = [:]
    /// Detached per-thread timeline-eviction tasks, kept so they can be
    /// cancelled at shutdown (they call into the backend and must not run
    /// against a just-stopped one, e.g. during remote-device removal).
    @ObservationIgnored private var pruneTimelineTasks: [String: Task<Void, Never>] = [:]
    /// Monotonic settings-save counter: only the latest save's response may
    /// commit, so overlapping keystroke-driven saves can't land out of order.
    @ObservationIgnored private var settingsSaveToken = 0
    @ObservationIgnored private var archivedThreadsRefreshToken = UUID()
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
    /// Direct lookup used by scenery resolution. Keys are local thread ids or
    /// device-scoped remote thread ids, matching `scopedThreadKey(_:)`.
    @ObservationIgnored private var projectPathByThreadKey: [String: String] = [:]

    public init(
        backend: any BackendService,
        deviceID: DeviceID = .local,
        deviceName: String? = nil,
        capabilities: BackendCapabilities = .local,
        dictation: DictationController? = nil
    ) {
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.capabilities = capabilities
        self.backend = backend
        self.dictation = dictation ?? DictationController()
        let pinnedKey = Self.pinnedThreadIDsStorageKey(for: deviceID)
        if let pinnedIDs = UserDefaults.standard.stringArray(forKey: pinnedKey) {
            self.pinnedThreadIDs = Set(pinnedIDs)
        } else if deviceID == .local,
            let legacyPinnedIDs = UserDefaults.standard.stringArray(
                forKey: Self.legacyPinnedThreadIDsKey)
        {
            self.pinnedThreadIDs = Set(legacyPinnedIDs)
            UserDefaults.standard.set(legacyPinnedIDs, forKey: pinnedKey)
            UserDefaults.standard.removeObject(forKey: Self.legacyPinnedThreadIDsKey)
        } else {
            self.pinnedThreadIDs = []
        }
        let orderKey = "\(Self.manualThreadOrderKey).\(deviceID.rawValue)"
        if let data = UserDefaults.standard.data(forKey: orderKey),
            let order = try? JSONDecoder().decode([String: [String]].self, from: data)
        {
            self.manualThreadOrder = order
        } else {
            self.manualThreadOrder = [:]
        }
    }

    public var isRemote: Bool { deviceID != .local }

    /// Key used by shared UI stores whose lifetime spans multiple device
    /// models. Local keys intentionally remain the historical raw thread id.
    public func scopedThreadKey(_ threadID: String) -> String {
        isRemote ? "\(deviceID.rawValue)/\(threadID)" : threadID
    }

    public func isThreadPinned(_ thread: ChatThread) -> Bool {
        pinnedThreadIDs.contains(thread.id)
    }

    public func togglePinned(_ thread: ChatThread) {
        if pinnedThreadIDs.contains(thread.id) {
            pinnedThreadIDs.remove(thread.id)
        } else {
            pinnedThreadIDs.insert(thread.id)
        }
        persistPinnedThreadIDs()
    }

    /// Keeps the existing newest-first order within each group while moving
    /// pinned rows ahead of unpinned rows.
    static func pinnedFirst(_ threads: [ChatThread], pinnedIDs: Set<String>) -> [ChatThread] {
        threads.filter { pinnedIDs.contains($0.id) }
            + threads.filter { !pinnedIDs.contains($0.id) }
    }

    static func manuallyOrdered(_ threads: [ChatThread], order: [String]) -> [ChatThread] {
        let byID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
        let saved = order.compactMap { byID[$0] }
        let savedIDs = Set(saved.map(\.id))
        return threads.filter { !savedIDs.contains($0.id) } + saved
    }

    public func orderedThreads(for projectID: String) -> [ChatThread] {
        let threads = self.threads.filter {
            $0.projectID == projectID && $0.status != .archived
        }
        return Self.manuallyOrdered(threads, order: manualThreadOrder[projectID] ?? [])
    }

    /// Returns the insertion bounds for moving rows without crossing the pin boundary.
    /// The input is expected to use `pinnedFirst` ordering, as rendered by the sidebar.
    static func reorderDestinationBounds(
        _ threads: [ChatThread], fromOffsets: IndexSet, pinnedIDs: Set<String>
    ) -> ClosedRange<Int>? {
        guard let firstOffset = fromOffsets.first,
            fromOffsets.allSatisfy({ $0 >= 0 && $0 < threads.count })
        else { return nil }

        let isPinned = pinnedIDs.contains(threads[firstOffset].id)
        guard fromOffsets.allSatisfy({ pinnedIDs.contains(threads[$0].id) == isPinned }) else {
            return nil
        }

        let groupOffsets = threads.indices.filter {
            pinnedIDs.contains(threads[$0].id) == isPinned
        }
        guard let groupStart = groupOffsets.first, let groupEnd = groupOffsets.last else {
            return nil
        }
        return groupStart...(groupEnd + 1)
    }

    public func canReorderThreads(
        _ threads: [ChatThread], fromOffsets: IndexSet, toOffset: Int
    ) -> Bool {
        Self.reorderDestinationBounds(
            threads, fromOffsets: fromOffsets, pinnedIDs: pinnedThreadIDs)?.contains(toOffset)
            == true
    }

    public func reorderThreads(
        _ threads: [ChatThread], fromOffsets: IndexSet, toOffset: Int, projectID: String
    ) {
        guard canReorderThreads(threads, fromOffsets: fromOffsets, toOffset: toOffset) else { return }
        var reordered = threads
        reordered.move(fromOffsets: fromOffsets, toOffset: toOffset)
        manualThreadOrder[projectID] = reordered.map(\.id)
        persistManualThreadOrder()
    }

    /// Persists a complete sidebar order after a grouped multi-device list has
    /// translated its drag operation back to this model's project rows.
    public func applySidebarOrder(_ orderedThreads: [ChatThread], projectID: String) {
        let current = Self.pinnedFirst(
            self.orderedThreads(for: projectID), pinnedIDs: pinnedThreadIDs)
        guard orderedThreads.count == current.count,
            Set(orderedThreads.map(\.id)) == Set(current.map(\.id)),
            orderedThreads.allSatisfy({ $0.projectID == projectID })
        else { return }

        var encounteredUnpinned = false
        for thread in orderedThreads {
            if pinnedThreadIDs.contains(thread.id) {
                guard !encounteredUnpinned else { return }
            } else {
                encounteredUnpinned = true
            }
        }

        manualThreadOrder[projectID] = orderedThreads.map(\.id)
        persistManualThreadOrder()
    }

    public func canMoveThread(_ thread: ChatThread, direction: SidebarMoveDirection) -> Bool {
        let visible = Self.pinnedFirst(
            orderedThreads(for: thread.projectID), pinnedIDs: pinnedThreadIDs)
        guard let index = visible.firstIndex(where: { $0.id == thread.id }) else { return false }
        let destination = direction == .up ? index - 1 : index + 2
        return canReorderThreads(
            visible, fromOffsets: IndexSet(integer: index), toOffset: destination)
    }

    public func moveThread(_ thread: ChatThread, direction: SidebarMoveDirection) {
        let visible = Self.pinnedFirst(
            orderedThreads(for: thread.projectID), pinnedIDs: pinnedThreadIDs)
        guard let index = visible.firstIndex(where: { $0.id == thread.id }) else { return }
        let destination = direction == .up ? index - 1 : index + 2
        reorderThreads(
            visible, fromOffsets: IndexSet(integer: index), toOffset: destination,
            projectID: thread.projectID)
    }

    private func persistPinnedThreadIDs() {
        UserDefaults.standard.set(
            Array(pinnedThreadIDs),
            forKey: Self.pinnedThreadIDsStorageKey(for: deviceID))
    }

    private static func pinnedThreadIDsStorageKey(for deviceID: DeviceID) -> String {
        "\(pinnedThreadIDsKeyPrefix).\(deviceID.rawValue)"
    }

    private func persistManualThreadOrder() {
        let key = "\(Self.manualThreadOrderKey).\(deviceID.rawValue)"
        guard let data = try? JSONEncoder().encode(manualThreadOrder) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    private static func makeModelDisplayNames(from models: [ModelOption]) -> [String: String] {
        models.reduce(into: [String: String]()) { displayNames, model in
            let slug = model.modelID.trimmingCharacters(in: .whitespacesAndNewlines)
            let displayName = model.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !slug.isEmpty, !displayName.isEmpty, displayNames[slug] == nil else { return }
            displayNames[slug] = displayName
        }
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

    /// Version of the stored timeline structure for `threadID` (0 if never
    /// written).
    public func timelineStructureVersion(threadID: String) -> Int {
        threadStates[threadID]?.structureVersion ?? 0
    }

    public var selectedThread: ChatThread? {
        threads.first { $0.id == selectedThreadID }
    }

    public func thread(threadID: String) -> ChatThread? {
        threads.first { $0.id == threadID }
    }

    public func timeline(threadID: String) -> [TimelineItem] {
        threadStates[threadID]?.timeline ?? []
    }

    public func selectedTimeline() -> [TimelineItem] {
        selectedThreadID.map { timeline(threadID: $0) } ?? []
    }

    public var selectedQueuedMessages: [QueuedOutgoingMessage] {
        selectedThreadID.flatMap { queuedMessagesByThread[$0] } ?? []
    }

    public func composerDraft(for threadID: String) -> ComposerDraft {
        threadStates[threadID]?.composerDraft ?? ComposerDraft()
    }

    public func setComposerDraftText(_ text: String, for threadID: String) {
        state(creating: threadID).composerDraft.text = text
    }

    public func setComposerDraftAttachments(
        _ attachments: [OutgoingAttachment], for threadID: String
    ) {
        state(creating: threadID).composerDraft.attachments = attachments
    }

    public func clearComposerDraft(for threadID: String) {
        guard let threadState = threadStates[threadID] else { return }
        threadState.composerDraft = ComposerDraft()
    }

    /// Restores a failed submission unless the user has started a new draft.
    @discardableResult
    public func restoreComposerDraft(_ draft: ComposerDraft, for threadID: String) -> Bool {
        guard let threadState = threadStates[threadID], threadState.composerDraft.isEmpty else {
            return false
        }
        threadState.composerDraft = draft
        return true
    }

    // MARK: - Lifecycle

    public func start() {
        guard eventTask == nil else { return }
        let backend = backend
        eventTask = Task { [weak self] in
            let stream = await backend.events()
            async let _ = backend.start()
            for await event in stream {
                self?.enqueue(event)
            }
        }
    }

    /// Cancels MainActor-owned lifecycle work before a caller tears down the
    /// backend from a non-MainActor context.
    func prepareForTermination() {
        eventTask?.cancel()
        eventTask = nil
        // Detached timeline-eviction closes call into the backend; cancel them
        // so none runs against a backend that's about to (or did) stop.
        for task in pruneTimelineTasks.values { task.cancel() }
        pruneTimelineTasks.removeAll()
    }

    /// Shutdown needs the backend after MainActor-owned tasks have stopped.
    var backendForShutdown: any BackendService { backend }

    public func shutdown() async {
        flushPendingEvents()
        prepareForTermination()
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
        PerfSignpost.interval("applyBatch") {
            PerfMetrics.measure("applyBatch") {
                applyBatchImplementation(events)
            }
        }
    }

    private func applyBatchImplementation(_ events: [BackendEvent]) {
        var touched: [String: [TimelineItem]] = [:]
        var indexByThread: [String: [String: Int]] = [:]
        // Only full snapshots (timelineReset) mark history loaded. Plain
        // appends / deltas must not set hasLoadedTimeline — otherwise a
        // stream event for a not-yet-selected thread suppresses the later
        // history fetch forever.
        var resetThreads: Set<String> = []
        var structuralThreads: Set<String> = []

        func currentItems(_ threadID: String) -> [TimelineItem] {
            touched[threadID] ?? threadStates[threadID]?.timeline ?? []
        }

        func ensureTimelineIndex(_ threadID: String, items: [TimelineItem]) {
            guard indexByThread[threadID] == nil else { return }
            var indexByID: [String: Int] = [:]
            indexByID.reserveCapacity(items.count)
            for (index, item) in items.enumerated() {
                indexByID[item.id] = index
            }
            indexByThread[threadID] = indexByID
        }

        // A run of deltas for the same message collapses to one string
        // concatenation and one array write.
        var deltaThreadID: String?
        var deltaMessageID = ""
        var deltaText = ""
        func flushPendingDelta() {
            guard let threadID = deltaThreadID else { return }
            var items = currentItems(threadID)
            if applyDelta(
                threadID: threadID, messageID: deltaMessageID, delta: deltaText, items: &items,
                indexByID: &indexByThread[threadID])
            {
                structuralThreads.insert(threadID)
            }
            touched[threadID] = items
            deltaThreadID = nil
            deltaText = ""
        }

        func resolveInteraction(_ id: String) -> String? {
            func removeItem(threadID: String) -> Bool {
                var items = currentItems(threadID)
                let index: Int?
                if let cachedIndex = indexByThread[threadID]?[id],
                    items.indices.contains(cachedIndex), items[cachedIndex].id == id
                {
                    index = cachedIndex
                } else {
                    if indexByThread[threadID] != nil {
                        indexByThread[threadID]![id] = nil
                    }
                    index = items.firstIndex(where: { $0.id == id })
                    if let index, indexByThread[threadID] != nil {
                        indexByThread[threadID]![id] = index
                    }
                }
                guard let index else { return false }
                items.remove(at: index)
                touched[threadID] = items
                indexByThread[threadID] = nil
                // Removal shifts indices; the streaming index self-validates,
                // but drop it so the next delta rescans instead of racing.
                streamingIndex[threadID] = nil
                return true
            }

            if let threadID = interactionThreadByID.removeValue(forKey: id),
                removeItem(threadID: threadID)
            {
                return threadID
            }
            // Fallback for items that predate the map (e.g. from a snapshot
            // loaded via loadTimelineIfNeeded rather than an event).
            for threadID in Set(threadStates.keys).union(touched.keys) {
                if removeItem(threadID: threadID) {
                    return threadID
                }
            }
            return nil
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
                ensureTimelineIndex(threadID, items: items)
                // Task progress keeps a stable row id and never changes the
                // grouping shape. Treating every update as structural forced
                // a full transcript regroup/diff for each Claude progress
                // event, which could starve LazyVStack layout until the chat
                // appeared blank. New task rows are still structural.
                let isExistingTaskUpdate: Bool
                if case .subagentTask = item {
                    isExistingTaskUpdate = indexByThread[threadID]?[item.id] != nil
                } else {
                    isExistingTaskUpdate = false
                }
                items.upsertTimelineItem(item, indexByID: &indexByThread[threadID]!)
                touched[threadID] = items
                if !isExistingTaskUpdate {
                    structuralThreads.insert(threadID)
                }
                if case .subagentTask(let task) = item {
                    subagentTaskAggregator.upsert(task, for: threadID)
                }
                recordInteraction(item, threadID: threadID)
            case .timelineReset(let threadID, let items):
                // A snapshot can truncate or replace an in-flight message;
                // the old settled prefix is no longer valid for this thread.
                StreamingMarkdownCache.evict(threadID: scopedThreadKey(threadID))
                let filtered = items.filter { !isDismissedUsageLimit($0) }
                touched[threadID] = filtered
                indexByThread[threadID] = nil
                resetThreads.insert(threadID)
                structuralThreads.insert(threadID)
                streamingIndex[threadID] = nil
                for item in filtered { recordInteraction(item, threadID: threadID) }
            case .assistantCompleted(let threadID, let messageID, let markdown):
                // Assistant rows are always `.single`; grouping does not read
                // their markdown or item-level isStreaming state.
                var items = currentItems(threadID)
                finishStreaming(
                    threadID: threadID, messageID: messageID, markdown: markdown, items: &items,
                    indexByID: &indexByThread[threadID])
                touched[threadID] = items
            case .approvalResolved(let id), .userInputResolved(let id):
                if let threadID = resolveInteraction(id) {
                    structuralThreads.insert(threadID)
                }
            default:
                applyNonTimeline(event)
            }
        }
        flushPendingDelta()

        for (threadID, items) in touched {
            let state = self.state(creating: threadID)
            state.timeline = items
            state.timelineVersion += 1
            if structuralThreads.contains(threadID) {
                state.structureVersion += 1
            }
            if resetThreads.contains(threadID) {
                state.hasLoadedTimeline = true
                subagentTaskAggregator.replaceTasks(
                    subagentTasks(from: items), for: threadID)
            }
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
            rebuildProjectPathIndex()
        case .threadUpserted(let thread):
            subagentTaskAggregator.updateThread(thread)
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
            updateProjectPathIndex(for: thread)
        case .threadRemoved(let id):
            subagentTaskAggregator.remove(threadID: id)
            threads.removeAll { $0.id == id }
            if pinnedThreadIDs.remove(id) != nil {
                persistPinnedThreadIDs()
            }
            // ThreadState owns the in-memory composer draft, so removing the
            // child also drops that thread's text and staged attachments.
            threadStates[id] = nil
            effectiveUpdatedAt[id] = nil
            recentlySelected.removeAll { $0 == id }
            cancelUsageLimitResumeTasks(threadID: id)
            queuedMessagesByThread[id] = nil
            queuedSendInFlightThreadIDs.remove(id)
            queuedRetryTokensByThread[id] = nil
            projectPathByThreadKey[scopedThreadKey(id)] = nil
            if composerPrefill?.threadID == id { composerPrefill = nil }
            // Per-thread intake bookkeeping the old handler missed: stale
            // load tokens, the streaming-index cursor, git outcome, and any
            // interaction routes pointing at this id.
            reviewDiffLoadTokens[id] = nil
            refreshDiffTokens[id] = nil
            refreshCheckpointsTokens[id] = nil
            streamingIndex[id] = nil
            lastGitActionOutcomeByThread[id] = nil
            interactionThreadByID = interactionThreadByID.filter { $0.value != id }
            pruneTimelineTasks.removeValue(forKey: id)?.cancel()
            TimelineDisplayCache.evict(threadID: scopedThreadKey(id))
            StreamingMarkdownCache.evict(threadID: scopedThreadKey(id))
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
        case .subagentStopFailed(let taskId, let message):
            // Async stop failures (unsupported adapter, no session, etc.)
            // arrive as projected activities, not as a thrown RPC error.
            subagentStopErrors[taskId] = message
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

    @discardableResult
    private func applyDelta(
        threadID: String, messageID: String, delta: String, items: inout [TimelineItem],
        indexByID: inout [String: Int]?
    ) -> Bool {
        if let cached = streamingIndex[threadID], cached.messageID == messageID,
            items.indices.contains(cached.index),
            case .assistantMessage(let id, let markdown, _, let at) = items[cached.index],
            id == messageID
        {
            items[cached.index] = .assistantMessage(
                id: id, markdown: markdown + delta, isStreaming: true, at: at)
            indexByID?[messageID] = cached.index
            return false
        }
        if let indexed = indexByID?[messageID] {
            if items.indices.contains(indexed),
                case .assistantMessage(let id, let markdown, _, let at) = items[indexed],
                id == messageID
            {
                items[indexed] = .assistantMessage(
                    id: id, markdown: markdown + delta, isStreaming: true, at: at)
                streamingIndex[threadID] = (messageID, indexed)
                return false
            }
            indexByID?[messageID] = nil
        }
        for (index, item) in items.enumerated() {
            if case .assistantMessage(let id, let markdown, _, let at) = item, id == messageID {
                items[index] = .assistantMessage(
                    id: id, markdown: markdown + delta, isStreaming: true, at: at)
                streamingIndex[threadID] = (messageID, index)
                indexByID?[messageID] = index
                return false
            }
        }
        items.append(.assistantMessage(id: messageID, markdown: delta, isStreaming: true, at: Date()))
        streamingIndex[threadID] = (messageID, items.count - 1)
        indexByID?[messageID] = items.count - 1
        return true
    }

    private func finishStreaming(
        threadID: String, messageID: String, markdown: String, items: inout [TimelineItem],
        indexByID: inout [String: Int]?
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
            indexByID?[messageID] = cached.index
            return
        }
        if let indexed = indexByID?[messageID] {
            if items.indices.contains(indexed),
                case .assistantMessage(let id, _, _, let at) = items[indexed], id == messageID
            {
                items[indexed] = .assistantMessage(
                    id: id, markdown: markdown, isStreaming: false, at: at)
                return
            }
            indexByID?[messageID] = nil
        }
        for (index, item) in items.enumerated() {
            if case .assistantMessage(let id, _, _, let at) = item, id == messageID {
                items[index] = .assistantMessage(
                    id: id, markdown: markdown, isStreaming: false, at: at)
                indexByID?[messageID] = index
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
            rebuildProjectPathIndex()
            let liveThreadIDs = Set(refreshedThreads.map(\.id))
            if pinnedThreadIDs.intersection(liveThreadIDs) != pinnedThreadIDs {
                pinnedThreadIDs.formIntersection(liveThreadIDs)
                persistPinnedThreadIDs()
            }
            for thread in refreshedThreads {
                subagentTaskAggregator.updateThread(thread)
            }
            self.providers = try await providers
            let refreshedModels = try await models
            self.models = refreshedModels
            self.modelDisplayNames = Self.makeModelDisplayNames(from: refreshedModels)
            self.effectiveUpdatedAt.removeAll(keepingCapacity: true)
            for thread in refreshedThreads
            where shouldSendQueuedMessage(
                previousStatus: previousStatuses[thread.id], newStatus: thread.status)
            {
                dequeueNextQueuedMessageIfNeeded(threadID: thread.id)
            }
            await refreshArchivedThreads()
        } catch {
            lastError = String(describing: error)
        }
    }

    public func refreshModels() async {
        do {
            let refreshedModels = try await backend.models()
            models = refreshedModels
            modelDisplayNames = Self.makeModelDisplayNames(from: refreshedModels)
        } catch {
            lastError = String(describing: error)
        }
    }

    /// Returns the project path for a scenery lookup key in O(1) time.
    public func projectPath(forScopedThreadKey threadKey: String) -> String? {
        projectPathByThreadKey[threadKey]
    }

    private func rebuildProjectPathIndex() {
        let pathsByProjectID = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0.path) })
        projectPathByThreadKey = Dictionary(
            threads.compactMap { thread in
                pathsByProjectID[thread.projectID].map {
                    (scopedThreadKey(thread.id), $0)
                }
            },
            uniquingKeysWith: { _, latest in latest })
    }

    private func updateProjectPathIndex(for thread: ChatThread) {
        let key = scopedThreadKey(thread.id)
        projectPathByThreadKey[key] = projects.first(where: { $0.id == thread.projectID })?.path
    }

    public func loadTimelineIfNeeded(threadID: String) async {
        let state = self.state(creating: threadID)
        guard !state.hasLoadedTimeline else {
            subagentTaskAggregator.setLive(true, for: threadID)
            return
        }
        state.isLoadingTimeline = true
        defer { state.isLoadingTimeline = false }
        do {
            let items = try await backend.timeline(threadID: threadID)
            let filtered = items.filter { !isDismissedUsageLimit($0) }
            state.timeline = filtered
            state.timelineVersion += 1
            state.structureVersion += 1
            state.hasLoadedTimeline = true
            subagentTaskAggregator.setLive(true, for: threadID)
            subagentTaskAggregator.replaceTasks(
                subagentTasks(from: filtered), for: threadID)
            for item in filtered {
                recordInteraction(item, threadID: threadID)
            }
        } catch {
            lastError = String(describing: error)
        }
    }

    public func refreshDiff(threadID: String) async {
        let token = UUID()
        refreshDiffTokens[threadID] = token
        do {
            let files = try await backend.diff(threadID: threadID)
            guard refreshDiffTokens[threadID] == token else { return }
            state(creating: threadID).diff = files
        } catch {
            guard refreshDiffTokens[threadID] == token else { return }
            lastError = String(describing: error)
        }
    }

    public func refreshCheckpoints(threadID: String) async {
        let token = UUID()
        refreshCheckpointsTokens[threadID] = token
        do {
            let checkpoints = try await backend.checkpoints(threadID: threadID)
            guard refreshCheckpointsTokens[threadID] == token else { return }
            state(creating: threadID).checkpoints = checkpoints
        } catch {
            guard refreshCheckpointsTokens[threadID] == token else { return }
            lastError = String(describing: error)
        }
    }

    // MARK: - Subagent inner threads

    /// Opens a subagent's inner thread in the main area, switching threads
    /// first when the task belongs to another thread (the agents panel can
    /// open a task on a thread that is not selected).
    public func openSubagent(taskId: String, threadID: String) {
        if selectedThreadID != threadID {
            selectedThreadID = threadID
        }
        // Review mode owns the same real estate; a subagent drill-down leaves it.
        closeReview(threadID: threadID)
        state(creating: threadID).focusedSubagentTaskID = taskId
    }

    public func closeSubagent(threadID: String) {
        threadStates[threadID]?.focusedSubagentTaskID = nil
    }

    public func closeSubagent() {
        guard let threadID = selectedThreadID else { return }
        closeSubagent(threadID: threadID)
    }

    /// The task behind an open inner thread, or nil once it has been pruned
    /// (thread eviction, timeline reset) — callers fall back to the transcript.
    public func focusedSubagentTask(threadID: String) -> SubagentTaskItem? {
        guard let taskId = threadStates[threadID]?.focusedSubagentTaskID else { return nil }
        return subagentTaskAggregator.task(taskId: taskId, threadID: threadID)
    }

    /// Stages `text` into the selected thread's composer, appending to any
    /// existing draft so promoting a result never clobbers what was typed.
    public func stageComposerTextAppending(_ text: String) {
        guard let threadID = selectedThreadID else { return }
        let existing = composerDraft(for: threadID).text
        let trimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        stageComposerText(trimmed.isEmpty ? text : existing + "\n\n" + text)
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
        // Orphan any in-flight load so a late response can't repopulate state.
        reviewDiffLoadTokens.removeValue(forKey: threadID)
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
        // Loads can overlap (openReview vs. diffInvalidated) and the same
        // scope can be re-requested, so a scope check alone can't tell an old
        // response from the latest — only the newest token may commit.
        let token = UUID()
        reviewDiffLoadTokens[threadID] = token
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
            guard reviewDiffLoadTokens[threadID] == token, ts.reviewScope == scope else { return }
            ts.reviewDiff = files
            if let path = ts.reviewSelectedPath,
                files.contains(where: { $0.path == path })
            {
                // Keep focused path.
            } else {
                ts.reviewSelectedPath = files.first?.path
            }
        } catch {
            guard reviewDiffLoadTokens[threadID] == token, ts.reviewScope == scope else { return }
            lastError = String(describing: error)
            ts.reviewDiff = []
        }
        if reviewDiffLoadTokens[threadID] == token {
            ts.isLoadingReviewDiff = false
        }
    }

    // MARK: - Commands

    /// Stages `text` for the composer (Edit action on a sent message).
    /// When `editedMessageID` is set, a subsequent send rewinds the thread
    /// so the edited text replaces that message instead of appending.
    public func stageComposerText(_ text: String, editedMessageID: String? = nil) {
        guard let threadID = selectedThreadID else { return }
        setComposerDraftText(text, for: threadID)
        composerPrefill = ComposerPrefill(
            id: UUID(),
            threadID: threadID,
            text: text,
            editedMessageID: editedMessageID,
            editedMessageThreadID: editedMessageID != nil ? threadID : nil
        )
    }

    /// Marks the staged prefill consumed. Returns it, or nil if already taken.
    public func takeComposerPrefill() -> ComposerPrefill? {
        defer { composerPrefill = nil }
        return composerPrefill
    }

    /// Drops any unconsumed edit prefill (thread switch / composer clear).
    public func clearComposerPrefill() {
        composerPrefill = nil
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

    @discardableResult
    public func send(
        text: String,
        attachments: [OutgoingAttachment] = [],
        replacingMessageID: String? = nil,
        replacingMessageThreadID: String? = nil
    ) async -> Bool {
        guard let threadID = selectedThreadID else { return false }
        return await send(
            threadID: threadID, text: text, attachments: attachments,
            replacingMessageID: replacingMessageID,
            replacingMessageThreadID: replacingMessageThreadID)
    }

    @discardableResult
    public func send(
        threadID: String,
        text: String,
        attachments: [OutgoingAttachment] = [],
        replacingMessageID: String? = nil,
        replacingMessageThreadID: String? = nil
    ) async -> Bool {
        await sendAndReport(
            threadID: threadID, text: text, attachments: attachments,
            replacingMessageID: replacingMessageID,
            replacingMessageThreadID: replacingMessageThreadID)
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
        threadID: String, text: String, attachments: [OutgoingAttachment],
        replacingMessageID: String? = nil, replacingMessageThreadID: String? = nil
    ) async -> Bool {
        do {
            try await sendMessage(
                threadID: threadID, text: text, attachments: attachments,
                replacingMessageID: replacingMessageID,
                replacingMessageThreadID: replacingMessageThreadID)
            return true
        } catch {
            lastError = String(describing: error)
            return false
        }
    }

    private func sendMessage(
        threadID: String, text: String, attachments: [OutgoingAttachment],
        replacingMessageID: String? = nil, replacingMessageThreadID: String? = nil
    ) async throws {
        guard !(text.isEmpty && attachments.isEmpty) else { return }
        // Edit/resend: only revert when the staged message belongs to the
        // thread we're about to send on. A cross-thread send must not truncate.
        if let messageID = replacingMessageID,
            let originThreadID = replacingMessageThreadID,
            originThreadID == threadID
        {
            let timeline = threadStates[threadID]?.timeline ?? []
            if let turnCount = Self.revertTurnCount(forUserMessageID: messageID, in: timeline) {
                try await backend.restoreCheckpoint(threadID: threadID, turnCount: turnCount)
            }
        }
        try await backend.sendMessage(threadID: threadID, text: text, attachments: attachments)
    }

    /// Maps a user message to the checkpoint turn count the server should
    /// retain before that message — web-client parity (`ChatView.tsx`
    /// `revertTurnCountByUserMessageId`):
    /// 1. Walk forward from the user message to the next checkpoint that
    ///    belongs to the turn it started (`max(0, checkpoint.turnCount - 1)`).
    /// 2. Stop at the next user message if no checkpoint is found.
    /// 3. Fallback: 0-based index among user messages (covers incomplete /
    ///    cancelled turns that never produced a checkpoint).
    static func revertTurnCount(forUserMessageID messageID: String, in timeline: [TimelineItem])
        -> Int?
    {
        guard
            let start = timeline.firstIndex(where: {
                if case .userMessage(let id, _, _) = $0 { return id == messageID }
                return false
            })
        else { return nil }

        var index = start + 1
        while index < timeline.count {
            switch timeline[index] {
            case .userMessage:
                return userMessageIndex(of: messageID, in: timeline)
            case .checkpoint(let checkpoint) where checkpoint.turnCount > 0:
                return max(0, checkpoint.turnCount - 1)
            default:
                index += 1
            }
        }
        return userMessageIndex(of: messageID, in: timeline)
    }

    private static func userMessageIndex(of messageID: String, in timeline: [TimelineItem]) -> Int?
    {
        var index = 0
        for item in timeline {
            guard case .userMessage(let id, _, _) = item else { continue }
            if id == messageID { return index }
            index += 1
        }
        return nil
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

    public func setExecutorModel(instanceID: String?, modelID: String?) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setExecutorModel(
                threadID: threadID, instanceID: instanceID, modelID: modelID)
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
                state.structureVersion += 1
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

    public func setServiceTier(_ value: String) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setServiceTier(threadID: threadID, value: value)
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

    public func stopSubagentTask(taskId: String, threadID: String? = nil) async {
        guard let threadID = threadID ?? selectedThreadID else { return }
        // Clear any prior stop error so a retry starts clean.
        subagentStopErrors[taskId] = nil
        do {
            try await backend.stopTask(threadID: threadID, taskId: taskId)
            subagentStopErrors[taskId] = nil
        } catch {
            // Surface on the task row — `lastError` is not rendered in the chat timeline.
            subagentStopErrors[taskId] = String(describing: error)
        }
    }

    /// Clears a per-task stop error (e.g. when the task transitions state).
    public func clearSubagentStopError(taskId: String) {
        subagentStopErrors[taskId] = nil
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
            rebuildProjectPathIndex()
        } catch {
            lastError = String(describing: error)
        }
    }

    // MARK: - Mobile pairing (Settings ▸ iPhone)

    public func isServerLanReachable() async -> Bool {
        await backend.isServerLanReachable()
    }

    public func remoteAccessStatus() async -> ServerRemoteAccessStatus {
        await backend.remoteAccessStatus()
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
        // The settings UI can fire one unawaited save per keystroke; whichever
        // RESPONSE lands last would otherwise win regardless of order. Gate the
        // `settings =` assignment on a monotonic token so only the latest
        // in-flight save commits, independent of caller debouncing.
        settingsSaveToken += 1
        let token = settingsSaveToken
        do {
            let updated = try await backend.updateSettings(new)
            guard token == settingsSaveToken else { return }
            settings = updated
        } catch {
            guard token == settingsSaveToken else { return }
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

    public func openInEditor(
        threadID: String, subpath: String?, editor: ExternalEditor
    ) async {
        guard capabilities.opensLocalEditor else {
            lastError = "File is on \(deviceName ?? "the remote Mac")"
            return
        }
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

    public func pullRequestReview(threadID: String, reference: String) async throws
        -> PullRequestReviewSnapshot
    {
        try await backend.pullRequestReview(threadID: threadID, reference: reference)
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
            let outcome = try await backend.runGitAction(
                threadID: threadID, action: action, commitMessage: commitMessage)
            lastGitActionOutcomeByThread[threadID] = outcome
            // Merge (and other actions that change remote PR state) need a
            // fresh VCS snapshot so dedicated buttons disappear promptly.
            if (action == .mergePR || action == .readyPR), outcome.success {
                try? await backend.watchVcsStatus(threadID: threadID)
            }
        } catch {
            lastGitActionOutcomeByThread[threadID] = GitActionOutcome(
                success: false, title: "Git action failed", detail: String(describing: error))
        }
    }

    public func refreshArchivedThreads() async {
        let token = UUID()
        archivedThreadsRefreshToken = token
        archivedThreadsLoading = true
        archivedThreadsError = nil
        do {
            let refreshed = try await backend.archivedThreads().sorted { $0.updatedAt > $1.updatedAt }
            guard archivedThreadsRefreshToken == token else { return }
            archivedThreads = refreshed
            archivedThreadsLoading = false
        } catch {
            guard archivedThreadsRefreshToken == token else { return }
            archivedThreadsLoading = false
            archivedThreadsError = String(describing: error)
        }
    }

    public func archiveThread(_ thread: ChatThread) async {
        do {
            try await backend.archiveThread(id: thread.id)
            await releaseTimeline(threadID: thread.id)
            await refreshArchivedThreads()
        } catch {
            lastError = String(describing: error)
        }
    }

    public func unarchiveThread(_ thread: ChatThread) async {
        do {
            try await backend.unarchiveThread(id: thread.id)
            await refreshArchivedThreads()
        } catch {
            lastError = String(describing: error)
        }
    }

    public func deleteThread(_ thread: ChatThread) async {
        do {
            try await backend.deleteThread(id: thread.id)
            await releaseTimeline(threadID: thread.id)
            await refreshArchivedThreads()
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

    /// Tear down the backend timeline subscription while retaining a bounded
    /// stale snapshot so a later selection can render immediately and then
    /// refresh it through `loadTimelineIfNeeded`.
    private func releaseTimeline(threadID: String) async {
        recentlySelected.removeAll { $0 == threadID }
        subagentTaskAggregator.setLive(false, for: threadID)
        await backend.closeTimeline(threadID: threadID)
        if let state = threadStates[threadID] {
            trimRetainedTimelineIfNeeded(state)
            state.hasLoadedTimeline = false
        }
        // Stale-while-revalidate: keep the TimelineDisplayCache entry so a
        // re-select renders the retained snapshot instantly; only streaming
        // parse sessions are dropped.
        StreamingMarkdownCache.evict(threadID: scopedThreadKey(threadID))
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
            // rescued thread keeps its timeline and subscription. Stored and
            // cancellable so shutdown never lets one call a stopped backend.
            pruneTimelineTasks[threadID]?.cancel()
            pruneTimelineTasks[threadID] = Task { [weak self] in
                guard let self else { return }
                if !Task.isCancelled,
                    threadID != self.selectedThreadID,
                    !self.recentlySelected.contains(threadID)
                {
                    self.subagentTaskAggregator.setLive(false, for: threadID)
                    if let state = self.threadStates[threadID] {
                        self.trimRetainedTimelineIfNeeded(state)
                        state.hasLoadedTimeline = false
                    }
                    // Stale-while-revalidate: keep the display cache (see
                    // releaseTimeline); only streaming parse sessions drop.
                    StreamingMarkdownCache.evict(threadID: self.scopedThreadKey(threadID))
                    if !Task.isCancelled {
                        await self.backend.closeTimeline(threadID: threadID)
                    }
                }
                self.pruneTimelineTasks[threadID] = nil
            }
        }
    }

    /// Trim only when needed. A real trim changes the cached shape, so bump
    /// both monotonic versions instead of resetting them; the retained
    /// `TimelineDisplayCache` entry will re-key on its next read.
    private func trimRetainedTimelineIfNeeded(_ state: ThreadState) {
        guard state.timeline.count > Self.maxRetainedTimelineItems else { return }
        state.timeline = Array(state.timeline.suffix(Self.maxRetainedTimelineItems))
        state.timelineVersion += 1
        state.structureVersion += 1
    }

    private func subagentTasks(from items: [TimelineItem]) -> [SubagentTaskItem] {
        items.compactMap { item in
            guard case .subagentTask(let task) = item else { return nil }
            return task
        }
    }
}

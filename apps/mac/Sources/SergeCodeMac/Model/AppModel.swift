import Foundation
import Observation
import T3Kit

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
    /// Offset for the next archived page; nil when everything is loaded.
    public private(set) var archivedThreadsNextCursor: Int?
    /// Total archived thread count across all pages (from the server).
    public private(set) var archivedThreadsTotal = 0
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
    /// Outcome of the most recent git action per thread, shown as a transient
    /// banner. Per-thread so a push/PR result from thread A never bleeds into
    /// thread B after a switch.
    public private(set) var lastGitActionOutcomeByThread: [String: GitActionOutcome] = [:]

    /// The most recent git-action outcome for `threadID`, if any.
    public func lastGitActionOutcome(for threadID: String) -> GitActionOutcome? {
        lastGitActionOutcomeByThread[threadID]
    }

    /// Why the last review-diff load failed, per thread. Review mode replaces
    /// the whole chat column — composer included — so `lastError`'s only
    /// renderer is off-screen exactly when this fires; the review pane renders
    /// this itself instead of showing "No Changes" for a failed load.
    public private(set) var reviewDiffErrorByThread: [String: String] = [:]

    /// The review-diff load failure for `threadID`, if the last load failed.
    public func reviewDiffError(for threadID: String) -> String? {
        reviewDiffErrorByThread[threadID]
    }

    /// One-shot window-level celebration for a successful PR merge. Set when a
    /// `mergePR` action succeeds; the root view renders the confetti overlay
    /// and clears it via `clearMergeCelebration()` once it has played out.
    /// Not per-thread: merging is rare and the overlay covers the whole window.
    public private(set) var mergeCelebration: MergeCelebration?

    /// Dismisses the merge celebration, but only if it is still the one the
    /// overlay was showing — a second merge during the first celebration must
    /// not be dismissed by the first celebration's timer.
    public func clearMergeCelebration(id: MergeCelebration.ID) {
        guard mergeCelebration?.id == id else { return }
        mergeCelebration = nil
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
            // `lastError` is flat but every renderer of it sits under a
            // thread's composer, so an error raised on thread A would follow
            // the user into thread B and imply B is broken. Cleared before the
            // deselect guard so the `threadRemoved` path clears it too.
            if oldValue != selectedThreadID { lastError = nil }
            guard let id = selectedThreadID else { return }
            recentlySelected.removeAll { $0 == id }
            recentlySelected.insert(id, at: 0)
            pruneTimelineSubscriptions()
        }
    }
    public var lastError: String?

    /// Records a user-facing failure — the single funnel into `lastError`.
    ///
    /// Cancellation is filtered out. Every fetch on the chat surface is driven
    /// by a `.task(id: threadID)` modifier, and SwiftUI cancels those bodies on
    /// each identity change; selecting a freshly created thread is exactly such
    /// a change. The in-flight timeline/diff/checkpoint RPCs then throw
    /// `CancellationError`, which used to land in `lastError` and greet the new
    /// thread with a "CancellationError()" banner over its composer. A cancelled
    /// request is ordinary navigation, and the caller that superseded it will
    /// report anything that genuinely fails.
    public func report(_ error: Error) {
        guard !error.isCancellation else { return }
        lastError = String(describing: error)
    }

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
    /// Settings edits are optimistic and arrive from independent SwiftUI
    /// controls. Serialize their server writes in invocation order: guarding
    /// only the response assignment still allowed an older full-settings
    /// snapshot to reach the server last and restore the previous model.
    @ObservationIgnored private var settingsSaveTail: Task<Void, Never>?
    @ObservationIgnored private var archivedThreadsRefreshToken = UUID()
    /// Serializes `loadMoreArchivedThreads` so double-taps can't interleave
    /// pages or duplicate entries.
    @ObservationIgnored private var archivedThreadsLoadMoreInFlight = false
    /// Threads with an in-flight `settleThread` dispatch from the merged/closed
    /// PR observer — prevents duplicate settles while the server round-trips.
    @ObservationIgnored private var prSettleInFlightThreadIDs: Set<String> = []
    /// Launch sweep (PRs merged while the app was closed) runs once per process.
    @ObservationIgnored private var didRunClosedPrSettleSweep = false
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
    /// Direct lookup used by timeline row context (project root for file
    /// links). Keys are local thread ids or device-scoped remote thread ids,
    /// matching `scopedThreadKey(_:)`.
    @ObservationIgnored private var projectPathByThreadKey: [String: String] = [:]

    /// Owns the model picker's most-recently-used list, updated here rather
    /// than at the tap so a switch the backend rejected never enters it.
    /// Internal rather than injected through `init`, which is public and
    /// cannot take an internal type; tests point it at scratch defaults.
    @ObservationIgnored var modelPickerPreferences: ModelPickerPreferences = .shared

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
                // In-place content updates (task progress, reasoning text, tool
                // detail while still running) must not bump structureVersion.
                // Treating every upsert as structural forced a full transcript
                // regroup/diff per event, which starved LazyVStack layout until
                // the chat appeared blank. New rows and tool running↔finished
                // flips still bump structure — those can change grouping shape.
                let existingIndex = indexByThread[threadID]?[item.id]
                let previousRunning: Bool?
                if let existingIndex, items.indices.contains(existingIndex),
                    items[existingIndex].id == item.id,
                    case .toolEvent(_, _, _, _, let status, _, _, _) = items[existingIndex]
                {
                    previousRunning = status == .running
                } else {
                    previousRunning = nil
                }
                items.upsertTimelineItem(item, indexByID: &indexByThread[threadID]!)
                touched[threadID] = items
                if Self.timelineAppendIsStructural(
                    item: item, existed: existingIndex != nil, previousRunning: previousRunning)
                {
                    structuralThreads.insert(threadID)
                }
                recordInteraction(item, threadID: threadID)
            case .timelineReset(let threadID, let items):
                // A snapshot can truncate or replace an in-flight message;
                // the old settled prefix is no longer valid for this thread.
                StreamingMarkdownCache.evict(threadID: scopedThreadKey(threadID))
                StreamingRevealStore.evict(threadID: scopedThreadKey(threadID))
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
            // Update in place: `updatedAt` bumps on every activity while a
            // thread runs, so resorting here made sidebar rows jump around
            // mid-conversation. Order is recomputed only on refreshAll.
            // When only `updatedAt` changed, skip the array write entirely —
            // rewriting threads[index] invalidates every sidebar row — and
            // stash the fresh timestamp for insertion-position searches.
            let previousStatus: ThreadStatus?
            let previousStalled: Bool
            if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                previousStatus = threads[index].status
                previousStalled = threads[index].isStalled
                let existing = threads[index]
                if existing.displayEquivalent(to: thread) {
                    effectiveUpdatedAt[thread.id] = thread.updatedAt
                } else {
                    threads[index] = thread
                    effectiveUpdatedAt[thread.id] = nil
                }
            } else {
                previousStatus = nil
                previousStalled = false
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
            considerAgentNotification(
                previousStatus: previousStatus,
                previousStalled: previousStalled,
                thread: thread)
            clearPlanProgressOnSettle(previousStatus: previousStatus, thread: thread)
            updateProjectPathIndex(for: thread)
            // No VCS event fires when a watched PR's thread merely goes
            // idle — re-evaluate the cached merged/closed state so the
            // settle still gets persisted once the session finishes.
            persistSettleForClosedPullRequest(threadID: thread.id)
        case .threadRemoved(let id):
            threads.removeAll { $0.id == id }
            if pinnedThreadIDs.remove(id) != nil {
                persistPinnedThreadIDs()
            }
            // Cancel usage-limit resume tasks BEFORE dropping the thread's
            // state: cancellation discovers the pending notice ids from
            // `threadStates[id].timeline`, so after the clear it would find
            // nothing and the scheduled resume would fire on a deleted thread.
            cancelUsageLimitResumeTasks(threadID: id)
            // ThreadState owns the in-memory composer draft, so removing the
            // child also drops that thread's text and staged attachments.
            threadStates[id] = nil
            effectiveUpdatedAt[id] = nil
            recentlySelected.removeAll { $0 == id }
            queuedMessagesByThread[id] = nil
            queuedSendInFlightThreadIDs.remove(id)
            queuedRetryTokensByThread[id] = nil
            projectPathByThreadKey[scopedThreadKey(id)] = nil
            if composerPrefill?.threadID == id { composerPrefill = nil }
            // Per-thread intake bookkeeping the old handler missed: stale
            // load tokens, the streaming-index cursor, git outcome, and any
            // interaction routes pointing at this id.
            reviewDiffLoadTokens[id] = nil
            reviewDiffErrorByThread[id] = nil
            refreshDiffTokens[id] = nil
            refreshCheckpointsTokens[id] = nil
            streamingIndex[id] = nil
            lastGitActionOutcomeByThread[id] = nil
            cancelledTurnStartByThread[id] = nil
            interactionThreadByID = interactionThreadByID.filter { $0.value != id }
            pruneTimelineTasks.removeValue(forKey: id)?.cancel()
            TimelineDisplayCache.evict(threadID: scopedThreadKey(id))
            RunTapeCache.evict(threadID: scopedThreadKey(id))
            ChatTurnRailCache.evict(threadID: scopedThreadKey(id))
            StreamingMarkdownCache.evict(threadID: scopedThreadKey(id))
            StreamingRevealStore.evict(threadID: scopedThreadKey(id))
            if selectedThreadID == id { selectedThreadID = nil }
        case .approvalRequested(let request):
            considerApprovalNotification(request)
        case .userInputRequested(let request):
            considerUserInputNotification(request)
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
            persistSettleForClosedPullRequest(threadID: threadID)
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

    /// Persists a server-side settle when the cached VCS status shows the
    /// thread's PR merged/closed. The "settled because PR merged" inbox rule
    /// is otherwise computed from in-memory VCS state only, so it vanished on
    /// every relaunch; an explicit settle survives in the server's
    /// `settledOverride` column. Never overrides a user pin (either
    /// "settled" or "active") and mirrors the server's settle validation
    /// (`canSettle`), so a thread with a live session or pending interaction
    /// is left alone until a later upsert re-evaluates it.
    private func persistSettleForClosedPullRequest(threadID: String) {
        guard let status = threadStates[threadID]?.vcsStatus,
            status.prState == .merged || status.prState == .closed,
            let thread = threads.first(where: { $0.id == threadID }),
            thread.status != .archived,
            thread.settledOverride == nil,
            ThreadInboxSemantics.canSettle(thread),
            !prSettleInFlightThreadIDs.contains(threadID)
        else { return }
        prSettleInFlightThreadIDs.insert(threadID)
        // Fire-and-forget: the successful settle echoes back as a thread
        // upsert with settledOverride == "settled", which self-limits further
        // dispatches once the in-flight guard clears.
        Task {
            try? await backend.settleThread(id: threadID)
            prSettleInFlightThreadIDs.remove(threadID)
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

    /// Whether a timeline upsert can change grouped-display shape.
    /// New rows always can. Existing subagent/reasoning content updates never
    /// do. Existing tools only do when running-ness flips (condensability).
    static func timelineAppendIsStructural(
        item: TimelineItem, existed: Bool, previousRunning: Bool?
    ) -> Bool {
        if !existed { return true }
        switch item {
        case .subagentTask, .reasoning, .assistantMessage, .compaction:
            return false
        case .toolEvent(_, _, _, _, let status, _, _, _):
            let nowRunning = status == .running
            if let previousRunning, previousRunning == nowRunning {
                return false
            }
            return true
        default:
            return true
        }
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
            let previousByID = Dictionary(
                uniqueKeysWithValues: self.threads.map {
                    ($0.id, (status: $0.status, stalled: $0.isStalled))
                })
            let refreshedThreads = try await threads.sorted { $0.updatedAt > $1.updatedAt }
            self.projects = try await projects
            self.threads = refreshedThreads
            rebuildProjectPathIndex()
            let liveThreadIDs = Set(refreshedThreads.map(\.id))
            // An empty refresh is not evidence that the pinned threads are
            // gone: the `.connection(.ready)` refresh races the first shell
            // snapshot, so a cold launch legitimately sees zero threads and
            // would otherwise persist an empty pin set forever.
            if !refreshedThreads.isEmpty,
                pinnedThreadIDs.intersection(liveThreadIDs) != pinnedThreadIDs
            {
                pinnedThreadIDs.formIntersection(liveThreadIDs)
                persistPinnedThreadIDs()
            }
            self.providers = try await providers
            let refreshedModels = try await models
            self.models = refreshedModels
            self.modelDisplayNames = Self.makeModelDisplayNames(from: refreshedModels)
            self.effectiveUpdatedAt.removeAll(keepingCapacity: true)
            for thread in refreshedThreads {
                let previous = previousByID[thread.id]
                if shouldSendQueuedMessage(
                    previousStatus: previous?.status, newStatus: thread.status)
                {
                    dequeueNextQueuedMessageIfNeeded(threadID: thread.id)
                }
                // Only notify on refresh when we already knew the thread —
                // a full reconnect snapshot must not spam every settled turn.
                if let previous {
                    considerAgentNotification(
                        previousStatus: previous.status,
                        previousStalled: previous.stalled,
                        thread: thread)
                }
            }
            // The archive list loads on demand when its settings tab appears
            // (ArchiveSettingsTab's .task) — not on every app refresh.
            // Arm the one-shot sweep only once a refresh actually carried
            // threads — the launch refresh races the shell snapshot, so an
            // empty one would burn the single attempt on no candidates.
            if !didRunClosedPrSettleSweep, !refreshedThreads.isEmpty {
                didRunClosedPrSettleSweep = true
                Task { await sweepClosedPullRequestSettles() }
            }
        } catch {
            report(error)
        }
    }

    /// One-shot launch sweep: threads whose PR merged/closed while the app
    /// was closed have no in-memory VCS status, so the merged-PR inbox rule
    /// can't see them and they resurface as active. Refresh each candidate's
    /// status once — sequentially, to avoid a git-fetch storm at launch —
    /// and let each resulting `.vcsStatusChanged` flow through
    /// `persistSettleForClosedPullRequest`, which settles server-side.
    /// Threads the inactivity rule already settles are skipped: their
    /// placement survives relaunch without a persisted override.
    private func sweepClosedPullRequestSettles() async {
        let candidates = threads.filter {
            $0.status != .archived
                && $0.settledOverride == nil
                && ThreadInboxSemantics.canSettle($0)
                && !ThreadInboxSemantics.effectiveSettled($0)
        }
        for thread in candidates {
            try? await backend.refreshVcsStatus(threadID: thread.id)
        }
    }

    public func refreshModels() async {
        do {
            let refreshedModels = try await backend.models()
            models = refreshedModels
            modelDisplayNames = Self.makeModelDisplayNames(from: refreshedModels)
        } catch {
            report(error)
        }
    }

    /// Returns the project path for a scoped thread key in O(1) time.
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
        guard !state.hasLoadedTimeline else { return }
        state.isLoadingTimeline = true
        defer { state.isLoadingTimeline = false }
        do {
            let items = try await backend.timeline(threadID: threadID)
            let filtered = items.filter { !isDismissedUsageLimit($0) }
            state.timeline = filtered
            state.timelineVersion += 1
            state.structureVersion += 1
            state.hasLoadedTimeline = true
            for item in filtered {
                recordInteraction(item, threadID: threadID)
            }
        } catch LiveBackendError.timelineClosed {
            // Evicted by the LRU prune (or the thread was removed) while the
            // first snapshot was in flight — ordinary navigation, not a
            // failure worth a global error banner.
        } catch {
            report(error)
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
            report(error)
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
            report(error)
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
        reviewDiffErrorByThread[threadID] = nil
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
        reviewDiffErrorByThread[threadID] = nil
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
            reviewDiffErrorByThread[threadID] = nil
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
            // A superseded load is not a failure to show — see `report(_:)`.
            guard !error.isCancellation else { return }
            // The review pane is the only surface for this one — review mode
            // hides the composer — so it gets the readable form, not the enum.
            let message = Self.revertErrorMessage(error)
            lastError = message
            // Leave `reviewDiff` alone: a failed `.diffInvalidated` reload must
            // not blank a diff the user is reading, and an empty array here is
            // indistinguishable from a scope with no changes.
            reviewDiffErrorByThread[threadID] = message
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

    /// Resolves a persisted chat attachment to a loadable image URL
    /// (`assets.createUrl`). Callers should treat the URL as short-lived.
    public func attachmentImageURL(id: String) async throws -> URL {
        try await backend.attachmentImageURL(id: id)
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
            report(error)
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
            // Edit/resend reverts before it sends, so this path also carries
            // `revertFailed`.
            lastError = Self.revertErrorMessage(error)
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
                if case .userMessage(let id, _, _, _) = $0 { return id == messageID }
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
            guard case .userMessage(let id, _, _, _) = item else { continue }
            if id == messageID { return index }
            index += 1
        }
        return nil
    }

    private func threadStatus(for threadID: String) -> ThreadStatus? {
        threads.first { $0.id == threadID }?.status
    }

    private func projectName(for thread: ChatThread) -> String? {
        projects.first { $0.id == thread.projectID }?.name
    }

    private func projectName(forThreadID threadID: String) -> String? {
        threads.first { $0.id == threadID }.flatMap { projectName(for: $0) }
    }

    /// A plan belongs to the turn that produced it. `turn.plan.updated` only
    /// ever carries steps — there is no "plan cleared" event — so without
    /// this, a finished plan stays in thread state and the next turn opens
    /// showing the previous turn's steps (usually a full "Plan complete"
    /// bar) until, or unless, a new plan lands.
    ///
    /// Cleared on the settle edge rather than the start edge on purpose: a
    /// `turn.plan.updated` that races just ahead of the `running` upsert must
    /// survive, and by the time a turn settles nothing renders the progress
    /// any more (the rail is mounted for live turns only).
    ///
    /// The edge is `isSettled`, not `isLiveTurn`: a turn that pauses on an
    /// approval or an input request leaves the live statuses but is not over,
    /// and its plan has to come back with it.
    private func clearPlanProgressOnSettle(previousStatus: ThreadStatus?, thread: ChatThread) {
        guard let previousStatus, !previousStatus.isSettled, thread.status.isSettled else {
            return
        }
        threadStates[thread.id]?.planProgress = nil
    }

    private func considerAgentNotification(
        previousStatus: ThreadStatus?,
        previousStalled: Bool,
        thread: ChatThread
    ) {
        AgentNotificationService.shared.considerThreadTransition(
            previousStatus: previousStatus,
            previousStalled: previousStalled,
            thread: thread,
            projectName: projectName(for: thread),
            deviceID: deviceID,
            selectedThreadID: selectedThreadID)
    }

    private func considerApprovalNotification(_ request: ApprovalRequest) {
        let thread = threads.first { $0.id == request.threadID }
        AgentNotificationService.shared.considerApproval(
            request: request,
            thread: thread,
            projectName: thread.flatMap { projectName(for: $0) }
                ?? projectName(forThreadID: request.threadID),
            deviceID: deviceID,
            selectedThreadID: selectedThreadID)
    }

    private func considerUserInputNotification(_ request: UserInputRequest) {
        let thread = threads.first { $0.id == request.threadID }
        AgentNotificationService.shared.considerUserInput(
            request: request,
            thread: thread,
            projectName: thread.flatMap { projectName(for: $0) }
                ?? projectName(forThreadID: request.threadID),
            deviceID: deviceID,
            selectedThreadID: selectedThreadID)
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
    /// providers cannot be selected and then fail with `noProviderForKind`.
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
    /// one whose token has not been entered yet) with a disabled action and
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
            report(error)
            return nil
        }
    }

    public func respond(to approval: ApprovalRequest, decision: ApprovalDecision) async {
        do {
            try await backend.respondToApproval(id: approval.id, decision: decision)
        } catch {
            report(error)
        }
    }

    public func respond(to request: UserInputRequest, answers: [String: [String]]) async {
        do {
            try await backend.respondToUserInput(id: request.id, answers: answers)
        } catch {
            report(error)
        }
    }

    public func setRuntimeMode(_ mode: ThreadRuntimeMode) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setRuntimeMode(threadID: threadID, mode: mode)
        } catch {
            report(error)
        }
    }

    public func setInteractionMode(_ mode: ThreadInteractionMode) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setInteractionMode(threadID: threadID, mode: mode)
        } catch {
            report(error)
        }
    }

    public func setExecutorModel(instanceID: String?, modelID: String?, maxSubAgents: Int? = nil) async {
        guard let threadID = selectedThreadID else { return }
        // Resolved before the await: a provider reconnect or catalog refresh
        // landing mid-flight would otherwise drop a switch the backend
        // accepted out of the recents list. Nil ids are a clear, not a
        // selection, so they record nothing.
        let requested = ModelPickerCatalog.selectedOption(
            in: models, instanceID: instanceID, modelID: modelID)
        do {
            try await backend.setExecutorModel(
                threadID: threadID, instanceID: instanceID, modelID: modelID,
                maxSubAgents: maxSubAgents)
            if let requested {
                modelPickerPreferences.recordUsage(for: requested)
            }
        } catch {
            report(error)
        }
    }

    public func setModel(_ model: ModelOption) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setModel(threadID: threadID, model: model)
            // Recorded only once the backend accepted the switch: a failed or
            // rejected change must not promote the model in the picker.
            modelPickerPreferences.recordUsage(for: model)
        } catch {
            report(error)
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
                modelPickerPreferences.recordUsage(for: model)
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

    /// Recovery action on a failed/canceled context compaction: start a fresh
    /// thread in the same project with the same provider and select it, since
    /// the compacted transcript can no longer be trusted to continue.
    @discardableResult
    public func startNewThread(afterFailedCompaction notice: CompactionNotice) async -> ChatThread? {
        guard let source = threads.first(where: { $0.id == notice.threadID }) else { return nil }
        guard let thread = await createThread(
            projectID: source.projectID, provider: source.provider)
        else { return nil }
        selectedThreadID = thread.id
        return thread
    }

    public func setReasoningEffort(_ value: String) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setReasoningEffort(threadID: threadID, value: value)
        } catch {
            report(error)
        }
    }

    public func setServiceTier(_ value: String) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.setServiceTier(threadID: threadID, value: value)
        } catch {
            report(error)
        }
    }

    public func implementPlan(_ plan: ProposedPlan) async {
        do {
            try await backend.implementPlan(threadID: plan.threadID, planID: plan.id)
        } catch {
            report(error)
        }
    }

    public func cancelCurrentTurn() async {
        guard let threadID = selectedThreadID else { return }
        noteCancelRequested(threadID: threadID)
        do {
            try await backend.cancelTurn(threadID: threadID)
        } catch {
            report(error)
        }
    }

    /// Start stamp of a turn the user asked to stop, per thread.
    ///
    /// A cancelled run still settles to `idle`, which is indistinguishable
    /// from a completed one by status alone. Recording *which* turn was
    /// stopped lets the UI tell the two apart, and a later turn carries a
    /// newer start stamp, so the record expires on its own instead of
    /// silencing every future completion on that thread.
    public private(set) var cancelledTurnStartByThread: [String: Date] = [:]

    private func noteCancelRequested(threadID: String) {
        cancelledTurnStartByThread[threadID] =
            thread(threadID: threadID)?.latestTurnStartedAt ?? .distantPast
    }

    /// Whether `thread`'s current turn is the one the user asked to stop.
    public func isCancellationPending(for thread: ChatThread) -> Bool {
        guard let cancelled = cancelledTurnStartByThread[thread.id] else { return false }
        return (thread.latestTurnStartedAt ?? .distantPast) == cancelled
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
            lastError = Self.revertErrorMessage(error)
        }
    }

    /// `LiveBackendError` is not a `LocalizedError`, so a failed revert would
    /// otherwise reach the user as `revertFailed("Timed out waiting…")`. Its
    /// payload is already a written-for-humans sentence — show only that.
    /// Best readable text for an error the user will see with no other
    /// context. `String(describing:)` renders an enum case verbatim —
    /// `diffFailed("The sidecar closed the connection.")` — so prefer a
    /// `LocalizedError`'s own sentence, and unwrap `revertFailed`, which
    /// carries its message but does not conform.
    private static func revertErrorMessage(_ error: any Error) -> String {
        if case LiveBackendError.revertFailed(let message) = error { return message }
        if let localized = error as? any LocalizedError,
            let description = localized.errorDescription
        {
            return description
        }
        return String(describing: error)
    }

    public func addProject(path: String) async {
        do {
            _ = try await backend.addProject(path: path, createWorkspaceRootIfMissing: false)
            await refreshAll()
        } catch {
            report(error)
        }
    }

    /// Prefer the provider of the most recently updated active thread when it
    /// is still runnable; otherwise the first runnable provider.
    public var preferredQuickChatProvider: ProviderKind? {
        let runnable = runnableProviderKinds
        guard !runnable.isEmpty else { return nil }
        if let lastUsed = threads.max(by: { $0.updatedAt < $1.updatedAt }),
            runnable.contains(lastUsed.provider)
        {
            return lastUsed.provider
        }
        return runnable.first
    }

    /// Reuse or create the host-local General project at
    /// `GeneralWorkspace.resolvedPath`.
    public func ensureGeneralProject() async -> Project? {
        let path = GeneralWorkspace.resolvedPath
        if let existing = projects.first(where: { GeneralWorkspace.pathsMatch($0.path, path) }) {
            return existing
        }
        do {
            let project = try await backend.addProject(
                path: path, createWorkspaceRootIfMissing: true)
            // Prefer the server-normalized list when available; fall back to
            // the create response so callers can proceed immediately.
            await refreshAll()
            if let refreshed = projects.first(where: { GeneralWorkspace.pathsMatch($0.path, path) })
            {
                return refreshed
            }
            if !projects.contains(where: { $0.id == project.id }) {
                projects.append(project)
            }
            return project
        } catch {
            report(error)
            return nil
        }
    }

    /// One-click general session: ensure General workspace, last-used provider,
    /// scene-named thread. Local Mac only.
    @discardableResult
    public func startQuickChat(scenery: SceneryStore) async -> ChatThread? {
        guard capabilities.canBrowseLocalFolders else {
            lastError = "Quick Chat is only available on this Mac."
            return nil
        }
        guard let provider = preferredQuickChatProvider else {
            lastError = "No providers are ready. Open Settings ▸ Providers and refresh."
            return nil
        }
        guard let project = await ensureGeneralProject() else { return nil }
        return await createSceneThread(
            projectID: project.id,
            provider: provider,
            scenery: scenery)
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
            report(error)
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
            report(error)
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
            report(error)
        }
    }

    /// Returns false only when this save was still the newest one AND it
    /// failed, which is the signal the Settings tabs use to roll their
    /// optimistic draft back. A superseded save returns true even if it threw:
    /// a stale failure must never clobber a newer draft.
    ///
    /// Deliberately NOT `@discardableResult`: every caller writes an optimistic
    /// draft first, so one that drops the result leaves the UI showing a value
    /// the server rejected.
    ///
    /// That alone does not catch the case that actually slipped through —
    /// `Task { await model.saveSettings(next) }` is a single-expression
    /// closure, so the `Bool` becomes the task's return type and is never
    /// "unused". `SettingsSaveHandlingTests` covers that shape by scanning the
    /// call sites directly.
    public func saveSettings(_ new: AppSettings) async -> Bool {
        settingsSaveToken += 1
        let token = settingsSaveToken
        let previous = settingsSaveTail
        let operation = Task { @MainActor [backend] () -> Result<AppSettings, Error> in
            await previous?.value
            do {
                return .success(try await backend.updateSettings(new))
            } catch {
                return .failure(error)
            }
        }
        settingsSaveTail = Task {
            _ = await operation.value
        }

        switch await operation.value {
        case .success(let updated):
            guard token == settingsSaveToken else { return true }
            settings = updated
            return true
        case .failure(let error):
            guard token == settingsSaveToken else { return true }
            lastError = Self.settingsErrorMessage(error)
            return false
        }
    }

    /// RPC failures are Effect cause trees. `String(describing:)` expands the
    /// entire tree (including schema ASTs) into the "massive error" users saw
    /// after a rejected picker change. Keep the useful tag/message and leave
    /// the transport detail in logs.
    private static func settingsErrorMessage(_ error: Error) -> String {
        guard let t3Error = error as? T3Error, case .rpc(let failure) = t3Error else {
            return "Couldn’t save settings: \(error.localizedDescription)"
        }
        return failure.userFacingMessage ?? "The server rejected the settings change."
    }

    public private(set) var autoReviewJobs: [AppAutoReviewJob] = []

    public func refreshAutoReviewJobs(projectID: String? = nil) async {
        do {
            autoReviewJobs = try await backend.listAutoReviewJobs(projectID: projectID, limit: 30)
        } catch {
            report(error)
        }
    }

    public func refreshProviders() async {
        do {
            try await backend.refreshProviders()
        } catch {
            report(error)
        }
    }

    public func updateProvider(instanceID: String) async {
        do {
            try await backend.updateProvider(instanceID: instanceID)
        } catch {
            report(error)
        }
    }

    // MARK: - Workspace files

    public func listWorkspace(subpath: String) async -> [WorkspaceEntry] {
        guard let threadID = selectedThreadID else { return [] }
        do {
            return try await backend.listWorkspace(threadID: threadID, subpath: subpath)
        } catch {
            report(error)
            return []
        }
    }

    public func readWorkspaceFile(path: String) async -> FilePreview? {
        guard let threadID = selectedThreadID else { return nil }
        do {
            return try await backend.readWorkspaceFile(threadID: threadID, path: path)
        } catch {
            report(error)
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
            report(error)
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
            report(error)
            return []
        }
    }

    public func switchBranch(_ name: String) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.switchBranch(threadID: threadID, name: name)
        } catch {
            report(error)
        }
    }

    public func createBranch(_ name: String) async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.createBranch(threadID: threadID, name: name)
        } catch {
            report(error)
        }
    }

    public func pull() async {
        guard let threadID = selectedThreadID else { return }
        do {
            try await backend.pull(threadID: threadID)
        } catch {
            report(error)
        }
    }

    public func runGitAction(_ action: GitAction, commitMessage: String?) async {
        guard let threadID = selectedThreadID else { return }
        do {
            let outcome = try await backend.runGitAction(
                threadID: threadID, action: action, commitMessage: commitMessage)
            lastGitActionOutcomeByThread[threadID] = outcome
            if action == .mergePR, outcome.success {
                mergeCelebration = MergeCelebration(title: outcome.title)
            }
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

    /// Page size for the Archive settings tab.
    static let archivedThreadsPageSize = 50

    /// Reloads the FIRST archived page, replacing the list. Cheap enough to
    /// run after every archive/unarchive/delete mutation.
    public func refreshArchivedThreads() async {
        let token = UUID()
        archivedThreadsRefreshToken = token
        archivedThreadsLoading = true
        archivedThreadsError = nil
        do {
            let page = try await backend.archivedThreadsPage(
                cursor: nil, limit: Self.archivedThreadsPageSize)
            guard archivedThreadsRefreshToken == token else { return }
            archivedThreads = page.threads
            archivedThreadsTotal = page.total
            archivedThreadsNextCursor = page.nextCursor
            archivedThreadsLoading = false
        } catch {
            guard archivedThreadsRefreshToken == token else { return }
            archivedThreadsLoading = false
            archivedThreadsError = String(describing: error)
        }
    }

    /// Appends the next archived page. A refresh racing the fetch invalidates
    /// the result via the shared refresh token; the in-flight flag keeps
    /// duplicate triggers from interleaving pages.
    public func loadMoreArchivedThreads() async {
        guard let cursor = archivedThreadsNextCursor, !archivedThreadsLoadMoreInFlight
        else { return }
        let token = archivedThreadsRefreshToken
        archivedThreadsLoadMoreInFlight = true
        archivedThreadsLoading = true
        defer { archivedThreadsLoadMoreInFlight = false }
        do {
            let page = try await backend.archivedThreadsPage(
                cursor: cursor, limit: Self.archivedThreadsPageSize)
            guard archivedThreadsRefreshToken == token else { return }
            let loadedIDs = Set(archivedThreads.map(\.id))
            archivedThreads.append(contentsOf: page.threads.filter { !loadedIDs.contains($0.id) })
            archivedThreadsTotal = page.total
            archivedThreadsNextCursor = page.nextCursor
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
            // Archiving upserts the thread as `.archived` rather than removing
            // it, so the `threadRemoved` selection cleanup never runs — but the
            // sidebar filters archived rows out, leaving the selection pointing
            // at a row that no longer exists.
            if selectedThreadID == thread.id { selectedThreadID = nil }
            await releaseTimeline(threadID: thread.id)
            await refreshArchivedThreads()
        } catch {
            report(error)
        }
    }

    /// Archives several threads in one go (e.g. every settled session of a
    /// project). Unlike repeated `archiveThread` calls, the archived list is
    /// refreshed once at the end instead of after every thread, and one
    /// failure does not stop the rest.
    public func archiveThreads(_ threads: [ChatThread]) async {
        var failures = 0
        var firstError: String?
        var archivedIDs: Set<String> = []
        for thread in threads {
            do {
                try await backend.archiveThread(id: thread.id)
                archivedIDs.insert(thread.id)
                await releaseTimeline(threadID: thread.id)
            } catch {
                failures += 1
                if firstError == nil { firstError = String(describing: error) }
            }
        }
        // Only drop the selection if the selected thread actually archived —
        // its sidebar row is gone (archived rows are filtered out), while a
        // failed archive keeps its row and must keep the selection.
        if let selected = selectedThreadID, archivedIDs.contains(selected) {
            selectedThreadID = nil
        }
        await refreshArchivedThreads()
        if let firstError {
            lastError =
                failures == threads.count
                ? firstError
                : "Failed to archive \(failures) of \(threads.count) sessions: \(firstError)"
        }
    }

    public func unarchiveThread(_ thread: ChatThread) async {
        do {
            try await backend.unarchiveThread(id: thread.id)
            await refreshArchivedThreads()
        } catch {
            report(error)
        }
    }

    public func settleThread(_ thread: ChatThread) async {
        do {
            try await backend.settleThread(id: thread.id)
        } catch {
            report(error)
        }
    }

    public func unsettleThread(_ thread: ChatThread) async {
        do {
            try await backend.unsettleThread(id: thread.id)
        } catch {
            report(error)
        }
    }

    public func deleteThread(_ thread: ChatThread) async {
        do {
            try await backend.deleteThread(id: thread.id)
            await releaseTimeline(threadID: thread.id)
            await refreshArchivedThreads()
        } catch {
            report(error)
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
        await backend.closeTimeline(threadID: threadID)
        if let state = threadStates[threadID] {
            trimRetainedTimelineIfNeeded(state)
            state.hasLoadedTimeline = false
        }
        // Stale-while-revalidate: keep the TimelineDisplayCache entry so a
        // re-select renders the retained snapshot instantly; only streaming
        // parse sessions are dropped.
        StreamingMarkdownCache.evict(threadID: scopedThreadKey(threadID))
        StreamingRevealStore.evict(threadID: scopedThreadKey(threadID))
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
                    if let state = self.threadStates[threadID] {
                        self.trimRetainedTimelineIfNeeded(state)
                        state.hasLoadedTimeline = false
                    }
                    // Stale-while-revalidate: keep the display cache (see
                    // releaseTimeline); only streaming parse sessions drop.
                    StreamingMarkdownCache.evict(threadID: self.scopedThreadKey(threadID))
                    StreamingRevealStore.evict(threadID: self.scopedThreadKey(threadID))
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
}

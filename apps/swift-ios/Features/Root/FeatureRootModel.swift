import Foundation
import Observation

enum FeatureDetailRenderChange: Equatable {
    case full
    case delta(FeatureDetailDelta)
}

struct FeatureDetailRenderUpdate: Equatable {
    let baseRevision: UInt64
    let revision: UInt64
    let change: FeatureDetailRenderChange
}

@MainActor
@Observable
public final class FeatureRootModel {
    private static let maximumRetainedThreadDetails = 6

    public private(set) var snapshot = FeatureSnapshot()
    public private(set) var details: [String: FeatureThreadDetail] = [:]
    /// Advances whenever a Home presentation input changes.
    public private(set) var homePresentationRevision: UInt64 = 0
    /// Advances when a Home-visible thread is inserted, removed, or changed.
    public private(set) var threadCollectionRevision: UInt64 = 0
    /// Advances for any selected-thread metadata, message, approval, or input change.
    public private(set) var detailRevision: UInt64 = 0
    /// The latest detail revision for each loaded thread.
    public private(set) var detailRevisions: [String: UInt64] = [:]
    private(set) var detailRenderUpdates: [String: FeatureDetailRenderUpdate] = [:]
    public private(set) var isLoading = true
    public private(set) var isPerformingAction = false
    public private(set) var isManagingConnections = false
    public var errorMessage: String?

    let client: any FeatureClient
    private let outboxStore: FeatureOutboxStore
    private var pendingSubmissionsByID: [String: FeatureQueuedSubmission] = [:]
    private var pendingThreadsByID: [String: FeatureThread] = [:]
    private var pendingCompletionSubmissionIDs: Set<String> = []
    private var pendingDiscardSubmissionIDs: Set<String> = []
    private var detailRecency: [String] = []
    private var outboxDrainTask: Task<Void, Never>?
    private var outboxRetryAttempt = 0
    private var outboxGeneration: UInt64 = 0

    public init(
        client: any FeatureClient,
        outboxStore: FeatureOutboxStore = .shared
    ) {
        self.client = client
        self.outboxStore = outboxStore
    }

    public func start() async {
        do {
            install(try await client.initialSnapshot())
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
        await restoreOutbox()
        isLoading = false
        scheduleOutboxDrain()

        for await event in client.events() {
            apply(event)
        }
    }

    public func reload() async {
        do {
            install(try await client.initialSnapshot())
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Background refresh is deliberately separate from `reload()`: native
    /// clients must not mount WebSocket streams or timers for a bounded BG task.
    public func refreshInBackground() async -> Bool {
        do {
            install(try await client.backgroundSnapshot())
            return !Task.isCancelled
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    public func reloadAfterConnection() async {
        clearDetails()
        await reload()
    }

    public func pair(endpoint: String, token: String?) async -> Bool {
        await perform {
            try await client.pair(endpoint: endpoint, token: token)
            clearDetails()
            install(try await client.initialSnapshot())
        }
    }

    @discardableResult
    public func activateEnvironment(_ id: String) async -> Bool {
        await perform {
            try await client.activateEnvironment(id: id)
            install(try await client.initialSnapshot())
            clearDetails()
        }
    }

    public func removeEnvironment(_ id: String) async {
        await stopOutboxDrain()
        await perform {
            try await client.removeEnvironment(id: id)
            do {
                try await outboxStore.removeAll(environmentID: id)
                removePendingSubmissions(environmentID: id)
            } catch {
                markPendingSubmissionsForDiscard(environmentID: id)
                errorMessage = "Environment removed, but its queued messages could not be cleared: \(error.localizedDescription)"
            }
            install(try await client.initialSnapshot())
            clearDetails()
        }
        scheduleOutboxDrain()
    }

    public func disconnect() async {
        await stopOutboxDrain()
        isManagingConnections = false
        await client.disconnect()
        let disconnectedEnvironments = snapshot.environments.map { environment in
            var environment = environment
            environment.connectionState = .disconnected
            environment.connectionDetail = nil
            return environment
        }
        install(FeatureSnapshot(
            environments: disconnectedEnvironments,
            settings: snapshot.settings
        ))
        clearDetails()
    }

    public func setConnectionManagementPresented(_ isPresented: Bool) {
        isManagingConnections = isPresented
    }

    public func addProject(path: String) async -> Bool {
        await perform {
            try await client.addProject(path: path)
            install(try await client.initialSnapshot())
        }
    }

    public func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async -> FeatureThread? {
        let environment = currentEnvironmentIdentity
        var created: FeatureThread?
        let succeeded = await perform {
            let thread = try await client.createThread(
                projectID: projectID,
                title: title,
                selection: selection
            )
            guard currentEnvironmentIdentity == environment else {
                throw CancellationError()
            }
            upsert(thread)
            created = thread
        }
        return succeeded ? created : nil
    }

    public func startTask(_ request: NewTaskRequest) async -> FeatureThread? {
        let prompt = request.trimmedPrompt
        guard !prompt.isEmpty || !request.attachments.isEmpty else { return nil }
        guard request.workspaceMode != .worktree || request.branch != nil else { return nil }

        guard let project = snapshot.projects.first(where: { $0.id == request.projectID }) else {
            errorMessage = "That project is no longer available."
            return nil
        }
        let identity = FeatureSubmissionIdentity()
        let threadID = FeatureScopedID.thread(
            environmentID: project.environmentID,
            wireID: identity.threadID
        )
        let uploads = request.attachments.map(\.upload)
        let queued = FeatureQueuedSubmission(
            environmentID: project.environmentID,
            identity: identity,
            threadID: threadID,
            text: prompt,
            selection: request.selection,
            runtimeMode: request.runtimeMode,
            interactionMode: request.interactionMode,
            attachments: uploads,
            creation: FeatureQueuedCreation(
                projectID: request.projectID,
                projectName: project.name,
                workspaceMode: request.workspaceMode,
                branch: request.branch,
                worktreePath: request.worktreePath,
                startFromOrigin: request.startFromOrigin
            )
        )
        guard await enqueue(queued) else { return nil }
        installPendingCreation(queued, project: project)

        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            let thread = try await client.createThreadAndSend(
                projectID: request.projectID,
                prompt: prompt,
                selection: request.selection,
                runtimeMode: request.runtimeMode.mobileNormalized,
                interactionMode: request.interactionMode.mobileNormalized,
                workspaceMode: request.workspaceMode,
                branch: request.branch,
                worktreePath: request.worktreePath,
                startFromOrigin: request.startFromOrigin,
                attachments: uploads,
                identity: identity
            )
            if !(await completeQueuedSubmission(queued)) {
                scheduleOutboxRetry()
            }
            if thread.id != queued.threadID {
                removeThread(id: queued.threadID)
                removeDetail(id: queued.threadID)
            }
            upsert(thread)
            return thread
        } catch {
            if Self.shouldQueue(error, environmentID: project.environmentID, snapshot: snapshot) {
                if isEnvironmentConnected(project.environmentID) {
                    scheduleOutboxRetry()
                }
                return pendingThreadsByID[threadID]
            }
            let discarded = await discardQueuedSubmission(queued)
            if !discarded {
                scheduleOutboxRetry()
            }
            if discarded, !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return nil
        }
    }

    public func workspaceBranches(
        projectID: String,
        refresh: Bool = false
    ) async throws -> [FeatureWorkspaceBranch] {
        try await client.listWorkspaceBranches(projectID: projectID, refresh: refresh)
    }

    public func renameThread(_ id: String, title: String) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.renameThread(id: id, title: title)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.title = title }
        }
    }

    public func setArchived(_ id: String, archived: Bool) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadArchived(id: id, archived: archived)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.isArchived = archived }
        }
    }

    public func setSettled(_ id: String, settled: Bool) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadSettled(id: id, settled: settled)
            guard currentEnvironmentIdentity == environment else { return }
            let settledAt = settled ? Date.now : nil
            mutateThread(id: id) {
                $0.isSettled = settled
                $0.keepsActive = !settled
                $0.settledAt = settledAt
                if settled {
                    $0.pinnedAt = nil
                }
            }
        }
    }

    public func setSnoozed(_ id: String, until: Date?) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadSnoozed(id: id, until: until)
            guard currentEnvironmentIdentity == environment else { return }
            let snoozedAt = until.map { _ in Date.now }
            mutateThread(id: id) {
                $0.snoozedUntil = until
                $0.snoozedAt = snoozedAt
            }
        }
    }

    public func setPinned(_ id: String, pinned: Bool) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadPinned(id: id, pinned: pinned)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) {
                $0.pinnedAt = pinned ? Date.now : nil
                if pinned {
                    $0.snoozedUntil = nil
                    $0.snoozedAt = nil
                }
            }
        }
    }

    public func setRuntimeMode(_ id: String, mode: FeatureRuntimeMode) async {
        let mode = mode.mobileNormalized
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setRuntimeMode(id: id, mode: mode)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.runtimeMode = mode }
        }
    }

    public func setInteractionMode(_ id: String, mode: FeatureInteractionMode) async {
        let mode = mode.mobileNormalized
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setInteractionMode(id: id, mode: mode)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.interactionMode = mode }
        }
    }

    public func deleteThread(_ id: String) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.deleteThread(id: id)
            guard currentEnvironmentIdentity == environment else { return }
            removeThread(id: id)
            removeDetail(id: id)
        }
    }

    public func detail(for id: String, force: Bool = false) async -> FeatureThreadDetail? {
        if !force, let cached = details[id] {
            return cached
        }
        let environment = currentEnvironmentIdentity
        do {
            let detail = try await client.loadThread(id: id)
            guard currentEnvironmentIdentity == environment else {
                return details[id]
            }
            store(detail)
            upsert(detail.thread)
            return detail
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return details[id]
        }
    }

    public func loadEarlierTurns(for id: String) async {
        guard details[id]?.page?.hasMore == true,
              details[id]?.page?.isLoading != true else { return }
        let environment = currentEnvironmentIdentity
        do {
            guard let detail = try await client.loadEarlierThreadTurns(id: id),
                  currentEnvironmentIdentity == environment else { return }
            store(detail)
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Ends any selected-thread transport work when its detail view closes.
    public func releaseThread(_ id: String) {
        client.releaseThread(id: id)
        markDetailRecentlyUsed(id)
        evictOldThreadDetailsIfNeeded()
    }

    public func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async -> Bool {
        await sendMessage(
            FeatureMessageSubmission(
                threadID: threadID,
                text: text,
                selection: selection
            )
        )
    }

    public func sendMessage(_ submission: FeatureMessageSubmission) async -> Bool {
        let trimmed = submission.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !submission.attachments.isEmpty else { return false }

        guard let thread = snapshot.threads.first(where: { $0.id == submission.threadID }),
              let environmentID = thread.environmentID else {
            return false
        }
        let identity = FeatureSubmissionIdentity(threadID: thread.wireID ?? thread.id)
        let uploads = submission.attachments.map(\.upload)
        let queued = FeatureQueuedSubmission(
            environmentID: environmentID,
            identity: identity,
            threadID: submission.threadID,
            text: trimmed,
            selection: submission.selection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            attachments: uploads
        )
        guard await enqueue(queued) else { return false }

        let optimistic = FeatureMessage(
            id: identity.messageID,
            role: .user,
            text: trimmed,
            createdAt: identity.createdAt,
            state: .queued,
            attachments: submission.attachments.map {
                FeatureMessageAttachment(
                    id: $0.id.uuidString,
                    name: $0.filename,
                    mimeType: $0.mimeType,
                    sizeBytes: $0.byteCount,
                    previewData: $0.thumbnailData
                )
            }
        )
        mutateDetail(
            id: submission.threadID,
            change: .delta(FeatureDetailDelta(
                changedMessages: [optimistic],
                appendedMessageIDs: [optimistic.id]
            ))
        ) {
            $0.messages.append(optimistic)
        }

        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            try await client.sendMessage(
                threadID: submission.threadID,
                text: trimmed,
                selection: submission.selection,
                attachments: uploads,
                identity: identity
            )
            if !(await completeQueuedSubmission(queued)) {
                scheduleOutboxRetry()
            }
            return true
        } catch {
            if Self.shouldQueue(error, environmentID: environmentID, snapshot: snapshot) {
                if isEnvironmentConnected(environmentID) {
                    scheduleOutboxRetry()
                }
                return true
            }
            let discarded = await discardQueuedSubmission(queued)
            if !discarded {
                scheduleOutboxRetry()
            }
            if discarded, !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    public func cancelTurn(threadID: String) async {
        await perform {
            try await client.cancelTurn(threadID: threadID)
        }
    }

    public func resolveApproval(_ id: String, decision: FeatureApprovalDecision) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.resolveApproval(id: id, decision: decision)
            guard currentEnvironmentIdentity == environment else { return }
            // Only touch details that actually hold the request; mutateDetail
            // deep-compares each mutated detail and the cache never shrinks.
            for key in Array(details.keys)
                where details[key]?.approvals.contains(where: { $0.id == id }) == true {
                mutateDetail(
                    id: key,
                    change: .delta(FeatureDetailDelta(changedMessages: []))
                ) {
                    $0.approvals.removeAll { $0.id == id }
                }
            }
        }
    }

    public func resolveUserInput(_ id: String, answers: [String: FeatureInputAnswer]) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.resolveUserInput(id: id, answers: answers)
            guard currentEnvironmentIdentity == environment else { return }
            for key in Array(details.keys)
                where details[key]?.userInputs.contains(where: { $0.id == id }) == true {
                mutateDetail(
                    id: key,
                    change: .delta(FeatureDetailDelta(changedMessages: []))
                ) {
                    $0.userInputs.removeAll { $0.id == id }
                }
            }
        }
    }

    /// Convenience for callers that only submit free-form or single-select text.
    public func resolveUserInput(_ id: String, answers: [String: String]) async {
        await resolveUserInput(
            id,
            answers: answers.mapValues(FeatureInputAnswer.text)
        )
    }

    @discardableResult
    public func saveSettings(_ settings: FeatureSettings) async -> Bool {
        await perform {
            try await client.saveSettings(settings)
            snapshot.settings = settings
        }
    }

    /// Applies appearance optimistically so selecting a theme updates every
    /// surface immediately, then persists just that preference in the current
    /// settings snapshot. Other unsaved Settings edits remain drafts.
    @discardableResult
    public func saveAppearance(_ appearance: FeatureAppearance) async -> Bool {
        let previous = snapshot.settings
        guard previous.appearance != appearance else { return true }

        var updated = previous
        updated.appearance = appearance
        snapshot.settings = updated

        do {
            try await client.saveSettings(updated)
            return true
        } catch {
            if snapshot.settings == updated {
                snapshot.settings = previous
            }
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    @discardableResult
    private func perform(
        reportError: Bool = true,
        _ operation: () async throws -> Void
    ) async -> Bool {
        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            try await operation()
            return true
        } catch {
            if reportError, !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    private static func isBenignCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        let message = error.localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return message == "cancelled" || message == "canceled"
    }

    private var currentEnvironmentIdentity: String {
        let active = snapshot.environments.first(where: \.isActive)
        return [
            active?.id,
            active?.endpoint,
            snapshot.connection.endpoint,
        ]
        .compactMap { $0 }
        .joined(separator: "|")
    }

    private func apply(_ event: FeatureEvent) {
        switch event {
        case let .snapshot(value):
            install(value)
        case let .connection(value):
            guard snapshot.connection != value else { return }
            snapshot.connection = value
            homePresentationRevision &+= 1
            if value.state == .connected {
                scheduleOutboxDrain()
            }
        case let .thread(value):
            acknowledgeAuthoritativeThread(value.id)
            upsert(value)
            mutateDetail(
                id: value.id,
                change: .delta(FeatureDetailDelta(changedMessages: []))
            ) {
                $0.thread = value
            }
        case let .threadRemoved(id):
            removeThread(id: id)
            removeDetail(id: id)
        case let .detail(value):
            store(value)
            upsert(value.thread)
        case let .detailDelta(value, delta):
            store(value, delta: delta)
            upsert(value.thread)
        case let .failure(message):
            errorMessage = message
        }
    }

    private func upsert(_ thread: FeatureThread) {
        if let index = snapshot.threads.firstIndex(where: { $0.id == thread.id }) {
            let previous = snapshot.threads[index]
            guard previous != thread else { return }
            snapshot.threads[index] = thread
            if previous.projectID != thread.projectID {
                adjustProjectCount(id: previous.projectID, by: -1)
                adjustProjectCount(id: thread.projectID, by: 1)
            }
        } else {
            snapshot.threads.append(thread)
            adjustProjectCount(id: thread.projectID, by: 1)
        }
        threadCollectionRevision &+= 1
        homePresentationRevision &+= 1
    }

    private func removeThread(id: String) {
        guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
        let projectID = snapshot.threads[index].projectID
        snapshot.threads.remove(at: index)
        adjustProjectCount(id: projectID, by: -1)
        threadCollectionRevision &+= 1
        homePresentationRevision &+= 1
    }

    private func adjustProjectCount(id: String, by delta: Int) {
        guard let index = snapshot.projects.firstIndex(where: { $0.id == id }) else { return }
        snapshot.projects[index].threadCount = max(0, snapshot.projects[index].threadCount + delta)
    }

    private func install(_ value: FeatureSnapshot) {
        var value = value
        let authoritativeThreadIDs = Set(value.threads.map(\.id))
        for id in authoritativeThreadIDs {
            acknowledgeAuthoritativeThread(id)
        }
        for pending in pendingThreadsByID.values where !authoritativeThreadIDs.contains(pending.id) {
            value.threads.append(pending)
            if let index = value.projects.firstIndex(where: { $0.id == pending.projectID }) {
                value.projects[index].threadCount += 1
            }
        }

        if snapshot.connection != value.connection
            || snapshot.environments != value.environments
            || snapshot.projects != value.projects
            || snapshot.providers != value.providers
            || snapshot.providersByEnvironment != value.providersByEnvironment
            || snapshot.preferencesByEnvironment != value.preferencesByEnvironment
            || snapshot.threads != value.threads {
            homePresentationRevision &+= 1
        }
        if snapshot.threads != value.threads {
            threadCollectionRevision &+= 1
        }
        snapshot = value
        if value.connection.state == .connected
            || value.environments.contains(where: { $0.connectionState == .connected }) {
            scheduleOutboxDrain()
        }
    }

    private func mutateThread(
        id: String,
        _ mutation: (inout FeatureThread) -> Void
    ) {
        if let index = snapshot.threads.firstIndex(where: { $0.id == id }) {
            let previous = snapshot.threads[index]
            mutation(&snapshot.threads[index])
            if snapshot.threads[index] != previous {
                threadCollectionRevision &+= 1
                homePresentationRevision &+= 1
            }
        }
        mutateDetail(
            id: id,
            change: .delta(FeatureDetailDelta(changedMessages: []))
        ) {
            mutation(&$0.thread)
        }
    }

    private func store(_ incoming: FeatureThreadDetail) {
        let incoming = retainingLocalAttachmentPreviews(in: incoming)
        let id = incoming.thread.id
        acknowledgeDeliveredMessages(incoming.messages)
        let prepared = addingPendingMessages(to: incoming)
        let next = details[id].map { current in
            FeatureThreadDetail(
                thread: prepared.thread,
                messages: replacingChangedSuffix(current.messages, with: prepared.messages),
                approvals: replacingChangedSuffix(current.approvals, with: prepared.approvals),
                userInputs: replacingChangedSuffix(current.userInputs, with: prepared.userInputs),
                page: prepared.page
            )
        } ?? prepared
        guard details[id] != next else { return }
        details[id] = next
        markDetailRecentlyUsed(id)
        bumpDetailRevision(id: id, change: .full)
    }

    private func store(_ incoming: FeatureThreadDetail, delta: FeatureDetailDelta) {
        let incoming = retainingLocalAttachmentPreviews(in: incoming)
        let id = incoming.thread.id
        acknowledgeDeliveredMessages(incoming.messages)
        let next = addingPendingMessages(to: incoming)
        details[id] = next
        markDetailRecentlyUsed(id)
        let appended = next.messages.dropFirst(incoming.messages.count).map(\.id)
        let pendingDelta = FeatureDetailDelta(
            changedMessages: delta.changedMessages + next.messages.dropFirst(incoming.messages.count),
            appendedMessageIDs: delta.appendedMessageIDs + appended
        )
        bumpDetailRevision(id: id, change: .delta(pendingDelta))
    }

    private func mutateDetail(
        id: String,
        change: FeatureDetailRenderChange = .full,
        _ mutation: (inout FeatureThreadDetail) -> Void
    ) {
        guard var detail = details[id] else { return }
        let previous = detail
        mutation(&detail)
        guard detail != previous else { return }
        details[id] = detail
        markDetailRecentlyUsed(id)
        bumpDetailRevision(id: id, change: change)
    }

    private func removeDetail(id: String) {
        guard details.removeValue(forKey: id) != nil else { return }
        detailRecency.removeAll { $0 == id }
        bumpDetailRevision(id: id, change: .full)
    }

    private func clearDetails() {
        guard !details.isEmpty else { return }
        details.removeAll()
        detailRecency.removeAll()
        detailRevision &+= 1
        detailRevisions.removeAll()
        detailRenderUpdates.removeAll()
    }

    private func markDetailRecentlyUsed(_ id: String) {
        detailRecency.removeAll { $0 == id }
        detailRecency.append(id)
    }

    private func evictOldThreadDetailsIfNeeded() {
        let protected = Set(pendingSubmissionsByID.values.map(\.threadID))
        while details.count > Self.maximumRetainedThreadDetails,
              let candidate = detailRecency.first(where: { !protected.contains($0) }) {
            detailRecency.removeAll { $0 == candidate }
            removeDetail(id: candidate)
        }
    }

    private func bumpDetailRevision(id: String, change: FeatureDetailRenderChange) {
        let baseRevision = detailRevisions[id] ?? 0
        detailRevision &+= 1
        detailRevisions[id] = detailRevision
        detailRenderUpdates[id] = FeatureDetailRenderUpdate(
            baseRevision: baseRevision,
            revision: detailRevision,
            change: change
        )
    }

    private func replacingChangedSuffix<Element: Equatable>(
        _ current: [Element],
        with incoming: [Element]
    ) -> [Element] {
        guard current != incoming else { return current }
        let prefixCount = zip(current, incoming).prefix { pair in
            pair.0 == pair.1
        }.count
        var result = current
        result.replaceSubrange(prefixCount..., with: incoming.dropFirst(prefixCount))
        return result
    }

    private func restoreOutbox() async {
        let submissions: [FeatureQueuedSubmission]
        do {
            submissions = try await outboxStore.submissions()
        } catch {
            errorMessage = "Could not restore queued messages: \(error.localizedDescription)"
            return
        }

        for submission in submissions {
            if let creation = submission.creation {
                if snapshot.threads.contains(where: { $0.id == submission.threadID }) {
                    await discardRestoredSubmission(submission)
                    continue
                }
                guard let project = snapshot.projects.first(where: {
                    $0.id == creation.projectID && $0.environmentID == submission.environmentID
                }) else {
                    if isEnvironmentConnected(submission.environmentID) {
                        await discardRestoredSubmission(submission)
                    } else {
                        pendingSubmissionsByID[submission.id] = submission
                    }
                    continue
                }
                pendingSubmissionsByID[submission.id] = submission
                installPendingCreation(submission, project: project)
                continue
            }

            guard snapshot.threads.contains(where: { $0.id == submission.threadID }) else {
                if pendingThreadsByID[submission.threadID] != nil {
                    pendingSubmissionsByID[submission.id] = submission
                } else if isEnvironmentConnected(submission.environmentID) {
                    await discardRestoredSubmission(submission)
                } else {
                    pendingSubmissionsByID[submission.id] = submission
                }
                continue
            }
            pendingSubmissionsByID[submission.id] = submission
            if let detail = details[submission.threadID] {
                store(addingPendingMessages(to: detail))
            }
        }
    }

    private func discardRestoredSubmission(_ submission: FeatureQueuedSubmission) async {
        pendingSubmissionsByID[submission.id] = submission
        await discardQueuedSubmission(submission)
    }

    private func enqueue(_ submission: FeatureQueuedSubmission) async -> Bool {
        do {
            try await outboxStore.enqueue(submission)
            pendingSubmissionsByID[submission.id] = submission
            return true
        } catch {
            errorMessage = "Could not safely queue this message: \(error.localizedDescription)"
            return false
        }
    }

    private func installPendingCreation(
        _ submission: FeatureQueuedSubmission,
        project: FeatureProject
    ) {
        guard let creation = submission.creation else { return }
        let provider = provider(
            id: submission.selection?.providerID,
            environmentID: submission.environmentID
        )
        let environmentName = snapshot.environments.first {
            $0.id == submission.environmentID
        }?.name
        let title = submission.text
            .split(whereSeparator: \.isNewline)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let thread = FeatureThread(
            id: submission.threadID,
            wireID: submission.identity.threadID,
            projectID: project.id,
            environmentID: submission.environmentID,
            environmentName: environmentName,
            title: title?.isEmpty == false ? title! : "New task",
            preview: submission.text,
            branch: creation.branch,
            worktreePath: creation.worktreePath,
            createdAt: submission.identity.createdAt,
            updatedAt: submission.identity.createdAt,
            state: .queued,
            providerID: submission.selection?.providerID,
            providerName: provider?.name,
            modelID: submission.selection?.modelID,
            runtimeMode: .fullAccess,
            interactionMode: .standard
        )
        pendingThreadsByID[thread.id] = thread
        upsert(thread)
        store(FeatureThreadDetail(
            thread: thread,
            messages: [queuedMessage(for: submission)]
        ))
    }

    private func provider(id: String?, environmentID: String) -> FeatureProvider? {
        guard let id else { return nil }
        let providers = snapshot.providersByEnvironment?[environmentID] ?? snapshot.providers
        return providers.first { $0.id == id }
    }

    private func queuedMessage(for submission: FeatureQueuedSubmission) -> FeatureMessage {
        FeatureMessage(
            id: submission.identity.messageID,
            role: .user,
            text: submission.text,
            createdAt: submission.identity.createdAt,
            state: .queued,
            attachments: submission.attachments.enumerated().map { index, attachment in
                FeatureMessageAttachment(
                    id: "\(submission.id)-attachment-\(index)",
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.data.count
                )
            }
        )
    }

    private func addingPendingMessages(to incoming: FeatureThreadDetail) -> FeatureThreadDetail {
        let queued = pendingSubmissionsByID.values
            .filter { $0.threadID == incoming.thread.id }
            .sorted { $0.identity.createdAt < $1.identity.createdAt }
        guard !queued.isEmpty else { return incoming }
        var result = incoming
        let existing = Set(result.messages.map(\.id))
        result.messages.append(contentsOf: queued.lazy
            .filter { !existing.contains($0.identity.messageID) }
            .map(queuedMessage(for:)))
        return result
    }

    private func retainingLocalAttachmentPreviews(
        in incoming: FeatureThreadDetail
    ) -> FeatureThreadDetail {
        guard let current = details[incoming.thread.id] else { return incoming }
        let currentMessages = current.messages.reduce(into: [String: FeatureMessage]()) {
            $0[$1.id] = $1
        }
        var result = incoming
        result.messages = incoming.messages.map { message in
            guard let local = currentMessages[message.id], !message.attachments.isEmpty else {
                return message
            }
            var message = message
            message.attachments = message.attachments.enumerated().map { index, attachment in
                guard attachment.previewData == nil else { return attachment }
                let matching = local.attachments.first { candidate in
                    candidate.id == attachment.id
                } ?? (
                    local.attachments.indices.contains(index)
                        ? local.attachments[index]
                        : nil
                )
                guard let previewData = matching?.previewData else { return attachment }
                var attachment = attachment
                attachment.previewData = previewData
                return attachment
            }
            return message
        }
        return result
    }

    private func acknowledgeAuthoritativeThread(_ id: String) {
        guard pendingThreadsByID[id] != nil,
              let submission = pendingSubmissionsByID.values.first(where: {
                  $0.threadID == id && $0.creation != nil
              }) else { return }
        scheduleQueuedSubmissionCompletion(submission)
    }

    private func acknowledgeDeliveredMessages(_ messages: [FeatureMessage]) {
        // Runs on every detail publish; skip the full message-ID scan in the
        // common case where nothing is waiting in the outbox.
        guard !pendingSubmissionsByID.isEmpty else { return }
        // Local optimistic rows reuse the final message ID but are not proof
        // that the server accepted the turn. Only authoritative, non-queued
        // rows can retire a durable outbox entry.
        let messageIDs = Set(messages.lazy
            .filter { $0.state != .queued }
            .map(\.id))
        let delivered = pendingSubmissionsByID.values.filter {
            $0.creation == nil && messageIDs.contains($0.identity.messageID)
        }
        for submission in delivered {
            scheduleQueuedSubmissionCompletion(submission)
        }
    }

    private func scheduleQueuedSubmissionCompletion(_ submission: FeatureQueuedSubmission) {
        guard pendingCompletionSubmissionIDs.insert(submission.id).inserted else { return }
        pendingDiscardSubmissionIDs.remove(submission.id)
        Task { @MainActor [weak self] in
            guard let self else { return }
            if !(await self.completeQueuedSubmission(submission)) {
                self.scheduleOutboxRetry()
            }
        }
    }

    @discardableResult
    private func completeQueuedSubmission(_ submission: FeatureQueuedSubmission) async -> Bool {
        pendingCompletionSubmissionIDs.insert(submission.id)
        pendingDiscardSubmissionIDs.remove(submission.id)
        do {
            try await outboxStore.remove(id: submission.id)
        } catch {
            errorMessage = "The message was delivered, but its queued copy could not be cleared: \(error.localizedDescription)"
            return false
        }
        pendingCompletionSubmissionIDs.remove(submission.id)
        pendingSubmissionsByID.removeValue(forKey: submission.id)
        pendingThreadsByID.removeValue(forKey: submission.threadID)
        markQueuedMessageDelivered(submission)
        outboxRetryAttempt = 0
        return true
    }

    private func markQueuedMessageDelivered(_ submission: FeatureQueuedSubmission) {
        mutateDetail(
            id: submission.threadID,
            change: .delta(FeatureDetailDelta(changedMessages: []))
        ) { detail in
            guard let index = detail.messages.firstIndex(where: {
                $0.id == submission.identity.messageID
            }) else { return }
            detail.messages[index].state = .complete
        }
    }

    @discardableResult
    private func discardQueuedSubmission(_ submission: FeatureQueuedSubmission) async -> Bool {
        pendingCompletionSubmissionIDs.remove(submission.id)
        pendingDiscardSubmissionIDs.insert(submission.id)
        do {
            try await outboxStore.remove(id: submission.id)
        } catch {
            errorMessage = "Could not remove the queued message: \(error.localizedDescription)"
            return false
        }
        pendingDiscardSubmissionIDs.remove(submission.id)
        pendingSubmissionsByID.removeValue(forKey: submission.id)
        let wasPendingCreation = pendingThreadsByID.removeValue(forKey: submission.threadID) != nil
        if wasPendingCreation {
            removeThread(id: submission.threadID)
            removeDetail(id: submission.threadID)
        } else {
            mutateDetail(id: submission.threadID) {
                $0.messages.removeAll { $0.id == submission.identity.messageID }
            }
        }
        return true
    }

    private func removePendingSubmissions(environmentID: String) {
        let removed = pendingSubmissionsByID.values.filter {
            $0.environmentID == environmentID
        }
        for submission in removed {
            pendingCompletionSubmissionIDs.remove(submission.id)
            pendingDiscardSubmissionIDs.remove(submission.id)
            pendingSubmissionsByID.removeValue(forKey: submission.id)
            if pendingThreadsByID.removeValue(forKey: submission.threadID) != nil {
                removeThread(id: submission.threadID)
                removeDetail(id: submission.threadID)
            } else {
                mutateDetail(id: submission.threadID) {
                    $0.messages.removeAll { $0.id == submission.identity.messageID }
                }
            }
        }
    }

    private func markPendingSubmissionsForDiscard(environmentID: String) {
        for submission in pendingSubmissionsByID.values where submission.environmentID == environmentID {
            pendingCompletionSubmissionIDs.remove(submission.id)
            pendingDiscardSubmissionIDs.insert(submission.id)
        }
    }

    private func scheduleOutboxDrain(after delay: Duration = .zero) {
        guard outboxDrainTask == nil, !pendingSubmissionsByID.isEmpty else { return }
        let generation = outboxGeneration
        outboxDrainTask = Task { @MainActor [weak self] in
            if delay > .zero {
                try? await Task.sleep(for: delay)
            }
            guard !Task.isCancelled,
                  let self,
                  self.outboxGeneration == generation else { return }
            let needsRetry = await self.drainOutbox(generation: generation)
            self.outboxDrainTask = nil
            if needsRetry,
               !Task.isCancelled,
               self.outboxGeneration == generation {
                self.scheduleOutboxRetry()
            }
        }
    }

    private func stopOutboxDrain() async {
        outboxGeneration &+= 1
        guard let task = outboxDrainTask else { return }
        task.cancel()
        await task.value
        outboxDrainTask = nil
    }

    private func scheduleOutboxRetry() {
        guard outboxDrainTask == nil else { return }
        let seconds = min(16, 1 << min(outboxRetryAttempt, 4))
        outboxRetryAttempt += 1
        scheduleOutboxDrain(after: .seconds(seconds))
    }

    private func drainOutbox(generation: UInt64) async -> Bool {
        let submissions = pendingSubmissionsByID.values.sorted {
            $0.identity.createdAt < $1.identity.createdAt
        }
        var needsRetry = false
        for submission in submissions where pendingSubmissionsByID[submission.id] != nil {
            guard !Task.isCancelled, outboxGeneration == generation else { return false }
            if pendingCompletionSubmissionIDs.contains(submission.id) {
                if !(await completeQueuedSubmission(submission)) {
                    needsRetry = true
                }
                continue
            }
            if pendingDiscardSubmissionIDs.contains(submission.id) {
                if !(await discardQueuedSubmission(submission)) {
                    needsRetry = true
                }
                continue
            }
            var policySnapshot = snapshot
            if pendingThreadsByID[submission.threadID] != nil {
                policySnapshot.threads.removeAll { $0.id == submission.threadID }
            }
            switch FeatureOutboxPolicy.decision(
                for: submission,
                snapshot: policySnapshot,
                pendingCreationThreadIDs: Set(pendingThreadsByID.keys)
            ) {
            case .discard:
                if !(await discardQueuedSubmission(submission)) {
                    needsRetry = true
                }
            case .wait:
                // Connectivity and snapshot events wake the drain immediately.
                // Avoid a permanent timer while the owning device is offline.
                continue
            case .send:
                do {
                    guard pendingSubmissionsByID[submission.id] != nil,
                          snapshot.environments.contains(where: {
                              $0.id == submission.environmentID
                          }) else {
                        continue
                    }
                    if let creation = submission.creation {
                        let thread = try await client.createThreadAndSend(
                            projectID: creation.projectID,
                            prompt: submission.text,
                            selection: submission.selection,
                            runtimeMode: .fullAccess,
                            interactionMode: .standard,
                            workspaceMode: creation.workspaceMode,
                            branch: creation.branch,
                            worktreePath: creation.worktreePath,
                            startFromOrigin: creation.startFromOrigin,
                            attachments: submission.uploads,
                            identity: submission.identity
                        )
                        guard !Task.isCancelled,
                              outboxGeneration == generation else { return false }
                        if !(await completeQueuedSubmission(submission)) {
                            needsRetry = true
                        }
                        if thread.id != submission.threadID {
                            removeThread(id: submission.threadID)
                            removeDetail(id: submission.threadID)
                        }
                        upsert(thread)
                    } else {
                        try await client.sendMessage(
                            threadID: submission.threadID,
                            text: submission.text,
                            selection: submission.selection,
                            attachments: submission.uploads,
                            identity: submission.identity
                        )
                        guard !Task.isCancelled,
                              outboxGeneration == generation else { return false }
                        if !(await completeQueuedSubmission(submission)) {
                            needsRetry = true
                        }
                    }
                } catch {
                    if Self.shouldQueue(
                        error,
                        environmentID: submission.environmentID,
                        snapshot: snapshot
                    ) {
                        needsRetry = true
                    } else {
                        if !(await discardQueuedSubmission(submission)) {
                            needsRetry = true
                        } else {
                            errorMessage = error.localizedDescription
                        }
                    }
                }
            }
        }
        return needsRetry
    }

    private func isEnvironmentConnected(_ environmentID: String) -> Bool {
        guard let environment = snapshot.environments.first(where: { $0.id == environmentID }) else {
            return false
        }
        return environment.connectionState == .connected
            || (environment.isActive && snapshot.connection.state == .connected)
    }

    static func shouldQueue(
        _ error: any Error,
        environmentID: String,
        snapshot: FeatureSnapshot
    ) -> Bool {
        if error is CancellationError || error is URLError { return true }
        if let rpcError = error as? RPCError,
           case .responseTimedOut = rpcError {
            return true
        }
        if let environment = snapshot.environments.first(where: { $0.id == environmentID }) {
            let disconnected = environment.connectionState != .connected
                && !(environment.isActive && snapshot.connection.state == .connected)
            if disconnected { return true }
        }
        let message = error.localizedDescription.lowercased()
        return [
            "cancelled", "canceled", "connection", "network", "offline",
            "socket", "timed out", "timeout", "transport", "not connected",
            "request deadline",
        ].contains { message.contains($0) }
    }
}

private extension FeatureDraftAttachment {
    var upload: FeatureUploadAttachment {
        FeatureUploadAttachment(data: data, name: filename, mimeType: mimeType)
    }
}

import Foundation

/// The app-owned adapter between the native feature layer and T3's WebSocket/Core runtime.
/// Implementations are main-actor isolated so UI state never depends on locking.
@MainActor
public protocol FeatureClient: AnyObject {
    func initialSnapshot() async throws -> FeatureSnapshot
    /// Performs one bounded refresh without starting long-lived subscriptions.
    /// Background tasks use this instead of the foreground bootstrap path.
    func backgroundSnapshot() async throws -> FeatureSnapshot
    func events() -> AsyncStream<FeatureEvent>
    func resumeAfterBackground(reconnect: Bool) async

    func preuploadAttachment(
        _ attachment: FeatureUploadAttachment,
        environmentID: String
    ) async throws -> FeatureUploadedAttachmentReference?

    func pair(endpoint: String, token: String?) async throws
    func setEnvironmentEnabled(id: String, enabled: Bool) async throws
    func removeEnvironment(id: String) async throws
    func disconnect() async

    func addProject(path: String) async throws
    func createThread(projectID: String, title: String?, selection: FeatureSelection?) async throws -> FeatureThread
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws -> FeatureThread
    func listWorkspaceBranches(
        projectID: String,
        refresh: Bool
    ) async throws -> [FeatureWorkspaceBranch]
    func renameThread(id: String, title: String) async throws
    func regenerateThreadTitle(id: String) async throws
    func setThreadArchived(id: String, archived: Bool) async throws
    func setThreadSettled(id: String, settled: Bool) async throws
    func setThreadSnoozed(id: String, until: Date?) async throws
    func setThreadPinned(id: String, pinned: Bool) async throws
    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws
    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws
    func deleteThread(id: String) async throws

    func loadThread(id: String) async throws -> FeatureThreadDetail
    func loadThread(id: String, fresh: Bool) async throws -> FeatureThreadDetail
    func loadEarlierThreadTurns(id: String) async throws -> FeatureThreadDetail?
    func releaseThread(id: String)
    func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async throws
    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws
    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws
    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws
    func cancelTurn(threadID: String) async throws
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws
    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws

    func saveSettings(_ settings: FeatureSettings) async throws
    func serverPreferences(environmentID: String) async throws -> ServerSettingsSnapshot
    func updateServerPreferences(environmentID: String, change: ServerSettingsChange) async throws
    func sharedPreferenceMismatches(environmentID: String) -> [String]
    func refreshProviders(environmentID: String) async throws -> [FeatureProvider]
    func refreshWorkspaceProviders(environmentID: String, cwd: String, instanceID: String) async throws -> [FeatureProvider]
    func providerSetup(environmentID: String, instanceID: String, action: ProviderSetupAction) async throws -> ProviderSetupEvent
    func providerSetupEvents(environmentID: String, instanceID: String) -> AsyncThrowingStream<ProviderSetupEvent, Error>
    func setProviderEnabled(environmentID: String, instanceID: String, enabled: Bool) async throws
    func updateAutomaticSettlement(
        environmentID: String,
        change: FeatureAutomaticSettlementChange
    ) async throws -> FeatureAutomaticSettlementSettings

    func usageSummaries(_ input: UsageSummaryInput) async throws -> [FeatureEnvironmentUsage]
    func usageSummaries(_ input: UsageSummaryInput, refreshPricing: Bool) async throws -> [FeatureEnvironmentUsage]
    func usageSummaryUpdates(
        _ input: UsageSummaryInput,
        refreshPricing: Bool
    ) -> AsyncThrowingStream<[FeatureEnvironmentUsage], Error>
    func usageLimitsUpdates() -> AsyncThrowingStream<[FeatureEnvironmentUsageLimits], Error>
    func refreshUsageLimits() async throws -> [FeatureEnvironmentUsageLimits]
    func consumeResetCredit(
        environmentID: String,
        instanceID: String
    ) async throws -> ProviderConsumeResetCreditResult
    func pullRequestLists(_ input: PullRequestListInput) async throws
        -> [FeaturePullRequestEnvironmentList]
    func pullRequestLists(
        _ input: PullRequestListInput,
        environmentID: String
    ) async throws -> [FeaturePullRequestEnvironmentList]
    func pullRequestDetail(_ target: FeaturePullRequestTarget) async throws -> PullRequestDetail
    func pullRequestActivity(_ target: FeaturePullRequestTarget) async throws
        -> PullRequestActivity
    func pullRequestDiff(_ target: FeaturePullRequestTarget, cursor: String?) async throws
        -> PullRequestDiffResult
    func runPullRequestAction(
        _ target: FeaturePullRequestTarget,
        action: PullRequestAction,
        mergeMethod: PullRequestMergeMethod?,
        updateMethod: PullRequestUpdateMethod?
    ) async throws
    func updatePullRequest(
        _ target: FeaturePullRequestTarget,
        title: String?,
        body: String?
    ) async throws
    func commentOnPullRequest(_ target: FeaturePullRequestTarget, body: String) async throws
    func submitPullRequestReview(
        _ target: FeaturePullRequestTarget,
        verdict: PullRequestReviewVerdict,
        body: String,
        comments: [PullRequestReviewCommentDraft]
    ) async throws
    func replyToPullRequestThread(
        _ target: FeaturePullRequestTarget,
        threadID: String,
        body: String
    ) async throws
    func setPullRequestThreadResolved(
        _ target: FeaturePullRequestTarget,
        threadID: String,
        resolved: Bool
    ) async throws
    func setPullRequestReaction(
        _ target: FeaturePullRequestTarget,
        subjectID: String?,
        content: PullRequestReactionContent,
        reacted: Bool
    ) async throws
    func pullRequestReviewerCandidates(_ target: FeaturePullRequestTarget) async throws
        -> PullRequestReviewerCandidateList
    func requestPullRequestReviewers(
        _ target: FeaturePullRequestTarget,
        reviewers: [PullRequestReviewerCandidate],
        requested: Bool
    ) async throws
    func invalidatePullRequests(_ target: FeaturePullRequestTarget?) async throws

    func cachedProjectFavicon(
        environmentID: String,
        workspaceRoot: String
    ) async -> Data?
    func refreshProjectFavicon(
        environmentID: String,
        workspaceRoot: String
    ) async -> Data?

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry]
    func searchProjectFiles(
        projectID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry]
    func searchThreadFiles(
        threadID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry]
    func readFile(threadID: String, path: String) async throws -> FeatureFileContent
    func loadReview(threadID: String) async throws -> FeatureReview
    func loadReviewFileContents(
        threadID: String,
        file: FeatureReviewFile
    ) async throws -> FeatureReviewFileContents?

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus
    func sourceControlStatusEvents(threadID: String) -> AsyncStream<FeatureSourceControlStatus>
    func performSourceControlAction(
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus

    func terminalSnapshot(threadID: String, terminalID: String) async throws -> FeatureTerminalSnapshot
    func terminalHostOS(threadID: String) -> String?
    func terminalEvents(threadID: String, terminalID: String) -> AsyncStream<FeatureTerminalSnapshot>
    func terminalSessions(threadID: String) -> AsyncStream<[FeatureTerminalSnapshot]>
    func openTerminal(threadID: String, terminalID: String, columns: Int, rows: Int) async throws
    func writeTerminal(threadID: String, terminalID: String, data: String) async throws
    func resizeTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws
    func clearTerminal(threadID: String, terminalID: String) async throws
    func closeTerminal(threadID: String, terminalID: String) async throws
}

public extension FeatureClient {
    func serverPreferences(environmentID: String) async throws -> ServerSettingsSnapshot {
        throw FeatureCapabilityUnavailable("Server preferences")
    }
    func updateServerPreferences(environmentID: String, change: ServerSettingsChange) async throws {
        throw FeatureCapabilityUnavailable("Server preferences")
    }
    func sharedPreferenceMismatches(environmentID: String) -> [String] { [] }

    func loadThread(id: String, fresh: Bool) async throws -> FeatureThreadDetail {
        try await loadThread(id: id)
    }

    func usageSummaries(_ input: UsageSummaryInput, refreshPricing: Bool) async throws -> [FeatureEnvironmentUsage] {
        try await usageSummaries(input)
    }

    func usageSummaryUpdates(
        _ input: UsageSummaryInput,
        refreshPricing: Bool
    ) -> AsyncThrowingStream<[FeatureEnvironmentUsage], Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let result = try await usageSummaries(input, refreshPricing: refreshPricing)
                    try Task.checkCancellation()
                    continuation.yield(result)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func usageLimitsUpdates() -> AsyncThrowingStream<[FeatureEnvironmentUsageLimits], Error> {
        AsyncThrowingStream { $0.finish() }
    }

    func refreshUsageLimits() async throws -> [FeatureEnvironmentUsageLimits] { [] }

    func consumeResetCredit(
        environmentID: String,
        instanceID: String
    ) async throws -> ProviderConsumeResetCreditResult {
        throw FeatureCapabilityUnavailable("Usage reset credits")
    }

    func terminalHostOS(threadID: String) -> String? { nil }

    func setProviderEnabled(environmentID: String, instanceID: String, enabled: Bool) async throws {
        throw FeatureCapabilityUnavailable("Provider settings")
    }

    func providerSetup(environmentID: String, instanceID: String, action: ProviderSetupAction) async throws -> ProviderSetupEvent {
        throw FeatureCapabilityUnavailable("Provider setup")
    }

    func providerSetupEvents(environmentID: String, instanceID: String) -> AsyncThrowingStream<ProviderSetupEvent, Error> {
        AsyncThrowingStream { $0.finish() }
    }

    func resumeAfterBackground(reconnect: Bool) async {}

    func preuploadAttachment(
        _ attachment: FeatureUploadAttachment,
        environmentID: String
    ) async throws -> FeatureUploadedAttachmentReference? {
        nil
    }
}

public extension FeatureClient {
    func backgroundSnapshot() async throws -> FeatureSnapshot {
        try await initialSnapshot()
    }

    func regenerateThreadTitle(id _: String) async throws {
        throw FeatureCapabilityUnavailable("Thread title regeneration")
    }

    func loadEarlierThreadTurns(id _: String) async throws -> FeatureThreadDetail? {
        nil
    }
}

public extension FeatureClient {
    func events() -> AsyncStream<FeatureEvent> {
        AsyncStream { continuation in continuation.finish() }
    }

    func setEnvironmentEnabled(id: String, enabled: Bool) async throws {}
    func removeEnvironment(id: String) async throws {}
    func disconnect() async {}
    func refreshWorkspaceProviders(environmentID: String, cwd: String, instanceID: String) async throws -> [FeatureProvider] {
        throw FeatureCapabilityUnavailable("Workspace provider catalog")
    }

    func refreshProviders(environmentID _: String) async throws -> [FeatureProvider] {
        throw FeatureCapabilityUnavailable("Provider refresh")
    }
    func updateAutomaticSettlement(
        environmentID _: String,
        change _: FeatureAutomaticSettlementChange
    ) async throws -> FeatureAutomaticSettlementSettings {
        throw FeatureCapabilityUnavailable("Automatic settlement settings")
    }
    func addProject(path: String) async throws {}
    func usageSummaries(_ input: UsageSummaryInput) async throws -> [FeatureEnvironmentUsage] {
        []
    }
    func pullRequestLists(_ input: PullRequestListInput) async throws
        -> [FeaturePullRequestEnvironmentList]
    {
        []
    }
    func pullRequestLists(
        _ input: PullRequestListInput,
        environmentID: String
    ) async throws -> [FeaturePullRequestEnvironmentList] {
        throw FeatureCapabilityUnavailable("Environment-specific pull request pagination")
    }
    func pullRequestDetail(_ target: FeaturePullRequestTarget) async throws -> PullRequestDetail {
        throw FeatureCapabilityUnavailable("Pull requests")
    }
    func pullRequestActivity(_ target: FeaturePullRequestTarget) async throws
        -> PullRequestActivity
    {
        throw FeatureCapabilityUnavailable("Pull request activity")
    }
    func pullRequestDiff(_ target: FeaturePullRequestTarget, cursor: String?) async throws
        -> PullRequestDiffResult
    {
        throw FeatureCapabilityUnavailable("Pull request diffs")
    }
    func runPullRequestAction(
        _ target: FeaturePullRequestTarget,
        action: PullRequestAction,
        mergeMethod: PullRequestMergeMethod?,
        updateMethod: PullRequestUpdateMethod?
    ) async throws { throw FeatureCapabilityUnavailable("Pull request actions") }
    func updatePullRequest(
        _ target: FeaturePullRequestTarget,
        title: String?,
        body: String?
    ) async throws { throw FeatureCapabilityUnavailable("Pull request editing") }
    func commentOnPullRequest(_ target: FeaturePullRequestTarget, body: String) async throws {
        throw FeatureCapabilityUnavailable("Pull request comments")
    }
    func submitPullRequestReview(
        _ target: FeaturePullRequestTarget,
        verdict: PullRequestReviewVerdict,
        body: String,
        comments: [PullRequestReviewCommentDraft]
    ) async throws { throw FeatureCapabilityUnavailable("Pull request reviews") }
    func replyToPullRequestThread(
        _ target: FeaturePullRequestTarget,
        threadID: String,
        body: String
    ) async throws { throw FeatureCapabilityUnavailable("Pull request replies") }
    func setPullRequestThreadResolved(
        _ target: FeaturePullRequestTarget,
        threadID: String,
        resolved: Bool
    ) async throws { throw FeatureCapabilityUnavailable("Pull request review threads") }
    func setPullRequestReaction(
        _ target: FeaturePullRequestTarget,
        subjectID: String?,
        content: PullRequestReactionContent,
        reacted: Bool
    ) async throws { throw FeatureCapabilityUnavailable("Pull request reactions") }
    func pullRequestReviewerCandidates(_ target: FeaturePullRequestTarget) async throws
        -> PullRequestReviewerCandidateList
    {
        throw FeatureCapabilityUnavailable("Pull request reviewers")
    }
    func requestPullRequestReviewers(
        _ target: FeaturePullRequestTarget,
        reviewers: [PullRequestReviewerCandidate],
        requested: Bool
    ) async throws { throw FeatureCapabilityUnavailable("Pull request reviewers") }
    func invalidatePullRequests(_ target: FeaturePullRequestTarget?) async throws {}
    func cachedProjectFavicon(environmentID: String, workspaceRoot: String) async -> Data? {
        nil
    }
    func refreshProjectFavicon(environmentID: String, workspaceRoot: String) async -> Data? {
        nil
    }
    func releaseThread(id: String) {}
    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws {}

    /// Keeps simple text-only callers source-compatible while the typed API
    /// preserves multi-select answers as arrays.
    func resolveUserInput(id: String, answers: [String: String]) async throws {
        try await resolveUserInput(
            id: id,
            answers: answers.mapValues(FeatureInputAnswer.text)
        )
    }
    func setThreadSettled(id: String, settled: Bool) async throws {}
    func setThreadSnoozed(id: String, until: Date?) async throws {}
    func setThreadPinned(id: String, pinned: Bool) async throws {}
    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws {}
    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws {}
    func loadReviewFileContents(
        threadID: String,
        file: FeatureReviewFile
    ) async throws -> FeatureReviewFileContents? {
        nil
    }

    func listWorkspaceBranches(
        projectID: String,
        refresh: Bool
    ) async throws -> [FeatureWorkspaceBranch] {
        []
    }

    /// Legacy clients still create in the current checkout. Native clients
    /// override this overload to prepare worktrees atomically with the first turn.
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        try await createThreadAndSend(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            attachments: attachments
        )
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        let thread = try await createThread(
            projectID: projectID,
            title: prompt,
            selection: selection
        )
        try await sendMessage(
            threadID: thread.id,
            text: prompt,
            selection: selection,
            attachments: attachments
        )
        return thread
    }

    /// Clients that understand stable command identities override this method.
    /// The compatibility path remains functional but cannot guarantee
    /// idempotence across a process death after an ambiguous network failure.
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws -> FeatureThread {
        try await createThreadAndSend(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            workspaceMode: workspaceMode,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: startFromOrigin,
            attachments: attachments
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws {
        guard attachments.isEmpty else {
            throw FeatureCapabilityUnavailable("Image attachments")
        }
        try await sendMessage(threadID: threadID, text: text, selection: selection)
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws {
        try await sendMessage(
            threadID: threadID,
            text: text,
            selection: selection,
            attachments: attachments
        )
    }

    /// Durable submissions carry the modes that were active when the user
    /// sent them. Older clients can ignore them, while native retries preserve
    /// the original permission instead of reading a later thread value.
    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws {
        try await sendMessage(
            threadID: threadID,
            text: text,
            selection: selection,
            attachments: attachments,
            identity: identity
        )
    }

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry] {
        throw FeatureCapabilityUnavailable("Files")
    }

    func searchProjectFiles(
        projectID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        throw FeatureCapabilityUnavailable("File search")
    }

    func searchThreadFiles(
        threadID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        throw FeatureCapabilityUnavailable("File search")
    }

    func readFile(threadID: String, path: String) async throws -> FeatureFileContent {
        throw FeatureCapabilityUnavailable("File preview")
    }

    func loadReview(threadID: String) async throws -> FeatureReview {
        throw FeatureCapabilityUnavailable("Review")
    }

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus {
        throw FeatureCapabilityUnavailable("Source control")
    }

    func sourceControlStatusEvents(threadID: String) -> AsyncStream<FeatureSourceControlStatus> {
        AsyncStream { $0.finish() }
    }

    func performSourceControlAction(
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus {
        throw FeatureCapabilityUnavailable("Source control actions")
    }

    func terminalSnapshot(threadID: String, terminalID _: String) async throws -> FeatureTerminalSnapshot {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func terminalEvents(threadID: String, terminalID _: String) -> AsyncStream<FeatureTerminalSnapshot> {
        AsyncStream { $0.finish() }
    }

    func terminalSessions(threadID _: String) -> AsyncStream<[FeatureTerminalSnapshot]> {
        AsyncStream { $0.finish() }
    }

    func openTerminal(
        threadID: String,
        terminalID _: String,
        columns: Int,
        rows: Int
    ) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func writeTerminal(threadID: String, terminalID _: String, data: String) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func resizeTerminal(
        threadID: String,
        terminalID _: String,
        columns: Int,
        rows: Int
    ) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func clearTerminal(threadID: String, terminalID _: String) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func closeTerminal(threadID: String, terminalID _: String) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }
}

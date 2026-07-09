import Foundation

// Deterministic-but-alive fake backend for UI work without the Node sidecar.
// All mutable state lives behind an actor; the public API is the BackendService
// protocol (Sendable, async). Events are pushed through an AsyncStream whose
// continuation is stored on the actor so any method can emit.

public final class MockBackend: BackendService, @unchecked Sendable {
    public let events: AsyncStream<BackendEvent>
    private let continuation: AsyncStream<BackendEvent>.Continuation
    private let state: MockState

    public init() {
        let (stream, continuation) = AsyncStream<BackendEvent>.makeStream()
        self.events = stream
        self.continuation = continuation
        self.state = MockState(emit: { continuation.yield($0) })
    }

    public func start() async {
        await state.start()
    }

    public func stop() async {
        continuation.finish()
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

    public func mintMobilePairing() async throws -> MobilePairingInfo {
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

    public func watchVcsStatus(threadID: String) async throws {
        await state.emitVcsStatus(threadID: threadID)
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

    public func implementPlan(threadID: String, planID: String) async throws {
        await state.sendMessage(threadID: threadID, text: "Implement the proposed plan.")
    }

    public func diff(threadID: String) async throws -> [DiffFile] {
        await state.diff(threadID: threadID)
    }

    public func checkpoints(threadID: String) async throws -> [Checkpoint] {
        await state.checkpoints(threadID: threadID)
    }

    public func restoreCheckpoint(id: String) async throws {
        await state.restoreCheckpoint(id: id)
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
    private let emit: @Sendable (BackendEvent) -> Void

    private var projectsByID: [String: Project] = [:]
    private var threadsByID: [String: ChatThread] = [:]
    private var timelinesByThread: [String: [TimelineItem]] = [:]
    private var diffsByThread: [String: [DiffFile]] = [:]
    private var checkpointsByThread: [String: [Checkpoint]] = [:]
    private var approvalsByID: [String: ApprovalRequest] = [:]
    private var providerList: [ProviderInstance] = []
    private var backgroundAgentsByThread: [String: Int] = [:]

    private var started = false
    private var counter = 0

    init(emit: @escaping @Sendable (BackendEvent) -> Void) {
        self.emit = emit
        // `seed()` used to run as an instance method here, but Swift 6 forbids
        // calling actor-isolated instance methods from a synchronous actor
        // init (the actor isn't considered "isolated" yet at that point).
        // Moved the seed computation into a `nonisolated static` factory that
        // builds the same values without touching `self`, then assigned here.
        let seed = MockState.makeSeed()
        self.projectsByID = seed.projects
        self.threadsByID = seed.threads
        self.timelinesByThread = seed.timelines
        self.diffsByThread = seed.diffs
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
                threadID: "thread-1",
                status: ContextWindowStatus(usedTokens: 72_000, maxTokens: 200_000)))
        emit(
            .planProgressUpdated(
                threadID: "thread-1",
                progress: PlanProgress(
                    steps: [
                        PlanStep(id: 0, title: "Reproduce the scroll jump", status: .completed),
                        PlanStep(id: 1, title: "Pin sort to explicit reorder", status: .inProgress),
                        PlanStep(id: 2, title: "Verify with 200-thread seed", status: .pending),
                    ],
                    explanation: nil)))
        Task { await self.runSubagentLifecycleDemo() }
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
        let reply = MockState.canned(for: text)
        let chunks = MockState.chunk(reply, size: 24)

        // Seed the streaming message so the timeline has a placeholder before
        // the first delta lands.
        let placeholder = TimelineItem.assistantMessage(id: messageID, markdown: "", isStreaming: true, at: Date())
        timelinesByThread[threadID, default: []].append(placeholder)
        emit(.timelineAppended(threadID: threadID, item: placeholder))

        for chunk in chunks {
            try? await Task.sleep(nanoseconds: 80_000_000)
            emit(.assistantDelta(threadID: threadID, messageID: messageID, delta: chunk))
        }
        emit(.assistantCompleted(threadID: threadID, messageID: messageID, markdown: reply))

        guard var finishedThread = threadsByID[threadID] else { return }
        finishedThread.status = idleStatus(for: threadID)
        finishedThread.backgroundAgentCount = backgroundAgentsByThread[threadID] ?? 0
        finishedThread.updatedAt = Date()
        threadsByID[threadID] = finishedThread
        emit(.threadUpserted(finishedThread))
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

    func emitVcsStatus(threadID: String, branch: String = "feat/native-mac-app") {
        emit(
            .vcsStatusChanged(
                threadID: threadID,
                status: VcsStatus(
                    isRepo: true, branch: branch, isDefaultBranch: branch == "main",
                    changedFileCount: 3, insertions: 120, deletions: 14, aheadCount: 2,
                    behindCount: 0, hasUpstream: true)))
    }

    func respondToUserInput(id: String, answers: [String: [String]]) {
        emit(.userInputResolved(id: id))
        let summary = answers.values.flatMap { $0 }.joined(separator: ", ")
        let notice = TimelineItem.notice(
            id: nextID("notice"), text: "Answered: \(summary)", at: Date())
        // The mock seeds its one user-input request on thread-1.
        timelinesByThread["thread-1", default: []].append(notice)
        emit(.timelineAppended(threadID: "thread-1", item: notice))
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
        threadsByID[threadID] = thread
        emit(.threadUpserted(thread))
    }

    func setReasoningEffort(threadID: String, value: String) {
        guard var thread = threadsByID[threadID] else { return }
        thread.reasoningEffort = value
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

    func restoreCheckpoint(id: String) {
        guard let checkpoint = checkpointsByThread.values.flatMap({ $0 }).first(where: { $0.id == id }) else { return }
        let notice = TimelineItem.notice(
            id: nextID("notice"),
            text: "Restored checkpoint “\(checkpoint.label)”.",
            at: Date()
        )
        timelinesByThread[checkpoint.threadID, default: []].append(notice)
        emit(.timelineAppended(threadID: checkpoint.threadID, item: notice))
        emit(.diffInvalidated(threadID: checkpoint.threadID))
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
        let threadID = "thread-1"
        updateSubagentDemo(
            threadID: threadID, state: .running, progress: "Using Read...", duration: nil,
            activeCount: 1)
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        updateSubagentDemo(
            threadID: threadID, state: .running, progress: "Using Grep...", duration: nil,
            activeCount: 1)
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        updateSubagentDemo(
            threadID: threadID, state: .completed,
            progress: "Found the status projection and timeline mapping points.",
            duration: 9, activeCount: 0)
    }

    private func updateSubagentDemo(
        threadID: String, state: SubagentTaskState, progress: String, duration: TimeInterval?,
        activeCount: Int
    ) {
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

        let item = TimelineItem.subagentTask(
            SubagentTaskItem(
                taskId: "mock-subagent-1", taskType: "reviewer",
                description: "Audit subagent timeline and status handling",
                state: state, latestProgress: progress,
                startedAt: Date().addingTimeInterval(-(duration ?? 2)), duration: duration))
        timelinesByThread[threadID, default: []].upsertTimelineItem(item)
        emit(.timelineAppended(threadID: threadID, item: item))
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
        var checkpoints: [String: [Checkpoint]]
        var approvals: [String: ApprovalRequest]
        var providers: [ProviderInstance]
    }

    private static func makeSeed() -> Seed {
        let now = Date()

        var projectsByID: [String: Project] = [:]
        var threadsByID: [String: ChatThread] = [:]
        var timelinesByThread: [String: [TimelineItem]] = [:]
        var diffsByThread: [String: [DiffFile]] = [:]
        var checkpointsByThread: [String: [Checkpoint]] = [:]
        var approvalsByID: [String: ApprovalRequest] = [:]

        let projectA = Project(id: "project-1", name: "SergeCode", path: "/Users/serge/Documents/Dev/SergeCode")
        let projectB = Project(id: "project-2", name: "marketing-site", path: "/Users/serge/Documents/Dev/marketing-site")
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
            updatedAt: now.addingTimeInterval(-300)
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

        diffsByThread[thread1.id] = MockState.diffForSidebarThread()
        diffsByThread[thread2.id] = MockState.diffForMockBackendThread()
        diffsByThread[thread3.id] = MockState.diffForPricingThread()
        diffsByThread[thread4.id] = MockState.diffForErrorThread()

        checkpointsByThread[thread1.id] = [
            Checkpoint(id: "ckpt-1a", threadID: thread1.id, label: "Before scroll refactor", createdAt: now.addingTimeInterval(-600)),
            Checkpoint(id: "ckpt-1b", threadID: thread1.id, label: "After ScrollView fix", createdAt: now.addingTimeInterval(-120)),
        ]
        checkpointsByThread[thread2.id] = [
            Checkpoint(id: "ckpt-2a", threadID: thread2.id, label: "Initial MockBackend skeleton", createdAt: now.addingTimeInterval(-900)),
        ]
        checkpointsByThread[thread3.id] = [
            Checkpoint(id: "ckpt-3a", threadID: thread3.id, label: "First pricing draft", createdAt: now.addingTimeInterval(-4_000)),
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

        return Seed(
            projects: projectsByID,
            threads: threadsByID,
            timelines: timelinesByThread,
            diffs: diffsByThread,
            checkpoints: checkpointsByThread,
            approvals: approvalsByID,
            providers: providerList
        )
    }

    private static func timelineForSidebarThread(at now: Date) -> [TimelineItem] {
        [
            .userMessage(id: "t1-u1", text: "The sidebar list jumps around when new threads arrive. Can you fix it?", at: now.addingTimeInterval(-500)),
            .assistantMessage(
                id: "t1-a1",
                markdown: """
                Looked at `SidebarView`. The list re-sorts on every `threadUpserted` \
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
                    state: .running, latestProgress: "Starting delegated review...",
                    startedAt: now.addingTimeInterval(-460), duration: nil)),
            .toolEvent(
                id: "t1-tool1", name: "read_file",
                detail: "Sources/SergeCodeMac/Views/SidebarView.swift", kind: .fileRead,
                status: .succeeded, at: now.addingTimeInterval(-470),
                output: "struct SidebarView: View {\n    var body: some View { … }\n}",
                outputIsError: false),
            .toolEvent(
                id: "t1-tool2", name: "edit_file",
                detail: "Sources/SergeCodeMac/Model/AppModel.swift", kind: .fileChange,
                status: .succeeded, at: now.addingTimeInterval(-200),
                output: nil, outputIsError: false),
            .checkpoint(Checkpoint(id: "ckpt-1a", threadID: "thread-1", label: "Before scroll refactor", createdAt: now.addingTimeInterval(-600))),
            .userMessage(id: "t1-u2", text: "Nice, that feels a lot smoother now.", at: now.addingTimeInterval(-90)),
            .plan(ProposedPlan(
                id: "t1-plan1",
                threadID: "thread-1",
                markdown: """
                ## Plan: stop the sidebar scroll jumping
                1. Pin the sort to run only on explicit reorder events.
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
        ]
    }

    private static func timelineForApprovalThread(at now: Date) -> [TimelineItem] {
        [
            .userMessage(id: "t2-u1", text: "Build out MockBackend so we can develop the UI without the Node sidecar.", at: now.addingTimeInterval(-950)),
            .assistantMessage(
                id: "t2-a1",
                markdown: """
                Sketched `MockBackend` with seeded projects, threads, and a fake \
                streaming reply. Before I run the build to sanity-check it, I need \
                your go-ahead since this shells out.
                """,
                isStreaming: false,
                at: now.addingTimeInterval(-900)
            ),
            .toolEvent(
                id: "t2-tool1", name: "write_file",
                detail: "Sources/SergeCodeMac/Model/MockBackend.swift", kind: .fileChange,
                status: .succeeded, at: now.addingTimeInterval(-890),
                output: nil, outputIsError: false),
            .checkpoint(Checkpoint(id: "ckpt-2a", threadID: "thread-2", label: "Initial MockBackend skeleton", createdAt: now.addingTimeInterval(-900))),
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
            .checkpoint(Checkpoint(id: "ckpt-3a", threadID: "thread-3", label: "First pricing draft", createdAt: now.addingTimeInterval(-4_000))),
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
                - /workspace/apps/web/src/index.ts
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

    private static func canned(for text: String) -> String {
        """
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
}

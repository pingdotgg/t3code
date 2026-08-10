import Foundation

struct ThreadNewTaskSeedRequest: Equatable, Sendable {
    let sourceThreadID: String
    let projectID: String
    let environmentID: String
    let branch: String
    let worktreePath: String?
    let projectRootPath: String?
}

enum ThreadNewTaskUnavailableReason: String, Identifiable, Equatable, Sendable, Error {
    case missingBranch
    case projectUnavailable
    case environmentUnavailable
    case branchUnavailable
    case worktreeUnavailable
    case threadChanged
    case branchesUnavailable

    var id: String { rawValue }

    var menuTitle: String {
        switch self {
        case .missingBranch:
            "New thread unavailable (branch missing)"
        case .projectUnavailable, .environmentUnavailable:
            "New thread unavailable (project offline)"
        case .branchUnavailable:
            "New thread unavailable (branch missing)"
        case .worktreeUnavailable:
            "New thread unavailable (checkout missing)"
        case .threadChanged:
            "New thread unavailable (thread changed)"
        case .branchesUnavailable:
            "New thread unavailable (branches offline)"
        }
    }

    var feedbackMessage: String {
        switch self {
        case .missingBranch:
            "This thread no longer reports a branch. Refresh the thread and try again."
        case .projectUnavailable:
            "The project for this thread is no longer available. Reconnect it and try again."
        case .environmentUnavailable:
            "The thread’s original environment is no longer available. Reconnect it and try again."
        case .branchUnavailable:
            "The thread’s recorded branch no longer exists in its original project."
        case .worktreeUnavailable:
            "The thread’s branch or worktree no longer exists at the recorded location."
        case .threadChanged:
            "The thread changed while its menu was open. Open the menu again to use its current checkout."
        case .branchesUnavailable:
            "The branch list could not be loaded. Check the connection and try again."
        }
    }
}

enum ThreadNewTaskAvailability: Equatable, Sendable {
    case available(ThreadNewTaskSeedRequest)
    case unavailable(ThreadNewTaskUnavailableReason)

    var menuTitle: String {
        switch self {
        case let .available(request):
            "New thread on \(request.branch)"
        case let .unavailable(reason):
            reason.menuTitle
        }
    }

    var isEnabled: Bool {
        if case .available = self { return true }
        return false
    }
}

struct ThreadNewTaskResolvedSeed: Equatable, Sendable {
    let request: ThreadNewTaskSeedRequest
    let branch: FeatureWorkspaceBranch

    func belongs(to projectID: String) -> Bool {
        request.projectID == projectID
    }

    var workspace: FeatureComposerWorkspaceDraft {
        FeatureComposerWorkspaceDraft(
            mode: .local,
            branch: branch.name,
            worktreePath: request.worktreePath,
            startFromOrigin: false
        )
    }

    func applying(to draft: FeatureComposerDraft) -> FeatureComposerDraft {
        var seeded = draft
        seeded.workspace = workspace
        return seeded
    }
}

struct ThreadNewTaskPresentation: Identifiable, Equatable, Sendable {
    let id: UUID
    let initialProjectID: String?
    let resolvedSeed: ThreadNewTaskResolvedSeed?

    static func newTask(initialProjectID: String? = nil) -> Self {
        Self(id: UUID(), initialProjectID: initialProjectID, resolvedSeed: nil)
    }

    static func sameBranch(_ seed: ThreadNewTaskResolvedSeed) -> Self {
        Self(id: UUID(), initialProjectID: seed.request.projectID, resolvedSeed: seed)
    }
}

enum ThreadNewTaskSeedModel {
    static func availability(
        for thread: FeatureThread,
        projects: [FeatureProject]
    ) -> ThreadNewTaskAvailability {
        guard let branch = nonEmpty(thread.branch) else {
            return .unavailable(.missingBranch)
        }
        guard let project = projects.first(where: { $0.id == thread.projectID }) else {
            return .unavailable(.projectUnavailable)
        }
        if let threadEnvironmentID = nonEmpty(thread.environmentID),
           threadEnvironmentID != project.environmentID {
            return .unavailable(.environmentUnavailable)
        }
        let worktreePath: String?
        if let path = thread.worktreePath {
            guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .unavailable(.worktreeUnavailable)
            }
            worktreePath = standardized(path)
        } else {
            worktreePath = nil
        }
        return .available(ThreadNewTaskSeedRequest(
            sourceThreadID: thread.id,
            projectID: project.id,
            environmentID: project.environmentID,
            branch: branch,
            worktreePath: worktreePath,
            projectRootPath: worktreePath == nil ? standardized(project.path) : nil
        ))
    }

    static func resolve(
        _ request: ThreadNewTaskSeedRequest,
        currentThread: FeatureThread?,
        projects: [FeatureProject],
        branches: [FeatureWorkspaceBranch]
    ) -> Result<ThreadNewTaskResolvedSeed, ThreadNewTaskUnavailableReason> {
        guard let currentThread, currentThread.id == request.sourceThreadID else {
            return .failure(.threadChanged)
        }
        guard let project = projects.first(where: { $0.id == request.projectID }) else {
            return .failure(.projectUnavailable)
        }
        guard project.environmentID == request.environmentID else {
            return .failure(.environmentUnavailable)
        }
        if let projectRootPath = request.projectRootPath,
           standardized(project.path) != projectRootPath {
            return .failure(.threadChanged)
        }
        guard case let .available(currentRequest) = availability(
            for: currentThread,
            projects: projects
        ), currentRequest == request else {
            return .failure(.threadChanged)
        }
        let branchResolution = resolveBranch(
            for: request,
            branches: branches
        )
        guard case let .success(branch) = branchResolution else {
            if case let .failure(reason) = branchResolution { return .failure(reason) }
            return .failure(.worktreeUnavailable)
        }
        return .success(ThreadNewTaskResolvedSeed(request: request, branch: branch))
    }

    static func revalidate(
        _ seed: ThreadNewTaskResolvedSeed,
        projects: [FeatureProject],
        branches: [FeatureWorkspaceBranch]
    ) -> Result<ThreadNewTaskResolvedSeed, ThreadNewTaskUnavailableReason> {
        guard let project = projects.first(where: { $0.id == seed.request.projectID }) else {
            return .failure(.projectUnavailable)
        }
        guard project.environmentID == seed.request.environmentID else {
            return .failure(.environmentUnavailable)
        }
        if let projectRootPath = seed.request.projectRootPath,
           standardized(project.path) != projectRootPath {
            return .failure(.threadChanged)
        }
        let branchResolution = resolveBranch(
            for: seed.request,
            branches: branches
        )
        guard case let .success(branch) = branchResolution else {
            if case let .failure(reason) = branchResolution { return .failure(reason) }
            return .failure(.worktreeUnavailable)
        }
        return .success(ThreadNewTaskResolvedSeed(request: seed.request, branch: branch))
    }

    private static func resolveBranch(
        for request: ThreadNewTaskSeedRequest,
        branches: [FeatureWorkspaceBranch]
    ) -> Result<FeatureWorkspaceBranch, ThreadNewTaskUnavailableReason> {
        let candidates = branches.filter { !$0.isRemote && $0.name == request.branch }
        guard !candidates.isEmpty else { return .failure(.branchUnavailable) }
        if let requestedPath = request.worktreePath {
            guard let branch = candidates.first(where: {
                $0.worktreePath.map(standardized) == requestedPath
            }) else {
                return .failure(.worktreeUnavailable)
            }
            return .success(branch)
        }
        guard let rootPath = request.projectRootPath else {
            return .failure(.worktreeUnavailable)
        }
        guard let branch = candidates.first(where: {
            $0.isCurrent
                && ($0.worktreePath.map(standardized) ?? rootPath) == rootPath
        }) else {
            return .failure(.worktreeUnavailable)
        }
        return .success(branch)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func standardized(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.path
    }
}

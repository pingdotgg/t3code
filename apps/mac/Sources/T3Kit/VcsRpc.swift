// vcs.* / git.* / subscribeVcsStatus RPC family (packages/contracts/src/
// git.ts + vcs.ts, wired in rpc.ts). Branch operations, working-tree status
// (snapshot + live stream), and the stacked git action pipeline
// (commit/push/PR with streamed progress).

import Foundation

// MARK: - Status

public struct VcsWorkingTreeFile: Decodable, Sendable, Hashable {
    public var path: String
    public var insertions: Int
    public var deletions: Int
}

public struct VcsWorkingTree: Decodable, Sendable {
    public var files: [VcsWorkingTreeFile]
    public var insertions: Int
    public var deletions: Int
}

public struct VcsStatusChangeRequest: Decodable, Sendable {
    public var number: Int
    public var title: String
    public var url: String
    public var baseRef: String
    public var headRef: String
    /// "open" | "closed" | "merged"
    public var state: String
}

/// `VcsStatusLocalResult` — repo-local status (no network).
public struct VcsStatusLocal: Decodable, Sendable {
    public var isRepo: Bool
    public var hasPrimaryRemote: Bool
    public var isDefaultRef: Bool
    public var refName: String?
    public var hasWorkingTreeChanges: Bool
    public var workingTree: VcsWorkingTree
}

/// `VcsStatusRemoteResult` — upstream/PR status (may be stale-cached).
public struct VcsStatusRemote: Decodable, Sendable {
    public var hasUpstream: Bool
    public var aheadCount: Int
    public var behindCount: Int
    public var aheadOfDefaultCount: Int?
    public var pr: VcsStatusChangeRequest?
}

/// `vcs.refreshStatus` result: local + remote flattened into one struct.
public struct VcsStatusResult: Decodable, Sendable {
    public var isRepo: Bool
    public var hasPrimaryRemote: Bool
    public var isDefaultRef: Bool
    public var refName: String?
    public var hasWorkingTreeChanges: Bool
    public var workingTree: VcsWorkingTree
    public var hasUpstream: Bool
    public var aheadCount: Int
    public var behindCount: Int
    public var aheadOfDefaultCount: Int?
    public var pr: VcsStatusChangeRequest?
}

/// `subscribeVcsStatus` stream item — TaggedStruct union, discriminated by
/// `_tag` (not `type`).
public enum VcsStatusStreamEvent: Decodable, Sendable {
    case snapshot(local: VcsStatusLocal, remote: VcsStatusRemote?)
    case localUpdated(VcsStatusLocal)
    case remoteUpdated(VcsStatusRemote?)

    private enum CodingKeys: String, CodingKey {
        case tag = "_tag"
        case local, remote
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .tag) {
        case "snapshot":
            self = .snapshot(
                local: try c.decode(VcsStatusLocal.self, forKey: .local),
                remote: try c.decodeIfPresent(VcsStatusRemote.self, forKey: .remote))
        case "localUpdated":
            self = .localUpdated(try c.decode(VcsStatusLocal.self, forKey: .local))
        case "remoteUpdated":
            self = .remoteUpdated(try c.decodeIfPresent(VcsStatusRemote.self, forKey: .remote))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .tag, in: c, debugDescription: "Unknown VcsStatusStreamEvent tag: \(other)")
        }
    }
}

// MARK: - Refs

public struct VcsRef: Decodable, Sendable, Hashable {
    public var name: String
    public var isRemote: Bool?
    public var remoteName: String?
    public var current: Bool
    public var isDefault: Bool
    public var worktreePath: String?
}

public struct VcsListRefsResult: Decodable, Sendable {
    public var refs: [VcsRef]
    public var isRepo: Bool
    public var hasPrimaryRemote: Bool
    public var nextCursor: Int?
    public var totalCount: Int
}

// MARK: - Inputs

struct VcsCwdInput: Encodable, Sendable {
    var cwd: String
}

struct VcsListRefsInput: Encodable, Sendable {
    var cwd: String
    var query: String?
    var refKind: String?
    var limit: Int?
}

struct VcsCreateRefInput: Encodable, Sendable {
    var cwd: String
    var refName: String
    var switchRef: Bool?
}

struct VcsSwitchRefInput: Encodable, Sendable {
    var cwd: String
    var refName: String
}

public struct VcsCreateRefResult: Decodable, Sendable {
    public var refName: String
}

public struct VcsSwitchRefResult: Decodable, Sendable {
    public var refName: String?
}

public struct VcsPullResult: Decodable, Sendable {
    /// "pulled" | "skipped_up_to_date"
    public var status: String
    public var refName: String
    public var upstreamRef: String?
}

// MARK: - Stacked git actions

/// `GitStackedAction` literals.
public enum GitStackedAction: String, Encodable, Sendable {
    case commit
    case push
    case createPR = "create_pr"
    case commitPush = "commit_push"
    case commitPushPR = "commit_push_pr"
}

struct GitRunStackedActionInput: Encodable, Sendable {
    var actionId: String
    var cwd: String
    var action: GitStackedAction
    var commitMessage: String?
    var featureBranch: Bool?
}

public struct GitActionToast: Decodable, Sendable {
    public var title: String
    public var description: String?
    /// `cta.kind == "open_pr"` carries `url`; decoded loosely.
    public var cta: JSONValue?

    public var prURL: String? {
        guard let cta = cta?.objectValue, cta["kind"]?.stringValue == "open_pr" else { return nil }
        return cta["url"]?.stringValue
    }
}

public struct GitRunStackedActionResult: Decodable, Sendable {
    public var toast: GitActionToast
}

/// `git.runStackedAction` streamed progress, discriminated by `kind`.
public enum GitActionProgressEvent: Decodable, Sendable {
    case started(phases: [String])
    case phaseStarted(phase: String, label: String)
    case hookStarted(hookName: String)
    case hookOutput(text: String)
    case hookFinished(hookName: String, exitCode: Int?)
    case finished(GitRunStackedActionResult)
    case failed(phase: String?, message: String)

    private enum CodingKeys: String, CodingKey {
        case kind, phases, phase, label, hookName, text, exitCode, result, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "action_started":
            self = .started(phases: try c.decodeIfPresent([String].self, forKey: .phases) ?? [])
        case "phase_started":
            self = .phaseStarted(
                phase: try c.decode(String.self, forKey: .phase),
                label: try c.decode(String.self, forKey: .label))
        case "hook_started":
            self = .hookStarted(hookName: try c.decode(String.self, forKey: .hookName))
        case "hook_output":
            self = .hookOutput(text: try c.decode(String.self, forKey: .text))
        case "hook_finished":
            self = .hookFinished(
                hookName: try c.decode(String.self, forKey: .hookName),
                exitCode: try c.decodeIfPresent(Int.self, forKey: .exitCode))
        case "action_finished":
            self = .finished(try c.decode(GitRunStackedActionResult.self, forKey: .result))
        case "action_failed":
            self = .failed(
                phase: try c.decodeIfPresent(String.self, forKey: .phase),
                message: try c.decode(String.self, forKey: .message))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c, debugDescription: "Unknown GitActionProgressEvent kind: \(other)")
        }
    }
}

// MARK: - Client methods

extension T3Client {
    /// Live working-tree/branch/PR status for one repo. Snapshot first,
    /// then local/remote deltas.
    public func subscribeVcsStatus(cwd: String) -> AsyncThrowingStream<VcsStatusStreamEvent, Error> {
        streamCall("subscribeVcsStatus", VcsCwdInput(cwd: cwd))
    }

    public func refreshVcsStatus(cwd: String) async throws -> VcsStatusResult {
        try await call("vcs.refreshStatus", VcsCwdInput(cwd: cwd))
    }

    public func listRefs(
        cwd: String, query: String? = nil, refKind: String? = nil, limit: Int? = nil
    ) async throws -> VcsListRefsResult {
        try await call(
            "vcs.listRefs", VcsListRefsInput(cwd: cwd, query: query, refKind: refKind, limit: limit))
    }

    public func createRef(cwd: String, refName: String, switchRef: Bool = true) async throws
        -> VcsCreateRefResult
    {
        try await call(
            "vcs.createRef", VcsCreateRefInput(cwd: cwd, refName: refName, switchRef: switchRef))
    }

    public func switchRef(cwd: String, refName: String) async throws -> VcsSwitchRefResult {
        try await call("vcs.switchRef", VcsSwitchRefInput(cwd: cwd, refName: refName))
    }

    public func pull(cwd: String) async throws -> VcsPullResult {
        try await call("vcs.pull", VcsCwdInput(cwd: cwd))
    }

    /// Streamed commit/push/PR pipeline.
    public func runStackedAction(
        cwd: String, action: GitStackedAction, commitMessage: String? = nil,
        featureBranch: Bool? = nil
    ) -> AsyncThrowingStream<GitActionProgressEvent, Error> {
        streamCall(
            "git.runStackedAction",
            GitRunStackedActionInput(
                actionId: UUID().uuidString, cwd: cwd, action: action,
                commitMessage: commitMessage, featureBranch: featureBranch))
    }
}

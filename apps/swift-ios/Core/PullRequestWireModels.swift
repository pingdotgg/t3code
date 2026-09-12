import Foundation

public enum PullRequestInvolvement: String, Codable, CaseIterable, Sendable {
    case all
    case reviewing
    case authored
}

public enum PullRequestState: String, Codable, CaseIterable, Sendable {
    case open
    case closed
    case merged
}

public enum PullRequestListState: String, Codable, CaseIterable, Sendable {
    case all
    case open
    case closed
    case merged
}

public enum PullRequestReviewDecision: String, Codable, Sendable {
    case approved
    case changesRequested = "changes-requested"
    case reviewRequired = "review-required"
}

public enum PullRequestChecksState: String, Codable, Sendable {
    case passing
    case failing
    case pending
}

public enum PullRequestMergeability: String, Codable, Sendable {
    case mergeable
    case conflicting
    case unknown
}

public enum PullRequestAction: String, Codable, CaseIterable, Sendable {
    case merge
    case ready
    case draft
    case close
    case reopen
    case updateBranch = "update-branch"
    case enableAutoMerge = "enable-auto-merge"
    case disableAutoMerge = "disable-auto-merge"
}

public enum PullRequestMergeMethod: String, Codable, CaseIterable, Sendable {
    case merge
    case squash
    case rebase
}

public enum PullRequestUpdateMethod: String, Codable, CaseIterable, Sendable {
    case merge
    case rebase
}

public enum PullRequestBaseComparison: String, Codable, Sendable {
    case upToDate = "up-to-date"
    case behind
    case unknown
}

public struct PullRequestActor: Codable, Equatable, Sendable {
    public let login: String
    public let name: String?
    public let avatarUrl: String?
}

public struct PullRequestLabel: Codable, Equatable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    public let color: String?
}

public enum PullRequestCheckStatus: String, Codable, Sendable {
    case pending
    case success
    case failure
    case skipped
    case neutral
    case cancelled
}

public struct PullRequestCheck: Codable, Equatable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    public let status: PullRequestCheckStatus
    public let description: String?
    public let url: String?
}

public enum PullRequestReactionContent: String, Codable, CaseIterable, Sendable {
    case thumbsUp = "thumbs-up"
    case thumbsDown = "thumbs-down"
    case laugh
    case hooray
    case confused
    case heart
    case rocket
    case eyes
}

public struct PullRequestReaction: Codable, Equatable, Sendable, Identifiable {
    public var id: PullRequestReactionContent { content }
    public let content: PullRequestReactionContent
    public let count: Int
    public let actors: [String]
    public let viewerHasReacted: Bool
}

public enum PullRequestCommentKind: String, Codable, Sendable {
    case issueComment = "issue-comment"
    case reviewComment = "review-comment"
    case review
}

public struct PullRequestComment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: PullRequestCommentKind
    public let author: PullRequestActor?
    public let body: String
    public let createdAt: String
    public let url: String?
    public let path: String?
    public let reviewState: String?
    public let reactions: [PullRequestReaction]?
}

public enum PullRequestDiffSide: String, Codable, Sendable {
    case left
    case right
}

public enum PullRequestReviewVerdict: String, Codable, CaseIterable, Sendable {
    case comment
    case approve
    case requestChanges = "request-changes"
}

public struct PullRequestThreadComment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let author: PullRequestActor?
    public let body: String
    public let createdAt: String
    public let url: String?
    public let reactions: [PullRequestReaction]?
}

public struct PullRequestReviewThread: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let path: String
    public let line: Int?
    public let side: PullRequestDiffSide
    public let isResolved: Bool
    public let isOutdated: Bool
    public let comments: [PullRequestThreadComment]
    public let commentCount: Int?
    public let nextCommentsCursor: String?
}

public struct PullRequestCommit: Codable, Equatable, Sendable, Identifiable {
    public var id: String { oid }
    public let oid: String
    public let messageHeadline: String
    public let committedDate: String
    public let additions: Int?
    public let deletions: Int?
    public let authors: [PullRequestActor]?
}

public struct PullRequestReviewCapabilities: Codable, Equatable, Sendable {
    public let inlineComment: Bool
    public let reply: Bool
    public let resolve: Bool
    public let verdicts: [PullRequestReviewVerdict]
}

public struct PullRequestEditCapabilities: Codable, Equatable, Sendable {
    public let changeRequest: Bool
    public let comment: Bool
}

public struct PullRequestReviewerCapabilities: Codable, Equatable, Sendable {
    public let request: Bool
    public let listCandidates: Bool
}

public struct PullRequestCapabilities: Codable, Equatable, Sendable {
    public let diff: Bool
    public let comment: Bool
    public let actions: [PullRequestAction]
    public let mergeMethods: [PullRequestMergeMethod]
    public let updateMethods: [PullRequestUpdateMethod]?
    public let search: Bool
    public let reactions: Bool?
    public let review: PullRequestReviewCapabilities
    public let reviewers: PullRequestReviewerCapabilities
    public let edit: PullRequestEditCapabilities?
}

public struct PullRequestViewerPermissions: Codable, Equatable, Sendable {
    public let actions: [PullRequestAction]
    public let comment: Bool
    public let resolve: Bool
    public let verdicts: [PullRequestReviewVerdict]
    public let requestReviewers: Bool
    public let updateMethods: [PullRequestUpdateMethod]?
}

public struct PullRequestMergeCapabilities: Codable, Equatable, Sendable {
    public let merge: Bool
    public let squash: Bool
    public let rebase: Bool
}

public struct PullRequestListFilters: Codable, Equatable, Sendable {
    public let draft: String?
    public let review: String?
    public let checks: String?
    public let labels: [[String]]?
    public let excludedLabels: [String]?
    public let author: String?

    public init(
        draft: String? = nil,
        review: String? = nil,
        checks: String? = nil,
        labels: [[String]]? = nil,
        excludedLabels: [String]? = nil,
        author: String? = nil
    ) {
        self.draft = draft
        self.review = review
        self.checks = checks
        self.labels = labels
        self.excludedLabels = excludedLabels
        self.author = author
    }
}

public struct PullRequestListInput: Codable, Equatable, Sendable {
    public let state: PullRequestListState
    public let involvement: PullRequestInvolvement?
    public let filters: PullRequestListFilters?
    public let projectId: String?
    public let projectIds: [String]?
    public let host: String?
    public let limit: Int?
    public let cursors: [String: String]?
    public let query: String?

    public init(
        state: PullRequestListState = .open,
        involvement: PullRequestInvolvement? = .all,
        filters: PullRequestListFilters? = nil,
        projectId: String? = nil,
        projectIds: [String]? = nil,
        host: String? = nil,
        limit: Int? = 99,
        cursors: [String: String]? = nil,
        query: String? = nil
    ) {
        self.state = state
        self.involvement = involvement
        self.filters = filters
        self.projectId = projectId
        self.projectIds = projectIds
        self.host = host
        self.limit = limit
        self.cursors = cursors
        self.query = query
    }
}

public struct PullRequestListEntry: Codable, Equatable, Sendable, Identifiable {
    public var id: String { "\(host) \(repository)#\(number)" }
    public let provider: SourceControlProviderKind
    public let host: String
    public let projectId: String
    public let projectTitle: String
    public let repository: String
    public let number: Int
    public let title: String
    public let url: String
    public let author: PullRequestActor?
    public let headBranch: String
    public let baseBranch: String
    public let state: PullRequestState
    public let isDraft: Bool
    public let mergeability: PullRequestMergeability
    public let additions: Int
    public let deletions: Int
    public let createdAt: String
    public let updatedAt: String
    public let viewerReviewRequested: Bool
    public let labels: [PullRequestLabel]
    public let reviewDecision: PullRequestReviewDecision?
    public let checksState: PullRequestChecksState?
}

public struct PullRequestProviderSummary: Codable, Equatable, Sendable {
    public let host: String
    public let kind: SourceControlProviderKind
    public let searchesOnHost: Bool
    public let projectCount: Int
    public let configured: Bool
    public let detail: String?
}

public struct PullRequestListProjectError: Codable, Equatable, Sendable, Identifiable {
    public var id: String { projectId }
    public let projectId: String
    public let projectTitle: String
    public let message: String
}

public struct PullRequestListResult: Codable, Equatable, Sendable {
    public let viewers: [String: String]
    public let providers: [PullRequestProviderSummary]
    public let entries: [PullRequestListEntry]
    public let errors: [PullRequestListProjectError]
    public let truncated: Bool
    public let nextCursors: [String: String]

    func appending(_ page: Self) -> Self {
        var entryIDs = Set(entries.map(\.id))
        var providerHosts = Set(providers.map(\.host))
        var errorProjectIDs = Set(errors.map(\.projectId))

        return Self(
            viewers: viewers.merging(page.viewers) { _, latest in latest },
            providers: providers + page.providers.filter {
                providerHosts.insert($0.host).inserted
            },
            entries: entries + page.entries.filter {
                entryIDs.insert($0.id).inserted
            },
            errors: errors + page.errors.filter {
                errorProjectIDs.insert($0.projectId).inserted
            },
            truncated: page.truncated,
            nextCursors: page.nextCursors
        )
    }
}

public struct PullRequestRef: Codable, Equatable, Hashable, Sendable {
    public let projectId: String
    public let repository: String
    public let number: Int

    public init(projectId: String, repository: String, number: Int) {
        self.projectId = projectId
        self.repository = repository
        self.number = number
    }

    var jsonObject: [String: JSONValue] {
        get throws {
            guard case let .object(value) = try JSONValue.encode(self) else { return [:] }
            return value
        }
    }
}

public struct PullRequestDetail: Codable, Equatable, Sendable {
    public let provider: SourceControlProviderKind
    public let capabilities: PullRequestCapabilities
    public let viewerPermissions: PullRequestViewerPermissions
    public let projectId: String
    public let projectTitle: String
    public let workspaceRoot: String
    public let repository: String
    public let number: Int
    public let title: String
    public let body: String
    public let url: String
    public let author: PullRequestActor?
    public let state: PullRequestState
    public let isDraft: Bool
    public let mergeability: PullRequestMergeability
    public let additions: Int
    public let deletions: Int
    public let changedFiles: Int
    public let headBranch: String
    public let baseBranch: String
    public let createdAt: String
    public let updatedAt: String
    public let mergedAt: String?
    public let closedAt: String?
    public let reviewers: [PullRequestActor]
    public let labels: [PullRequestLabel]
    public let checks: [PullRequestCheck]
    public let mergeCapabilities: PullRequestMergeCapabilities
    public let viewer: String?
    public let baseComparison: PullRequestBaseComparison?
    public let behindBy: Int?
    public let autoMergeEnabled: Bool?
}

public struct PullRequestActivity: Codable, Equatable, Sendable {
    public let author: PullRequestActor?
    public let reviewers: [PullRequestActor]?
    public let comments: [PullRequestComment]
    public let commentCount: Int
    public let commentsTruncated: Bool
    public let reviewThreads: [PullRequestReviewThread]
    public let commits: [PullRequestCommit]
    public let reactions: [PullRequestReaction]?
}

public struct PullRequestDiffInput: Codable, Equatable, Sendable {
    public let projectId: String
    public let repository: String
    public let number: Int
    public let cursor: String?
    public let commit: String?
}

public struct PullRequestOmittedFileStat: Codable, Equatable, Sendable {
    public let path: String
    public let additions: Double
    public let deletions: Double
}

public struct PullRequestDiffResult: Codable, Equatable, Sendable {
    public let patch: String
    public let truncated: Bool
    public let nextCursor: String?
    public let omittedFileStats: [PullRequestOmittedFileStat]?
}

public struct PullRequestReviewPosition: Codable, Equatable, Sendable {
    public let kind: String
    public let newLine: Int?
    public let oldLine: Int?
    public let side: PullRequestDiffSide?

    public static func added(_ line: Int) -> Self {
        .init(kind: "added", newLine: line, oldLine: nil, side: nil)
    }

    public static func deleted(_ line: Int) -> Self {
        .init(kind: "deleted", newLine: nil, oldLine: line, side: nil)
    }

    public static func context(old: Int, new: Int, side: PullRequestDiffSide) -> Self {
        .init(kind: "context", newLine: new, oldLine: old, side: side)
    }
}

public struct PullRequestReviewCommentDraft: Codable, Equatable, Sendable, Identifiable {
    public var id = UUID()
    public let path: String
    public let oldPath: String?
    public let position: PullRequestReviewPosition
    public var body: String

    enum CodingKeys: String, CodingKey { case path, oldPath, position, body }

    public init(
        id: UUID = UUID(),
        path: String,
        oldPath: String? = nil,
        position: PullRequestReviewPosition,
        body: String
    ) {
        self.id = id
        self.path = path
        self.oldPath = oldPath
        self.position = position
        self.body = body
    }
}

public struct PullRequestReviewerCandidate: Codable, Equatable, Sendable, Identifiable {
    public let login: String
    public let name: String?
    public let avatarUrl: String?
    public let id: String
    public let kind: String
    public let isRequested: Bool
}

public struct PullRequestReviewerCandidateList: Codable, Equatable, Sendable {
    public let candidates: [PullRequestReviewerCandidate]
    public let truncated: Bool
}

public struct FeaturePullRequestEnvironmentList: Identifiable, Equatable, Sendable {
    public var id: String { environmentID }
    public let environmentID: String
    public let environmentName: String
    public let result: PullRequestListResult?
    public let errorMessage: String?

    public init(
        environmentID: String,
        environmentName: String,
        result: PullRequestListResult?,
        errorMessage: String?
    ) {
        self.environmentID = environmentID
        self.environmentName = environmentName
        self.result = result
        self.errorMessage = errorMessage
    }
}

public struct FeaturePullRequestTarget: Hashable, Sendable {
    public let environmentID: String
    public let environmentName: String
    public let reference: PullRequestRef

    public init(environmentID: String, environmentName: String, reference: PullRequestRef) {
        self.environmentID = environmentID
        self.environmentName = environmentName
        self.reference = reference
    }
}

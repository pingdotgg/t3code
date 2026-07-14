import Foundation

public struct T3PullRequestReviewAuthor: Decodable, Sendable {
    public var login: String
    public var avatarUrl: String?
    public var isBot: Bool
}

public struct T3PullRequestReviewComment: Decodable, Sendable {
    public var id: String
    public var author: T3PullRequestReviewAuthor
    public var authorAssociation: String?
    public var body: String
    public var url: String
    public var createdAt: String
    public var updatedAt: String
}

public struct T3PullRequestReviewSummary: Decodable, Sendable {
    public var id: String
    public var author: T3PullRequestReviewAuthor
    public var authorAssociation: String?
    public var body: String
    public var url: String
    public var createdAt: String
    public var updatedAt: String
    public var state: String
}

public struct T3PullRequestReviewThread: Decodable, Sendable {
    public var id: String
    public var isResolved: Bool
    public var isOutdated: Bool
    public var path: String
    public var line: Int?
    public var originalLine: Int?
    public var diffSide: String?
    public var comments: [T3PullRequestReviewComment]
}

public struct T3PullRequestReviewSnapshot: Decodable, Sendable {
    public var provider: String
    public var number: Int
    public var url: String
    public var comments: [T3PullRequestReviewComment]
    public var reviews: [T3PullRequestReviewSummary]
    public var threads: [T3PullRequestReviewThread]
    public var unresolvedThreadCount: Int
    public var truncated: Bool
}

private struct PullRequestReviewInput: Encodable, Sendable {
    var cwd: String
    var reference: String
}

extension T3Client {
    public func getPullRequestReview(cwd: String, reference: String) async throws
        -> T3PullRequestReviewSnapshot
    {
        try await call(
            "review.getPullRequest",
            PullRequestReviewInput(cwd: cwd, reference: reference))
    }
}

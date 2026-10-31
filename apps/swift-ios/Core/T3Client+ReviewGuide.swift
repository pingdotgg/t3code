import Foundation

public struct PullRequestReviewGuideAttention: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case tradeoff, contract, product, risk, accessibility
    }
    public let kind: Kind
    public let note: String
}

public struct PullRequestReviewGuideExcerpt: Codable, Equatable, Sendable {
    public enum Side: String, Codable, Sendable { case new, old }
    public let path: String
    public let side: Side
    public let start: Int
    public let end: Int
    public let caption: String
}

public struct PullRequestReviewGuideNote: Codable, Equatable, Sendable {
    public let path: String
    public let line: Int
    public let title: String
    public let body: String
}

public struct PullRequestReviewGuideStop: Codable, Equatable, Sendable {
    public struct File: Codable, Equatable, Sendable {
        public let path: String
        public let note: String?
    }
    public let title: String
    public let summary: String
    public let attention: PullRequestReviewGuideAttention?
    public let excerpts: [PullRequestReviewGuideExcerpt]
    public let files: [File]
    public let notes: [PullRequestReviewGuideNote]
    public let questions: [String]
}

public struct PullRequestReviewGuide: Codable, Equatable, Sendable {
    public let headSha: String
    public let generatedAt: String
    public let modelSelection: ModelSelection
    public let stops: [PullRequestReviewGuideStop]
}

public enum PullRequestReviewGuideRun: Codable, Equatable, Sendable {
    case running(headSha: String, startedAt: String)
    case failed(headSha: String, failedAt: String, detail: String)

    private enum CodingKeys: String, CodingKey {
        case tag = "_tag"
        case headSha, startedAt, failedAt, detail
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let head = try container.decode(String.self, forKey: .headSha)
        switch try container.decode(String.self, forKey: .tag) {
        case "Running":
            self = .running(headSha: head, startedAt: try container.decode(String.self, forKey: .startedAt))
        case "Failed":
            self = .failed(headSha: head, failedAt: try container.decode(String.self, forKey: .failedAt),
                           detail: try container.decode(String.self, forKey: .detail))
        default:
            throw DecodingError.dataCorruptedError(forKey: .tag, in: container, debugDescription: "Unknown review guide run")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .running(head, started):
            try container.encode("Running", forKey: .tag)
            try container.encode(head, forKey: .headSha)
            try container.encode(started, forKey: .startedAt)
        case let .failed(head, failed, detail):
            try container.encode("Failed", forKey: .tag)
            try container.encode(head, forKey: .headSha)
            try container.encode(failed, forKey: .failedAt)
            try container.encode(detail, forKey: .detail)
        }
    }
}

public struct PullRequestReviewGuideResult: Codable, Equatable, Sendable {
    public let guide: PullRequestReviewGuide?
    public let run: PullRequestReviewGuideRun?
    public let currentHeadSha: String?

    public var isRunning: Bool {
        if case .running = run { return true }
        return false
    }

    public var isStale: Bool {
        guard let guide, let currentHeadSha else { return false }
        return guide.headSha != currentHeadSha
    }

    public var failure: String? {
        guard case let .failed(head, _, detail) = run, head == currentHeadSha else { return nil }
        return detail
    }
}

extension T3Client {
    // Decode only this setting so older hosts remain gated without changing shared settings models.
    private struct ReviewGuideSettings: Decodable, Sendable {
        let reviewGuidesEnabled: Bool?
    }

    public func reviewGuidesEnabled() async throws -> Bool {
        let settings = try await serverSettings(as: ReviewGuideSettings.self)
        return settings.reviewGuidesEnabled == true
    }

    public func pullRequestReviewGuide(_ reference: PullRequestRef) async throws -> PullRequestReviewGuideResult {
        try await rpc.request("pullRequests.reviewGuide", payload: try JSONValue.encode(reference),
                              as: PullRequestReviewGuideResult.self)
    }

    public func generatePullRequestReviewGuide(_ reference: PullRequestRef) async throws -> PullRequestReviewGuideResult {
        try await rpc.request("pullRequests.generateReviewGuide", payload: try JSONValue.encode(reference),
                              as: PullRequestReviewGuideResult.self)
    }
}

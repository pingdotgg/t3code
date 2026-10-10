import Foundation

/// Wire response from orchestration.searchThreads. IDs are local to its server.
public struct ThreadContentSearchResult: Decodable, Sendable {
    public struct Match: Decodable, Sendable {
        public let threadId: String
        public let projectId: String
        public let source: String
        public let snippet: String
        public let messageCreatedAt: String?
    }

    public let matches: [Match]
}

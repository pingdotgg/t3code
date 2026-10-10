import Foundation

public enum FeatureReviewTarget: Sendable, Equatable, Hashable, Codable {
    case gitSource(String)
    case turn(checkpointID: String, fromTurnCount: Int, toTurnCount: Int)
    case fullThread(toTurnCount: Int)
}

public struct FeatureReviewSource: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String
    public var title: String
    public var target: FeatureReviewTarget

    public init(id: String, title: String, target: FeatureReviewTarget) {
        self.id = id
        self.title = title
        self.target = target
    }
}

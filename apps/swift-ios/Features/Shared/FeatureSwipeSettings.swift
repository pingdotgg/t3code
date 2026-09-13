import Foundation

public enum FeatureSwipeAction: String, CaseIterable, Codable, Sendable {
    case settle, pin, archive, delete
}

public struct FeatureSwipeConfiguration: Codable, Equatable, Sendable {
    public var actions: [FeatureSwipeAction]
    public var fullSwipe: FeatureSwipeAction?

    public init(actions: [FeatureSwipeAction], fullSwipe: FeatureSwipeAction? = nil) {
        self.actions = actions
        self.fullSwipe = fullSwipe
    }

    public var enabledFullSwipe: FeatureSwipeAction? {
        fullSwipe.flatMap { actions.contains($0) ? $0 : nil }
    }

    /// UIKit performs the outermost button on a full swipe. Keep the chosen
    /// action there, and never substitute another action if it is unavailable.
    public var orderedActions: [FeatureSwipeAction] {
        var seen = Set<FeatureSwipeAction>()
        let unique = actions.filter { seen.insert($0).inserted }
        guard let fullSwipe = enabledFullSwipe else { return unique }
        return [fullSwipe] + unique.filter { $0 != fullSwipe }
    }

    public mutating func setEnabled(_ action: FeatureSwipeAction, enabled: Bool) {
        actions.removeAll { $0 == action }
        if enabled {
            actions.append(action)
        } else if fullSwipe == action {
            fullSwipe = nil
        }
    }
}

public struct FeatureSwipeSettings: Codable, Equatable, Sendable {
    public var left: FeatureSwipeConfiguration
    public var right: FeatureSwipeConfiguration

    public init(
        left: FeatureSwipeConfiguration = .init(actions: [.settle, .archive, .delete], fullSwipe: .settle),
        right: FeatureSwipeConfiguration = .init(actions: [.pin], fullSwipe: .pin)
    ) {
        self.left = left
        self.right = right
    }

    public func configuration(leading: Bool, isRightToLeft: Bool) -> FeatureSwipeConfiguration {
        leading != isRightToLeft ? right : left
    }
}

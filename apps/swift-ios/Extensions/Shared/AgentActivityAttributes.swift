import ActivityKit
import Foundation

enum T3AgentActivityPhase: String, Codable, Hashable, Sendable {
    case starting
    case running
    case waitingForApproval = "waiting_for_approval"
    case waitingForInput = "waiting_for_input"
    case completed
    case failed
    case stale

    var systemImage: String {
        switch self {
        case .starting:
            "circle.dotted"
        case .running:
            "arrow.trianglehead.2.clockwise.rotate.90"
        case .waitingForApproval:
            "exclamationmark.circle.fill"
        case .waitingForInput:
            "questionmark.circle.fill"
        case .completed:
            "checkmark.circle.fill"
        case .failed:
            "xmark.octagon.fill"
        case .stale:
            "clock.arrow.circlepath"
        }
    }
}

/// Mirrors `RelayAgentActivityAggregateRow` in packages/contracts/src/relay.ts.
struct T3RelayAgentActivityAggregateRow: Codable, Hashable, Identifiable, Sendable {
    var environmentId: String
    var threadId: String
    var projectTitle: String
    var threadTitle: String
    var modelTitle: String
    var phase: T3AgentActivityPhase
    var status: String
    var updatedAt: String
    var deepLink: String

    var id: String { "\(environmentId):\(threadId)" }

    /// Generate the native query route rather than trusting a web-shaped path.
    var nativeDeepLinkURL: URL? {
        var components = URLComponents()
        components.scheme = T3SharedContainer.urlScheme
        components.host = "threads"
        components.queryItems = [
            URLQueryItem(name: "environment", value: environmentId),
            URLQueryItem(name: "thread", value: threadId),
        ]
        return components.url
    }
}

/// Mirrors `RelayAgentActivityAggregateState` in packages/contracts/src/relay.ts.
struct T3RelayAgentActivityAggregateState: Codable, Hashable, Sendable {
    var title: String
    var subtitle: String
    var activeCount: Int
    var updatedAt: String
    var activities: [T3RelayAgentActivityAggregateRow]

    var attentionFirstActivities: [T3RelayAgentActivityAggregateRow] {
        activities.sorted { left, right in
            let leftPriority = left.phase.presentationPriority
            let rightPriority = right.phase.presentationPriority
            return leftPriority == rightPriority
                ? left.updatedAt > right.updatedAt
                : leftPriority < rightPriority
        }
    }
}

/// This exact type and state envelope are part of the relay/APNs protocol.
/// The relay sends `attributes-type: LiveActivityAttributes`, empty attributes,
/// and `{ name: "AgentActivity", props: "<aggregate JSON>" }` as content state.
struct LiveActivityAttributes: ActivityAttributes, Hashable {
    struct ContentState: Codable, Hashable, Sendable {
        var name: String
        var props: String

        var aggregate: T3RelayAgentActivityAggregateState? {
            guard name == LiveActivityAttributes.activityName,
                  let data = props.data(using: .utf8)
            else {
                return nil
            }
            return try? JSONDecoder().decode(T3RelayAgentActivityAggregateState.self, from: data)
        }

        init(name: String, props: String) {
            self.name = name
            self.props = props
        }

        init(aggregate: T3RelayAgentActivityAggregateState) throws {
            name = LiveActivityAttributes.activityName
            props = String(decoding: try JSONEncoder().encode(aggregate), as: UTF8.self)
        }
    }

    static let activityName = "AgentActivity"
}

extension T3AgentActivityPhase {
    fileprivate var presentationPriority: Int {
        switch self {
        case .waitingForApproval, .waitingForInput: 0
        case .failed: 1
        case .starting, .running: 2
        case .completed, .stale: 3
        }
    }
}

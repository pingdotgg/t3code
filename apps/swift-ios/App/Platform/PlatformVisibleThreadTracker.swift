import Foundation
import Observation

/// Scene navigation owns this state. Wire IDs are never compared across hosts.
@MainActor
@Observable
final class PlatformVisibleThreadTracker {
    static let shared = PlatformVisibleThreadTracker()

    struct Thread: Equatable, Sendable {
        let environmentID: String
        let wireID: String
    }

    private(set) var visibleThread: Thread?

    func setVisibleThread(environmentID: String, wireID: String) {
        visibleThread = Thread(environmentID: environmentID, wireID: wireID)
    }

    func clear(environmentID: String, wireID: String) {
        guard visibleThread == Thread(environmentID: environmentID, wireID: wireID) else { return }
        visibleThread = nil
    }

    func clear() { visibleThread = nil }

    func suppresses(_ route: PlatformRoute?) -> Bool {
        guard let visibleThread, let route else { return false }
        switch route {
        case let .thread(environmentID, threadID),
             let .threadDestination(environmentID, threadID, _):
            return environmentID == visibleThread.environmentID && threadID == visibleThread.wireID
        default:
            return false
        }
    }
}

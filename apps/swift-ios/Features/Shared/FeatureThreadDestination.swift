import Foundation

/// A destination within a thread. Thread identity stays with the owning route.
public enum FeatureThreadDestination: Codable, Hashable, Sendable {
    case files(path: String?, line: Int?)
    case terminal(sessionID: String?)
    case review
    case devices
    case browser(tabID: String?)
    case git
    case gitCommit
    case gitBranches
}

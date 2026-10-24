import Foundation

public enum FeatureSavedConnectionEditResult: Sendable, Equatable {
    case updatedLabel
    case updatedEndpoint
}

@MainActor
public protocol FeatureSavedConnectionEditing: AnyObject {
    @discardableResult
    func editSavedConnection(
        environmentID: String, label: String, endpoint: String
    ) async throws -> FeatureSavedConnectionEditResult
}

@MainActor
public protocol FeatureLiveActivitySetup: AnyObject {
    /// Only an explicit setup action may link the selected enabled bearer hosts.
    /// The local preference must already be saved. Remote failures never undo it.
    func setUpLiveActivityUpdates(
        enabled: Bool, previousEnabled: Bool, environmentIDs: [String]
    ) async throws
}

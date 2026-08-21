import Foundation

struct T3ConnectEnvironmentPresentation: Identifiable, Equatable {
    let linkedEnvironment: T3ConnectCloudEnvironment?
    let savedEnvironment: FeatureEnvironment?

    var id: String {
        linkedEnvironment?.id ?? savedEnvironment?.id ?? ""
    }

    var name: String {
        linkedEnvironment?.environment.label ?? savedEnvironment?.name ?? "T3 environment"
    }

    var isEnabled: Bool {
        savedEnvironment?.isEnabled ?? false
    }

    var isOnline: Bool {
        if savedEnvironment?.connectionState == .connected {
            return true
        }
        return linkedEnvironment?.status?.status == .online
    }
}

enum ConnectionHubPresentation {
    static func directEnvironments(
        in environments: [FeatureEnvironment]
    ) -> [FeatureEnvironment] {
        environments.filter { $0.source == .direct }
    }

    /// T3 Connect owns the account catalog while Core owns the environments
    /// already saved on this iPhone. Join them by server identity so the hub
    /// has one row and one switch for each machine.
    static func t3ConnectEnvironments(
        saved: [FeatureEnvironment],
        linked: [T3ConnectCloudEnvironment]
    ) -> [T3ConnectEnvironmentPresentation] {
        let savedByID = Dictionary(
            uniqueKeysWithValues: saved
                .filter { $0.source == .t3Connect }
                .map { ($0.id, $0) }
        )
        let linkedIDs = Set(linked.map(\.id))
        let linkedRows = linked.map {
            T3ConnectEnvironmentPresentation(
                linkedEnvironment: $0,
                savedEnvironment: savedByID[$0.id]
            )
        }
        let savedOnlyRows: [T3ConnectEnvironmentPresentation] = saved.compactMap { environment in
            guard environment.source == .t3Connect,
                  !linkedIDs.contains(environment.id) else { return nil }
            return T3ConnectEnvironmentPresentation(
                linkedEnvironment: nil,
                savedEnvironment: environment
            )
        }
        return linkedRows + savedOnlyRows
    }
}

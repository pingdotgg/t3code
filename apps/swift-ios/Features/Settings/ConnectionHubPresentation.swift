import Foundation

enum ConnectionHubStatus: Equatable {
    case disabled
    case checking
    case connecting
    case offline
    case online

    var title: String {
        switch self {
        case .disabled: "Off"
        case .checking: "Checking"
        case .connecting: "Connecting"
        case .offline: "Offline"
        case .online: "Online"
        }
    }
}

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

    var endpoint: String? {
        linkedEnvironment?.environment.endpoint.httpBaseUrl ?? savedEnvironment?.endpoint
    }

    var isOnline: Bool {
        status == .online
    }

    var status: ConnectionHubStatus {
        connectionStatus()
    }

    func connectionStatus(
        pendingEnabled: Bool? = nil,
        isConnecting: Bool = false
    ) -> ConnectionHubStatus {
        if isConnecting || (pendingEnabled == true && savedEnvironment == nil) {
            return .connecting
        }

        if let savedEnvironment {
            return ConnectionHubPresentation.status(
                for: savedEnvironment,
                pendingEnabled: pendingEnabled
            )
        }

        return switch linkedEnvironment?.status?.status {
        case .online: .online
        case .offline: .offline
        case nil: linkedEnvironment?.statusError == nil ? .checking : .offline
        }
    }
}

enum ConnectionHubPresentation {
    static func status(
        for environment: FeatureEnvironment,
        pendingEnabled: Bool? = nil
    ) -> ConnectionHubStatus {
        guard pendingEnabled ?? environment.isEnabled else { return .disabled }

        if pendingEnabled == true && !environment.isEnabled {
            return .connecting
        }

        return switch environment.connectionState {
        case .connected: .online
        case .connecting, .reconnecting: .connecting
        case .disconnected: .offline
        case nil: .checking
        }
    }

    static func disambiguatingEndpoint(
        _ endpoint: String,
        for name: String,
        among names: [String]
    ) -> String? {
        let matchingNames = names.filter {
            $0.localizedCaseInsensitiveCompare(name) == .orderedSame
        }
        guard matchingNames.count > 1,
              let components = URLComponents(string: endpoint),
              let host = components.host else { return nil }

        return components.port.map { "\(host):\($0)" } ?? host
    }

    static func directEnvironments(
        in environments: [FeatureEnvironment]
    ) -> [FeatureEnvironment] {
        environments.enumerated()
            .filter { $0.element.source == .direct }
            .sorted { first, second in
                if first.element.isEnabled != second.element.isEnabled {
                    return first.element.isEnabled
                }
                return first.offset < second.offset
            }
            .map(\.element)
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

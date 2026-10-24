import Foundation

enum RemoteDevicePlatform: String, Codable, Sendable {
    case ios, android
}

struct RemoteDeviceSummary: Decodable, Equatable, Sendable {
    let hostId: String
    let id: String
    let platform: RemoteDevicePlatform
    let name: String
    let version: String
    let booted: Bool
    let physical: Bool
}

struct RemoteDeviceSession: Decodable, Equatable, Sendable {
    let threadId: String
    let hostId: String
    let deviceId: String
    let platform: RemoteDevicePlatform
    let openedAt: String
}

struct RemoteDeviceToolVersion: Decodable, Equatable, Sendable {
    let requiredVersion: String
    let installedVersions: [String]
    let runningVersion: String?
}

struct RemoteDeviceToolVersions: Decodable, Equatable, Sendable {
    let hub: RemoteDeviceToolVersion
    let agent: RemoteDeviceToolVersion

    var updatePending: Bool {
        [hub, agent].contains {
            !$0.installedVersions.isEmpty && !$0.installedVersions.contains($0.requiredVersion)
        }
    }

    var labels: [String] {
        [("Device hub", hub), ("Agent tools", agent)].map { name, tool in
            let installed = tool.installedVersions.isEmpty ? "none" : tool.installedVersions.joined(separator: ", ")
            let running = tool.runningVersion.map { "; running \($0)" } ?? ""
            return "\(name): installed \(installed); required \(tool.requiredVersion)\(running)."
        }
    }
}

struct RemoteDeviceHost: Decodable, Equatable, Identifiable, Sendable {
    struct PlatformAvailability: Decodable, Equatable, Sendable {
        let platform: RemoteDevicePlatform
        let available: Bool
        let reason: String?
    }

    let id: String
    let kind: String
    let label: String
    let platforms: [PlatformAvailability]
    let tools: RemoteDeviceToolVersions?
    let toolInspectionError: String?
    let hubInstalled: Bool
    let agentDeviceInstalled: Bool
}

struct RemoteDeviceHostStatus: Decodable, Equatable, Sendable {
    let status: String
    let detail: String?
}

struct RemoteDeviceServiceState: Decodable, Equatable, Sendable {
    let supportsHostRetry: Bool?
    let supportsToolUpdate: Bool?
    let supportsToolInspection: Bool?
    let hosts: [RemoteDeviceHost]
    let hostStatus: String
    let hostStatusDetail: String?
    let hostStatuses: [String: RemoteDeviceHostStatus]
    let devices: [RemoteDeviceSummary]
    let sessions: [RemoteDeviceSession]
    let onboardingCompleted: Bool
    let agentAccessEnabled: Bool
    let hubBasePath: String
    let revision: Int
}

/// The hub proxy accepts a session ticket on media and input requests. Long-lived
/// bearer credentials and DPoP proofs never enter the WebView.
struct RemoteDeviceHubAccess: Codable, Equatable, Sendable {
    let httpBase: String
    let wsBase: String
    let query: [String: String]
    let credentials: Bool

    static func ticketed(
        environmentURL: URL, hubBasePath: String, hostID: String, ticket: String
    ) throws -> Self {
        guard hubBasePath.hasPrefix("/"), !hubBasePath.hasPrefix("//"),
              !hubBasePath.contains("?"), !hubBasePath.contains("#"),
              !hostID.isEmpty, !ticket.isEmpty,
              var components = URLComponents(url: environmentURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme, ["http", "https"].contains(scheme),
              components.host != nil else {
            throw RemoteDeviceError.invalidHubAddress
        }
        components.path = hubBasePath.hasSuffix("/") ? String(hubBasePath.dropLast()) : hubBasePath
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        guard let http = components.url else { throw RemoteDeviceError.invalidHubAddress }
        components.scheme = scheme == "https" ? "wss" : "ws"
        guard let ws = components.url else { throw RemoteDeviceError.invalidHubAddress }
        return Self(
            httpBase: http.absoluteString, wsBase: ws.absoluteString,
            query: ["wsTicket": ticket, "hostId": hostID], credentials: false
        )
    }
}

enum RemoteDeviceError: LocalizedError {
    case unsupported, invalidHubAddress, sessionClosed, missingStreamResource

    var errorDescription: String? {
        switch self {
        case .unsupported: "This server does not support remote devices. Update the server to use this feature."
        case .invalidHubAddress: "The device hub address is invalid."
        case .sessionClosed: "This device session has closed."
        case .missingStreamResource: "The device viewer is missing from this app build."
        }
    }

    static func isUnsupported(_ error: any Error) -> Bool {
        guard let message = (error as? RPCError)?.remoteMessage else { return false }
        let value = message.lowercased()
        return ["unsupported method", "unknown rpc", "unknown request", "method not found"]
            .contains(where: value.contains)
    }
}

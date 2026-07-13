// T3KitConfig — app-facing configuration for connecting T3Kit to the t3
// server sidecar that SidecarKit spawns (ARCHITECTURE.md "Sidecar contract":
// loopback host, desktop-managed-local auth; wire-protocol.md §1.1 default
// port).
//
// The embedding app (SergeCodeMac) constructs one of these once SidecarKit's
// readiness poll succeeds and the `desktopBootstrapToken` from
// `DesktopBackendBootstrap` is known, then derives `authConfig` to build an
// `AuthClient` (AuthClient.swift).

import Foundation

/// Everything T3Kit needs to know to reach one running t3 server sidecar.
public struct T3KitConfig: Sendable {
    /// Loopback host the sidecar bound to, e.g. `"127.0.0.1"`.
    public let host: String
    /// Port the sidecar's HTTP/WebSocket server is listening on (default
    /// `T3Kit.defaultPort` = 3773, wire-protocol.md §1.1 `DEFAULT_PORT`).
    public let port: Int
    /// One-shot bootstrap credential handed to the sidecar over stdin
    /// (`DesktopBackendBootstrap.desktopBootstrapToken`).
    public let desktopBootstrapToken: String

    public init(host: String = "127.0.0.1", port: Int = T3Kit.defaultPort, desktopBootstrapToken: String) {
        self.host = host
        self.port = port
        self.desktopBootstrapToken = desktopBootstrapToken
    }

    /// `http://<host>:<port>` — base for the local auth HTTP API (§1.2).
    public var httpBaseURL: URL {
        baseURL(scheme: "http")
    }

    /// `ws://<host>:<port>` — base for the RPC socket; `AuthClient` forces
    /// the path to `/ws` on every connect (§1.1).
    public var wsBaseURL: URL {
        baseURL(scheme: "ws")
    }

    private func baseURL(scheme: String) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = Self.componentsHost(host)
        components.port = port
        guard let url = components.url else {
            preconditionFailure("Invalid T3Kit server address: \(host):\(port)")
        }
        return url
    }

    private static func componentsHost(_ host: String) -> String {
        guard host.contains(":"), !(host.hasPrefix("[") && host.hasSuffix("]")) else {
            return host
        }
        return "[\(host)]"
    }

    /// Derives the `AuthConfig` consumed by `AuthClient`.
    public var authConfig: AuthConfig {
        AuthConfig(httpBaseURL: httpBaseURL, wsBaseURL: wsBaseURL, desktopBootstrapToken: desktopBootstrapToken)
    }
}

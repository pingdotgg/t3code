import Foundation

public struct ConnectionProbeResult: Equatable, Sendable {
    public let baseURL: URL
    public let descriptor: EnvironmentDescriptor
    public let latency: Duration
}

public enum ConnectionProbeError: LocalizedError, Equatable, Sendable {
    case invalidURL
    case unavailableHost(String)
    case timeout(String)
    case likelyLocalNetworkDenied(String)
    case serverRejected(status: Int, message: String)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            "Enter a valid T3 server address."
        case let .unavailableHost(host):
            "Could not reach \(host). Check that the server is running and both devices are online."
        case let .timeout(host):
            "\(host) did not respond in time."
        case let .likelyLocalNetworkDenied(host):
            "Local Network access appears to be off for T3 Code. Allow it in Settings, then retry \(host)."
        case let .serverRejected(status, message):
            "\(message) (HTTP \(status))"
        case let .transport(message):
            message
        }
    }
}

/// Performs the public environment-descriptor request before token exchange.
///
/// iOS does not expose a direct Local Network privacy authorization query. A
/// real connection attempt is the authoritative way to trigger/check access;
/// failures carrying POSIX permission evidence are reported separately from an
/// offline server.
public actor LocalNetworkProbe {
    private let transport: any HTTPTransport

    public init(transport: any HTTPTransport = URLSessionHTTPTransport()) {
        self.transport = transport
    }

    public func probe(
        address rawAddress: String,
        timeout: TimeInterval = 5
    ) async throws -> ConnectionProbeResult {
        let fields: PairingInputFields
        do {
            fields = try PairingURL.parseFields(rawAddress)
        } catch {
            throw ConnectionProbeError.invalidURL
        }
        guard let baseURL = try? PairingURL.httpBaseURL(for: fields.host),
              let host = baseURL.host else {
            throw ConnectionProbeError.invalidURL
        }

        var request = URLRequest(
            url: endpoint(baseURL, path: "/.well-known/t3/environment"),
            timeoutInterval: max(1, timeout)
        )
        request.httpMethod = "GET"
        let clock = ContinuousClock()
        let startedAt = clock.now
        do {
            let (data, response) = try await transport.data(
                for: HTTPRequestPolicy.prepare(request)
            )
            guard (200..<300).contains(response.statusCode) else {
                let body = try? JSONDecoder.t3.decode(JSONValue.self, from: data)
                throw ConnectionProbeError.serverRejected(
                    status: response.statusCode,
                    message: body?["message"]?.stringValue
                        ?? body?["reason"]?.stringValue
                        ?? "The server rejected the connection probe."
                )
            }
            let descriptor = try JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: data)
            return ConnectionProbeResult(
                baseURL: baseURL,
                descriptor: descriptor,
                latency: startedAt.duration(to: clock.now)
            )
        } catch let error as ConnectionProbeError {
            throw error
        } catch {
            throw Self.classify(error, host: host, isLocal: Self.isLocalHost(host))
        }
    }

    public static func classify(
        _ error: any Error,
        host: String,
        isLocal: Bool
    ) -> ConnectionProbeError {
        let nsError = error as NSError
        let urlCode = URLError.Code(rawValue: nsError.code)
        if nsError.domain == NSURLErrorDomain {
            switch urlCode {
            case .timedOut:
                return .timeout(host)
            case .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost:
                if isLocal, hasPermissionDenialEvidence(nsError) {
                    return .likelyLocalNetworkDenied(host)
                }
                return .unavailableHost(host)
            case .notConnectedToInternet, .networkConnectionLost, .internationalRoamingOff,
                 .dataNotAllowed:
                if isLocal, hasPermissionDenialEvidence(nsError) {
                    return .likelyLocalNetworkDenied(host)
                }
                return .unavailableHost(host)
            default:
                break
            }
        }
        if isLocal, hasPermissionDenialEvidence(nsError) {
            return .likelyLocalNetworkDenied(host)
        }
        return .transport(nsError.localizedDescription)
    }

    public static func isLocalHost(_ host: String) -> Bool {
        let value = host
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            .lowercased()
        if value == "localhost" || value == "::1" || value.hasSuffix(".local") {
            return true
        }
        if value.hasPrefix("10.")
            || value.hasPrefix("127.")
            || value.hasPrefix("192.168.")
            || value.hasPrefix("169.254.")
        {
            return true
        }
        let octets = value.split(separator: ".").compactMap { Int($0) }
        if octets.count == 4, octets[0] == 172, (16...31).contains(octets[1]) {
            return true
        }
        // IPv6 unique-local and link-local ranges.
        return value.hasPrefix("fc")
            || value.hasPrefix("fd")
            || value.hasPrefix("fe8")
            || value.hasPrefix("fe9")
            || value.hasPrefix("fea")
            || value.hasPrefix("feb")
    }

    private static func hasPermissionDenialEvidence(_ error: NSError) -> Bool {
        if error.domain == NSPOSIXErrorDomain, error.code == 1 || error.code == 13 {
            return true
        }
        let description = [
            error.localizedDescription,
            error.localizedFailureReason,
            error.localizedRecoverySuggestion,
            String(describing: error.userInfo),
        ]
        .compactMap { $0 }
        .joined(separator: " ")
        .lowercased()
        if description.contains("local network prohibited")
            || description.contains("localnetworkdenied")
            || description.contains("local network denied")
        {
            return true
        }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            return hasPermissionDenialEvidence(underlying)
        }
        return false
    }
}

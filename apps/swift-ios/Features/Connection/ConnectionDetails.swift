import Foundation

struct ConnectionDetails: Equatable, Sendable {
    var endpoint: String
    var pairingCode: String?
}

enum ConnectionDetailsError: LocalizedError, Equatable {
    case empty
    case invalidAddress
    case unsupportedScheme

    var errorDescription: String? {
        switch self {
        case .empty:
            "Paste a T3 pairing link or enter your server address."
        case .invalidAddress:
            "That connection link does not include a valid server address."
        case .unsupportedScheme:
            "Use an HTTP or HTTPS T3 server address."
        }
    }
}

/// Parses the pairing links emitted by local, shared, and hosted T3 environments.
enum ConnectionDetailsParser {
    private static let tokenNames = [
        "token",
        "pairing_token",
        "pairingToken",
        "pairing_code",
        "pairingCode",
        "code",
    ]
    private static let endpointNames = ["host", "endpoint", "server", "url"]
    private static let wrappedPairingURLNames = ["pairingUrl", "pairing_url"]

    static func parse(_ input: String) throws -> ConnectionDetails {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ConnectionDetailsError.empty }

        let extracted = trimmed.lowercased().hasPrefix("t3code:")
            ? trimmed
            : (firstURL(in: trimmed) ?? trimmed)
        let candidate = trimmingTrailingProsePunctuation(extracted)
        let loweredCandidate = candidate.lowercased()
        if candidate.contains("://")
            || loweredCandidate.hasPrefix("t3code:")
            || loweredCandidate.hasPrefix("t3:") {
            return try parseURL(candidate)
        }

        let pieces = candidate
            .split(whereSeparator: \.isWhitespace)
            .map(String.init)
        guard let address = pieces.first else { throw ConnectionDetailsError.empty }
        let code = pieces.dropFirst().first(where: { !$0.isEmpty })
        return ConnectionDetails(
            endpoint: try normalizedEndpoint(address),
            pairingCode: normalizedCode(code)
        )
    }

    static func normalizedEndpoint(_ input: String) throws -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ConnectionDetailsError.empty }

        let value: String
        if trimmed.contains("://") {
            value = trimmed
        } else {
            let address = bracketBareIPv6(trimmed)
            value = "\(EndpointNetworkScope.isLocalHost(trimmed) ? "http" : "https")://\(address)"
        }

        guard var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased()
        else {
            throw ConnectionDetailsError.invalidAddress
        }

        switch scheme {
        case "http", "https":
            break
        case "ws":
            components.scheme = "http"
        case "wss":
            components.scheme = "https"
        default:
            throw ConnectionDetailsError.unsupportedScheme
        }

        guard let host = components.host, !host.isEmpty else {
            throw ConnectionDetailsError.invalidAddress
        }

        components.path = ""
        components.query = nil
        components.fragment = nil
        guard var normalized = components.url?.absoluteString else {
            throw ConnectionDetailsError.invalidAddress
        }
        while normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        return normalized
    }

    private static func parseURL(_ input: String) throws -> ConnectionDetails {
        guard let components = URLComponents(string: input),
              let scheme = components.scheme?.lowercased()
        else {
            throw ConnectionDetailsError.invalidAddress
        }

        let fragmentItems = URLComponents(string: "?\(components.fragment ?? "")")?.queryItems ?? []
        let queryItems = components.queryItems ?? []
        let allItems = queryItems + fragmentItems
        let token = firstValue(named: tokenNames, in: allItems)

        if ["t3", "t3code", "t3code-swiftui", "t3code-swiftui-dev"].contains(scheme) {
            if let wrappedPairingURL = firstValue(named: wrappedPairingURLNames, in: allItems) {
                var wrapped = try parse(wrappedPairingURL)
                if wrapped.pairingCode == nil {
                    wrapped.pairingCode = normalizedCode(token)
                }
                return wrapped
            }
            guard let target = firstValue(named: endpointNames, in: allItems) else {
                throw ConnectionDetailsError.invalidAddress
            }
            return ConnectionDetails(
                endpoint: try normalizedEndpoint(target),
                pairingCode: normalizedCode(token)
            )
        }

        guard ["http", "https", "ws", "wss"].contains(scheme) else {
            throw ConnectionDetailsError.unsupportedScheme
        }

        let advertisedHost = firstValue(named: endpointNames, in: queryItems)
        return ConnectionDetails(
            endpoint: try normalizedEndpoint(advertisedHost ?? input),
            pairingCode: normalizedCode(token)
        )
    }

    private static func firstValue(named names: [String], in items: [URLQueryItem]) -> String? {
        items.first { item in
            names.contains { $0.caseInsensitiveCompare(item.name) == .orderedSame }
        }?.value
    }

    private static func normalizedCode(_ input: String?) -> String? {
        let value = input?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    private static func firstURL(in input: String) -> String? {
        guard let expression = try? NSRegularExpression(
            pattern: #"(?i)(?:(?:https?|wss?|t3)://|t3code(?:-swiftui(?:-dev)?)?:(?://)?)[^\s<>"']+"#
        ) else {
            return nil
        }
        let range = NSRange(input.startIndex..., in: input)
        guard let match = expression.firstMatch(in: input, range: range),
              let swiftRange = Range(match.range, in: input)
        else {
            return nil
        }
        return trimmingTrailingProsePunctuation(String(input[swiftRange]))
    }

    /// Pairing links are commonly copied from sentences and terminal output.
    /// Remove punctuation belonging to that prose while retaining balanced URL
    /// delimiters such as the closing bracket around an IPv6 host.
    static func trimmingTrailingProsePunctuation(_ input: String) -> String {
        var value = input
        while let last = value.last {
            let shouldTrim = switch last {
            case ".", ",", ";", "!":
                true
            case "?":
                value.dropLast().contains("?")
            case ")":
                value.filter { $0 == ")" }.count > value.filter { $0 == "(" }.count
            case "]":
                value.filter { $0 == "]" }.count > value.filter { $0 == "[" }.count
            case "}":
                value.filter { $0 == "}" }.count > value.filter { $0 == "{" }.count
            default:
                false
            }
            guard shouldTrim else { break }
            value.removeLast()
        }
        return value
    }

    private static func bracketBareIPv6(_ value: String) -> String {
        guard value.contains(":"),
              !value.hasPrefix("["),
              value.filter({ $0 == ":" }).count > 1
        else {
            return value
        }
        return "[\(value)]"
    }
}

enum EndpointNetworkScope {
    static func isLocal(_ endpoint: String) -> Bool {
        guard let host = URLComponents(string: endpoint)?.host else { return false }
        return isLocalHost(host)
    }

    static func isLocalHost(_ rawHost: String) -> Bool {
        let host = hostWithoutPort(rawHost).lowercased()

        if host == "localhost" || host.hasSuffix(".local") || host == "::1" {
            return true
        }

        let octets = host.split(separator: ".").compactMap { Int($0) }
        if octets.count == 4, octets.allSatisfy({ 0 ... 255 ~= $0 }) {
            return octets[0] == 10
                || octets[0] == 127
                || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 172 && 16 ... 31 ~= octets[1])
                || (octets[0] == 192 && octets[1] == 168)
        }

        guard host.contains(":"),
              let firstHextetText = host.split(separator: ":", omittingEmptySubsequences: true).first,
              let firstHextet = UInt16(firstHextetText, radix: 16)
        else {
            return false
        }
        return firstHextet & 0xffc0 == 0xfe80
            || firstHextet & 0xfe00 == 0xfc00
    }

    private static func hostWithoutPort(_ rawHost: String) -> String {
        let value = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("["),
           let closingBracket = value.firstIndex(of: "]") {
            return String(value[value.index(after: value.startIndex) ..< closingBracket])
        }

        if value.filter({ $0 == ":" }).count == 1,
           let colon = value.lastIndex(of: ":"),
           value[value.index(after: colon)...].allSatisfy(\.isNumber) {
            return String(value[..<colon])
        }
        return value
    }
}

enum ConnectionErrorCopy {
    static func message(for rawMessage: String?) -> String {
        let message = rawMessage?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""

        if message.isEmpty || message == "cancelled" || message == "canceled" {
            return "The connection stopped before it finished. Make sure T3 Code is running, then try again."
        }
        if message.contains("expired") || message.contains("invalid_credential")
            || message.contains("invalid credential") || message.contains("401") {
            return "That pairing code is invalid or has expired. Create a new code on the host and try again."
        }
        if message.contains("timed out") || message.contains("timeout") {
            return "The server took too long to respond. Check the address and that both devices are online."
        }
        if message.contains("offline") || message.contains("network")
            || message.contains("could not connect") || message.contains("not connected") {
            return "This iPhone could not reach the server. Check the address and network, then try again."
        }
        return "T3 Code could not complete pairing. Check the server address and use a fresh pairing code."
    }
}

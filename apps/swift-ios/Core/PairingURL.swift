import Foundation

public struct PairingTarget: Equatable, Sendable {
    public let credential: String
    public let httpBaseURL: URL
    public let webSocketBaseURL: URL
}

/// Display fields produced from pasted text or a scanned QR payload.
public struct PairingInputFields: Equatable, Sendable {
    public let host: String
    public let pairingCode: String
    public let label: String?
}

public enum PairingURLError: LocalizedError, Equatable {
    case emptyInput
    case invalidURL
    case unsupportedScheme
    case missingToken
    case missingHost
    case emptyQRCode
    case invalidQRCode

    public var errorDescription: String? {
        switch self {
        case .emptyInput: "Enter a server address."
        case .invalidURL: "Pairing URL is invalid."
        case .unsupportedScheme: "Pairing URL uses an unsupported scheme."
        case .missingToken: "Pairing URL is missing its token."
        case .missingHost: "Pairing URL is missing its environment host."
        case .emptyQRCode: "Scanned QR code did not contain a pairing URL."
        case .invalidQRCode: "Scanned QR code is not a T3 pairing link."
        }
    }
}

public enum PairingURL {
    private static let supportedSchemes = Set(["http", "https", "ws", "wss"])

    /// Resolves a complete pairing link from a clipboard, universal link, or
    /// QR scanner. `t3code://pair?pairingUrl=...` wrappers are unwrapped.
    public static func resolve(_ rawValue: String) throws -> PairingTarget {
        let extracted = try extractPairingURL(from: rawValue, qrInput: false)
        let fields = try parseFields(extracted)
        return try directTarget(host: fields.host, credential: requireToken(fields.pairingCode))
    }

    /// Resolves split form fields. If the host field contains a complete
    /// pairing URL, its embedded token wins. This lets pasting a full link into
    /// the host field immediately populate both inputs.
    public static func resolve(host: String, pairingCode: String) throws -> PairingTarget {
        let fields = try parseFields(host)
        let embeddedCode = fields.pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
        let code = embeddedCode.isEmpty ? pairingCode : embeddedCode
        return try directTarget(host: fields.host, credential: requireToken(code))
    }

    /// Splits a complete URL or loose `host code` connection string into the
    /// two fields shown by onboarding.
    public static func parseFields(_ rawValue: String) throws -> PairingInputFields {
        let extracted = try extractPairingURL(from: rawValue, qrInput: false)

        if let loose = looseHostAndCode(extracted) {
            let normalized = try normalizedBaseURL(loose.host)
            return PairingInputFields(
                host: displayHost(normalized),
                pairingCode: loose.code,
                label: nil
            )
        }

        guard let components = strictURLComponents(extracted) else {
            // Bare hosts are valid form input even before the code is entered.
            let normalized = try normalizedBaseURL(extracted)
            return PairingInputFields(
                host: displayHost(normalized),
                pairingCode: "",
                label: nil
            )
        }
        try requireSupportedScheme(components.scheme)

        let query = components.queryItems ?? []
        let fragment = queryItems(fromFragment: components.fragment)
        let token = (fragment + query)
            .first(where: { $0.name.caseInsensitiveCompare("token") == .orderedSame })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = query
            .first(where: { $0.name.caseInsensitiveCompare("label") == .orderedSame })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if let hosted = query
            .first(where: { $0.name.caseInsensitiveCompare("host") == .orderedSame })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !hosted.isEmpty
        {
            let normalized = try normalizedBaseURL(hosted)
            return PairingInputFields(
                host: displayHost(normalized),
                pairingCode: token,
                label: label?.isEmpty == false ? label : nil
            )
        }

        guard components.host != nil else { throw PairingURLError.missingHost }
        let normalized = try normalizedBaseURL(extracted)
        return PairingInputFields(
            host: displayHost(normalized),
            pairingCode: token,
            label: label?.isEmpty == false ? label : nil
        )
    }

    /// Extracts a pairing URL from a QR payload. Native deep links generated
    /// by the React Native client are accepted alongside ordinary URLs.
    public static func pairingURL(fromQRCode payload: String) throws -> String {
        try extractPairingURL(from: payload, qrInput: true)
    }

    public static func build(host: String, pairingCode: String) throws -> String {
        let base = try normalizedBaseURL(host)
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/pair"
        components.percentEncodedFragment = URLComponents().withQueryItems([
            URLQueryItem(name: "token", value: try requireToken(pairingCode)),
        ]).percentEncodedQuery
        guard let value = components.url?.absoluteString else {
            throw PairingURLError.invalidURL
        }
        return value
    }

    private static func extractPairingURL(
        from rawValue: String,
        qrInput: Bool
    ) throws -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw qrInput ? PairingURLError.emptyQRCode : PairingURLError.emptyInput
        }

        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "t3code"
        else {
            return trimmed
        }
        let wrapped = components.queryItems?
            .first(where: { $0.name.caseInsensitiveCompare("pairingUrl") == .orderedSame })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !wrapped.isEmpty else {
            throw qrInput ? PairingURLError.invalidQRCode : PairingURLError.invalidURL
        }
        return wrapped
    }

    private static func looseHostAndCode(_ value: String) -> (host: String, code: String)? {
        // URLs legitimately contain percent-encoded or query whitespace, so
        // only use this fallback when the last whitespace-delimited token
        // looks like a compact pairing code.
        let fields = value.split(whereSeparator: \.isWhitespace).map(String.init)
        guard fields.count >= 2, let code = fields.last,
              code.range(of: #"^[A-Za-z0-9_-]{4,256}$"#, options: .regularExpression) != nil
        else {
            return nil
        }
        let host = fields.dropLast().joined(separator: " ")
        guard host.contains(".") || host.contains(":") || host.hasPrefix("/") else {
            return nil
        }
        return (host, code)
    }

    private static func directTarget(host: String, credential: String) throws -> PairingTarget {
        try target(baseURL: normalizedBaseURL(host), credential: credential)
    }

    private static func normalizedBaseURL(_ rawValue: String) throws -> URL {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw PairingURLError.emptyInput }

        let withoutLeadingSlashes = trimmed.replacingOccurrences(
            of: #"^/+"#,
            with: "",
            options: .regularExpression
        )
        let normalized: String
        if withoutLeadingSlashes.range(
            of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#,
            options: .regularExpression
        ) != nil {
            normalized = withoutLeadingSlashes
        } else {
            normalized = "https://\(withoutLeadingSlashes)"
        }
        guard var components = URLComponents(string: normalized),
              components.url != nil
        else {
            throw PairingURLError.invalidURL
        }
        try requireSupportedScheme(components.scheme)
        guard components.host != nil else { throw PairingURLError.missingHost }
        components.path = "/"
        components.query = nil
        components.fragment = nil
        guard let base = components.url else { throw PairingURLError.invalidURL }
        return base
    }

    private static func strictURLComponents(_ value: String) -> URLComponents? {
        guard value.range(
            of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#,
            options: .regularExpression
        ) != nil else {
            return nil
        }
        return URLComponents(string: value)
    }

    private static func queryItems(fromFragment fragment: String?) -> [URLQueryItem] {
        guard let fragment, !fragment.isEmpty else { return [] }
        var components = URLComponents()
        components.percentEncodedQuery = fragment
        return components.queryItems ?? []
    }

    private static func displayHost(_ url: URL) -> String {
        var value = url.absoluteString
        if value.hasSuffix("/") { value.removeLast() }
        return value
    }

    private static func target(baseURL: URL, credential: String) throws -> PairingTarget {
        guard var http = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              var socket = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else {
            throw PairingURLError.invalidURL
        }
        switch http.scheme?.lowercased() {
        case "ws": http.scheme = "http"
        case "wss": http.scheme = "https"
        default: break
        }
        switch socket.scheme?.lowercased() {
        case "http": socket.scheme = "ws"
        case "https": socket.scheme = "wss"
        default: break
        }
        guard let httpURL = http.url, let socketURL = socket.url else {
            throw PairingURLError.invalidURL
        }
        return PairingTarget(
            credential: credential,
            httpBaseURL: httpURL,
            webSocketBaseURL: socketURL
        )
    }

    private static func requireSupportedScheme(_ scheme: String?) throws {
        guard supportedSchemes.contains(scheme?.lowercased() ?? "") else {
            throw PairingURLError.unsupportedScheme
        }
    }

    private static func requireToken(_ token: String?) throws -> String {
        let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { throw PairingURLError.missingToken }
        return trimmed
    }
}

private extension URLComponents {
    func withQueryItems(_ items: [URLQueryItem]) -> URLComponents {
        var copy = self
        copy.queryItems = items
        return copy
    }
}

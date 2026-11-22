import Foundation

struct ParsedPairingURL: Sendable, Equatable {
    let serverURL: String
    let pairingCode: String
}

enum PairingURLParserError: LocalizedError, Sendable {
    case empty
    case invalidURL
    case unsupportedScheme
    case missingToken

    var errorDescription: String? {
        switch self {
        case .empty:
            "Paste a pairing URL from your conn-server."
        case .invalidURL:
            "Enter a valid URL like http://127.0.0.1:3891/#token=..."
        case .unsupportedScheme:
            "The server URL must start with http:// or https://."
        case .missingToken:
            "No #token= pairing code found in the URL."
        }
    }
}

enum PairingURLParser {
    static func parse(_ raw: String) throws -> ParsedPairingURL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw PairingURLParserError.empty
        }
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host,
              !host.isEmpty else {
            throw PairingURLParserError.invalidURL
        }
        guard scheme == "http" || scheme == "https" else {
            throw PairingURLParserError.unsupportedScheme
        }

        let token = extractToken(fromFragment: components.fragment)
            ?? extractToken(fromQueryItems: components.queryItems)
        guard let token, !token.isEmpty else {
            throw PairingURLParserError.missingToken
        }

        components.fragment = nil
        components.query = nil
        if components.path == "/" || components.path == "/pair" || components.path == "/pair/" {
            components.path = ""
        }
        guard let baseURL = components.string, !baseURL.isEmpty else {
            throw PairingURLParserError.invalidURL
        }
        return ParsedPairingURL(serverURL: baseURL, pairingCode: token)
    }

    private static func extractToken(fromFragment fragment: String?) -> String? {
        guard let fragment, !fragment.isEmpty else { return nil }
        for part in fragment.split(separator: "&") {
            let pair = part.split(separator: "=", maxSplits: 1)
            if pair.count == 2, pair[0] == "token" {
                let value = String(pair[1]).removingPercentEncoding ?? String(pair[1])
                if !value.isEmpty { return value }
            }
        }
        return nil
    }

    private static func extractToken(fromQueryItems items: [URLQueryItem]?) -> String? {
        items?.first(where: { $0.name == "token" })?.value
    }
}

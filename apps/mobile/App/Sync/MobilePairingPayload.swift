import Foundation

enum MobilePairingPayloadError: Error, LocalizedError, Equatable {
    case unsupportedPayload
    case unsupportedVersion(String)
    case missingServerURL
    case missingToken
    case invalidServerURL(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedPayload:
            "QR code is not a T3 Mobile pairing code."
        case let .unsupportedVersion(version):
            "Pairing QR code uses unsupported version \(version). Update T3 Mobile and try again."
        case .missingServerURL:
            "Pairing QR code is missing the server URL."
        case .missingToken:
            "Pairing QR code is missing the one-time token."
        case let .invalidServerURL(value):
            "Pairing QR code contains an invalid server URL: \(value)"
        }
    }
}

enum MobilePairingPayload {
    static func configuration(from rawValue: String) throws -> MobileServerConfiguration {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme == "t3code",
              components.host == "mobile",
              components.path == "/pair"
        else {
            throw MobilePairingPayloadError.unsupportedPayload
        }

        let queryItems = components.queryItems ?? []
        let version = queryItems.first(where: { $0.name == "v" })?.value
        let serverURLString = queryItems.first(where: { $0.name == "server" })?.value
        let token = queryItems.first(where: { $0.name == "token" })?.value

        guard version == nil || version == "1" else {
            throw MobilePairingPayloadError.unsupportedVersion(version ?? "unknown")
        }

        guard let serverURLString, !serverURLString.isEmpty else {
            throw MobilePairingPayloadError.missingServerURL
        }
        guard let token, !token.isEmpty else {
            throw MobilePairingPayloadError.missingToken
        }
        guard let serverURL = URL(string: serverURLString), serverURL.scheme != nil, serverURL.host != nil else {
            throw MobilePairingPayloadError.invalidServerURL(serverURLString)
        }

        return MobileServerConfiguration(baseURL: serverURL, bootstrapCredential: token)
    }
}

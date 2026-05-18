import Foundation

enum MobileSyncError: Error, Equatable, LocalizedError {
    case invalidBaseURL(String)
    case invalidEndpoint(String)
    case invalidWebSocketURL(URL)
    case httpStatus(Int)
    case missingAuthenticationCredential
    case incompatibleProtocol(String)
    case missingCapability(String)
    case webSocketClosed(String)
    case timeout(String)
    case unexpectedMessage(String)
    case protocolError(code: String, message: String)

    var errorDescription: String? {
        switch self {
        case let .invalidBaseURL(value):
            "Invalid mobile server URL: \(value)"
        case let .invalidEndpoint(value):
            "Invalid mobile endpoint: \(value)"
        case let .invalidWebSocketURL(url):
            "Could not build WebSocket URL from \(url.absoluteString)"
        case let .httpStatus(statusCode):
            "Mobile server returned HTTP \(statusCode)"
        case .missingAuthenticationCredential:
            "Mobile sync requires a bearer session token or bootstrap credential."
        case let .incompatibleProtocol(message):
            message
        case let .missingCapability(capability):
            "Mobile server does not support required capability \(capability)."
        case let .webSocketClosed(message):
            message
        case let .timeout(message):
            message
        case let .unexpectedMessage(message):
            message
        case let .protocolError(code, message):
            "\(code): \(message)"
        }
    }
}

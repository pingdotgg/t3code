import Foundation

enum MobileCacheError: Error, Equatable, LocalizedError {
    case openFailed(String)
    case prepareFailed(String)
    case stepFailed(String)
    case bindFailed(String)
    case invalidTextColumn(String)
    case unsupportedSchemaVersion(Int)

    var errorDescription: String? {
        switch self {
        case let .openFailed(message):
            "Failed to open mobile cache: \(message)"
        case let .prepareFailed(message):
            "Failed to prepare mobile cache statement: \(message)"
        case let .stepFailed(message):
            "Failed to execute mobile cache statement: \(message)"
        case let .bindFailed(message):
            "Failed to bind mobile cache statement: \(message)"
        case let .invalidTextColumn(name):
            "Mobile cache column \(name) was not valid UTF-8 text."
        case let .unsupportedSchemaVersion(version):
            "Mobile cache schema version \(version) is newer than this app supports."
        }
    }
}

import Foundation

struct MobileCachedShell: Codable, Equatable, Sendable {
    let environment: MobileEnvironment
    let shellState: MobileShellState
    let protocolVersion: String
    let snapshotSchemaVersion: Int
    let savedAt: String
}

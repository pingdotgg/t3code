import Foundation

struct MobileShellState: Codable, Equatable, Sendable {
    let snapshotSequence: Int
    let projects: [MobileProject]
    let threads: [MobileThread]
}

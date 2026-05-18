import Foundation

struct MobileShellSnapshotDTO: Decodable, Equatable {
    let snapshotSequence: Int
    let projects: [MobileProjectDTO]
    let threads: [MobileThreadDTO]
    let updatedAt: String
}

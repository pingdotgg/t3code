import Foundation

struct MobileProjectDTO: Decodable, Equatable {
    let id: String
    let title: String
    let workspaceRoot: String
}

import Foundation
import UIKit

enum ThreadCopyActionKind: Equatable, Sendable {
    case path
    case branch
    case threadID

    var title: String {
        switch self {
        case .path: "Path"
        case .branch: "Branch"
        case .threadID: "Thread ID"
        }
    }

    var systemImage: String {
        switch self {
        case .path: "folder"
        case .branch: "arrow.triangle.branch"
        case .threadID: "number"
        }
    }

    var copyAnnouncement: String { "\(title) copied" }
}

struct ThreadCopyAction: Equatable, Sendable {
    let kind: ThreadCopyActionKind
    let value: String?

    var isAvailable: Bool { value != nil }

    var announcement: String {
        isAvailable ? kind.copyAnnouncement : "\(kind.title) unavailable"
    }
}

enum ThreadCopyModel {
    static func actions(
        for thread: FeatureThread,
        projectWorkspaceRoot: String?
    ) -> [ThreadCopyAction] {
        var actions: [ThreadCopyAction] = []

        let path = nonBlank(thread.worktreePath) ?? nonBlank(projectWorkspaceRoot)
        actions.append(ThreadCopyAction(kind: .path, value: path))
        if let branch = nonBlank(thread.branch) {
            actions.append(ThreadCopyAction(kind: .branch, value: branch))
        }
        if let threadID = nonBlank(thread.wireID) ?? nonBlank(thread.id) {
            actions.append(ThreadCopyAction(kind: .threadID, value: threadID))
        }

        return actions
    }

    /// Availability ignores surrounding whitespace, while the copied value remains byte-for-byte
    /// identical to the value received from the server.
    private static func nonBlank(_ value: String?) -> String? {
        guard let value,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }
}

@MainActor
enum ThreadCopyClipboard {
    static func copy(_ action: ThreadCopyAction) {
        if let value = action.value {
            UIPasteboard.general.string = value
        }
        UIAccessibility.post(
            notification: .announcement,
            argument: action.announcement
        )
    }
}

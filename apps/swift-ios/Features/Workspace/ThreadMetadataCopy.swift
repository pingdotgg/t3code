import Foundation
import UIKit

enum ThreadMetadataCopyKind: Equatable, Sendable {
    case path
    case branch
    case threadID
}

struct ThreadMetadataCopyItem: Equatable, Sendable {
    let kind: ThreadMetadataCopyKind
    let value: String

    var title: String {
        switch kind {
        case .path: "Copy path"
        case .branch: "Copy branch"
        case .threadID: "Copy thread ID"
        }
    }

    var systemImage: String {
        switch kind {
        case .path: "folder"
        case .branch: "arrow.triangle.branch"
        case .threadID: "number"
        }
    }

    var confirmation: String {
        switch kind {
        case .path: "Path copied"
        case .branch: "Branch copied"
        case .threadID: "Thread ID copied"
        }
    }
}

enum ThreadMetadataCopyModel {
    static func items(
        for thread: FeatureThread,
        projectPath: String?
    ) -> [ThreadMetadataCopyItem] {
        var items: [ThreadMetadataCopyItem] = []

        if let path = nonEmptyPath(thread.worktreePath) ?? nonEmptyPath(projectPath) {
            items.append(ThreadMetadataCopyItem(kind: .path, value: path))
        }
        if let branch = nonEmpty(thread.branch) {
            items.append(ThreadMetadataCopyItem(kind: .branch, value: branch))
        }
        if let threadID = nonEmpty(thread.wireID) ?? nonEmpty(thread.id) {
            items.append(ThreadMetadataCopyItem(kind: .threadID, value: threadID))
        }

        return items
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func nonEmptyPath(_ value: String?) -> String? {
        guard let value,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }
}

@MainActor
enum ThreadMetadataClipboard {
    static func copy(_ item: ThreadMetadataCopyItem) {
        UIPasteboard.general.string = item.value
        UIAccessibility.post(notification: .announcement, argument: item.confirmation)
    }
}

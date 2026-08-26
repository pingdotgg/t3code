import Foundation
import UIKit

enum ThreadCopyActionKind: Equatable, Sendable {
    case path
    case branch
    case threadID
    case project
    case environment
    case url

    var title: String {
        switch self {
        case .path: "Path"
        case .branch: "Branch"
        case .threadID: "Thread ID"
        case .project: "Project"
        case .environment: "Environment"
        case .url: "URL"
        }
    }

    var systemImage: String {
        switch self {
        case .path: "folder"
        case .branch: "arrow.triangle.branch"
        case .threadID: "number"
        case .project: "folder.badge.gearshape"
        case .environment: "desktopcomputer"
        case .url: "link"
        }
    }

    var copyAnnouncement: String { "\(title) copied" }
}

struct ThreadCopyContext: Equatable, Sendable {
    let projectName: String?
    let projectWorkspaceRoot: String?
    let environmentName: String?
    let environmentID: String?
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
        context: ThreadCopyContext
    ) -> [ThreadCopyAction] {
        var actions: [ThreadCopyAction] = []

        let path = nonBlank(thread.worktreePath) ?? nonBlank(context.projectWorkspaceRoot)
        actions.append(ThreadCopyAction(kind: .path, value: path))
        if let branch = nonBlank(thread.branch) {
            actions.append(ThreadCopyAction(kind: .branch, value: branch))
        }
        if let threadID = nonBlank(thread.wireID) ?? nonBlank(thread.id) {
            actions.append(ThreadCopyAction(kind: .threadID, value: threadID))
        }
        if let project = nonBlank(context.projectName) {
            actions.append(ThreadCopyAction(kind: .project, value: project))
        }
        if let environment = nonBlank(context.environmentName) {
            actions.append(ThreadCopyAction(kind: .environment, value: environment))
        }

        let environmentID = nonBlank(thread.environmentID) ?? nonBlank(context.environmentID)
        if let url = threadURL(environmentID: environmentID, threadID: nonBlank(thread.wireID)) {
            actions.append(ThreadCopyAction(kind: .url, value: url))
        }

        return actions
    }

    private static func threadURL(environmentID: String?, threadID: String?) -> String? {
        guard let environmentID,
              let threadID,
              let encodedEnvironmentID = pathSegment(environmentID),
              let encodedThreadID = pathSegment(threadID) else {
            return nil
        }

        var components = URLComponents()
        components.scheme = "https"
        components.host = "app.t3.codes"
        components.percentEncodedPath = "/\(encodedEnvironmentID)/\(encodedThreadID)"
        return components.url?.absoluteString
    }

    private static func pathSegment(_ value: String) -> String? {
        let allowed = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
        )
        return value.addingPercentEncoding(withAllowedCharacters: allowed)
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

import Foundation

enum SourceControlWorkspaceCommand {
    static func make(
        threadID: String, branch: String?, worktreePath: String?, commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("thread.meta.update"), "commandId": .string(commandID),
            "threadId": .string(threadID), "branch": branch.map(JSONValue.string) ?? .null,
            "worktreePath": worktreePath.map(JSONValue.string) ?? .null,
        ])
    }
}

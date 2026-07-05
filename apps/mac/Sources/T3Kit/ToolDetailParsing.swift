// Structured views over the human `detail` string of a tool row. The server
// summarizes tool requests as "<ToolName>: <command>" for shell tools and
// "<ToolName>: {json input}" for everything else (ClaudeAdapter's
// summarizeToolRequest), so file edits arrive as Edit/Write/MultiEdit JSON.
// Parsing that back out lets the UI render a real diff body for file changes
// and a clean command line for shell runs instead of one grey text blob.
//
// Best-effort by design: the server truncates serialized inputs at 400
// characters, so long edits arrive as unparseable JSON — those (and any other
// unrecognized shape) degrade to `.plain`.

import Foundation

/// One old -> new replacement inside a file change. A file creation is a
/// single edit whose `oldText` is empty.
public struct ToolFileEdit: Sendable, Equatable {
    public var oldText: String
    public var newText: String

    public init(oldText: String, newText: String) {
        self.oldText = oldText
        self.newText = newText
    }
}

/// Display-ready interpretation of a tool row's `detail` string.
public enum ParsedToolDetail: Sendable, Equatable {
    /// A shell invocation ("Bash: git status" -> "git status").
    case command(String)
    /// A file edit/creation with enough structure to render a diff.
    case fileChange(path: String, edits: [ToolFileEdit])
    /// Anything unrecognized — render as monospaced text.
    case plain(String)

    /// Parses `detail` using `itemType` ("command_execution", "file_change",
    /// …) as a hint for prefix-stripping when the payload isn't JSON.
    public static func parse(detail: String, itemType: String?) -> ParsedToolDetail {
        let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .plain("") }

        if let (toolName, json) = splitToolJSON(trimmed),
            let parsed = parseToolInput(toolName: toolName, json: json)
        {
            return parsed
        }
        if itemType == "command_execution" {
            let command = strippingToolPrefix(trimmed)
            // A remainder that still looks like JSON is a truncated input
            // blob (the server caps at 400 chars), not a shell command line.
            guard !command.hasPrefix("{") else { return .plain(trimmed) }
            return .command(command)
        }
        return .plain(trimmed)
    }

    /// `"Edit: {\"file_path\"...}"` -> ("Edit", "{...}"); nil when the detail
    /// isn't a tool-name prefix followed by a JSON object.
    private static func splitToolJSON(_ detail: String) -> (String, String)? {
        guard let colon = detail.firstIndex(of: ":") else { return nil }
        let name = String(detail[..<colon])
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" })
        else { return nil }
        let rest = detail[detail.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        guard rest.hasPrefix("{") else { return nil }
        return (name, rest)
    }

    private static func parseToolInput(toolName: String, json: String) -> ParsedToolDetail? {
        guard let data = json.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        if let command = (object["command"] ?? object["cmd"]) as? String,
            !command.trimmingCharacters(in: .whitespaces).isEmpty
        {
            return .command(command.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        guard
            let path = (object["file_path"] ?? object["path"] ?? object["filePath"]) as? String,
            !path.isEmpty
        else { return nil }

        if let old = object["old_string"] as? String, let new = object["new_string"] as? String {
            return .fileChange(path: path, edits: [ToolFileEdit(oldText: old, newText: new)])
        }
        if let rawEdits = object["edits"] as? [[String: Any]] {
            let edits = rawEdits.compactMap { edit -> ToolFileEdit? in
                guard let old = edit["old_string"] as? String,
                    let new = edit["new_string"] as? String
                else { return nil }
                return ToolFileEdit(oldText: old, newText: new)
            }
            guard !edits.isEmpty else { return nil }
            return .fileChange(path: path, edits: edits)
        }
        if let content = object["content"] as? String {
            return .fileChange(path: path, edits: [ToolFileEdit(oldText: "", newText: content)])
        }
        // A bare path (Read/Glob-style input): not a change, leave plain.
        return nil
    }

    /// Drops a leading `ToolName: ` label so a command row shows the command
    /// itself, not the tool that ran it.
    private static func strippingToolPrefix(_ detail: String) -> String {
        guard let colon = detail.firstIndex(of: ":") else { return detail }
        let name = detail[..<colon]
        guard !name.isEmpty, name.count <= 40,
            name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" })
        else { return detail }
        let rest = detail[detail.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? detail : rest
    }
}

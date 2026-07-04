// projects.* RPC family (packages/contracts/src/project.ts, wired in
// rpc.ts): workspace file search/list/read used by composer @-mentions and
// the file browser. All non-streaming request/response calls.

import Foundation

public enum ProjectEntryKind: String, Codable, Sendable {
    case file, directory
}

/// One `{ path, kind }` result row of listEntries/searchEntries.
public struct ProjectEntry: Codable, Sendable, Hashable {
    public var path: String
    public var kind: ProjectEntryKind

    public init(path: String, kind: ProjectEntryKind) {
        self.path = path
        self.kind = kind
    }
}

public struct ProjectSearchEntriesInput: Encodable, Sendable {
    public var cwd: String
    /// Max 256 chars server-side.
    public var query: String
    /// Max 200 server-side.
    public var limit: Int

    public init(cwd: String, query: String, limit: Int) {
        self.cwd = cwd
        self.query = query
        self.limit = limit
    }
}

public struct ProjectEntriesResult: Decodable, Sendable {
    public var entries: [ProjectEntry]
    public var truncated: Bool
}

public struct ProjectListEntriesInput: Encodable, Sendable {
    public var cwd: String

    public init(cwd: String) {
        self.cwd = cwd
    }
}

public struct ProjectReadFileInput: Encodable, Sendable {
    public var cwd: String
    /// Max 512 chars server-side.
    public var relativePath: String

    public init(cwd: String, relativePath: String) {
        self.cwd = cwd
        self.relativePath = relativePath
    }
}

public struct ProjectReadFileResult: Decodable, Sendable {
    public var relativePath: String
    public var contents: String
    public var byteLength: Int
    public var truncated: Bool
}

/// `shell.openInEditor` input (editor.ts `LaunchEditorInput`). `editor` is
/// one of the `EDITORS` ids (e.g. "vscode", "cursor", "zed", "file-manager").
public struct LaunchEditorInput: Encodable, Sendable {
    public var cwd: String
    public var editor: String

    public init(cwd: String, editor: String) {
        self.cwd = cwd
        self.editor = editor
    }
}

extension T3Client {
    /// Opens a path in an external editor via the server's launcher
    /// (void success — errors surface as RPC failures).
    public func openInEditor(cwd: String, editor: String) async throws {
        let _: JSONValue = try await call(
            "shell.openInEditor", LaunchEditorInput(cwd: cwd, editor: editor))
    }

    /// Fuzzy filename search under a project workspace (composer @-mentions).
    public func searchEntries(cwd: String, query: String, limit: Int = 20) async throws
        -> ProjectEntriesResult
    {
        try await call(
            "projects.searchEntries", ProjectSearchEntriesInput(cwd: cwd, query: query, limit: limit))
    }

    /// Non-recursive-ish entry listing for a workspace directory.
    public func listEntries(cwd: String) async throws -> ProjectEntriesResult {
        try await call("projects.listEntries", ProjectListEntriesInput(cwd: cwd))
    }

    public func readFile(cwd: String, relativePath: String) async throws -> ProjectReadFileResult {
        try await call(
            "projects.readFile", ProjectReadFileInput(cwd: cwd, relativePath: relativePath))
    }
}

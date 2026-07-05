import Testing

@testable import T3Kit

@Suite("ParsedToolDetail parsing")
struct ToolDetailParsingTests {
    @Test func commandPrefixDetailParsesAsCommand() {
        let parsed = ParsedToolDetail.parse(
            detail: "Bash: git status --short", itemType: "command_execution")
        #expect(parsed == .command("git status --short"))
    }

    @Test func commandDetailWithoutPrefixStaysWhole() {
        let parsed = ParsedToolDetail.parse(
            detail: "npm run build", itemType: "command_execution")
        #expect(parsed == .command("npm run build"))
    }

    @Test func commandJSONInputParsesAsCommand() {
        let parsed = ParsedToolDetail.parse(
            detail: #"Bash: {"command": "swift build", "timeout": 60}"#,
            itemType: "command_execution")
        #expect(parsed == .command("swift build"))
    }

    @Test func editJSONParsesAsFileChange() {
        let parsed = ParsedToolDetail.parse(
            detail: #"Edit: {"file_path": "src/a.swift", "old_string": "let x = 1", "new_string": "let x = 2"}"#,
            itemType: "file_change")
        #expect(
            parsed
                == .fileChange(
                    path: "src/a.swift",
                    edits: [ToolFileEdit(oldText: "let x = 1", newText: "let x = 2")]))
    }

    @Test func writeJSONParsesAsCreationEdit() {
        let parsed = ParsedToolDetail.parse(
            detail: ##"Write: {"file_path": "docs/new.md", "content": "# Title\nBody"}"##,
            itemType: "file_change")
        #expect(
            parsed
                == .fileChange(
                    path: "docs/new.md",
                    edits: [ToolFileEdit(oldText: "", newText: "# Title\nBody")]))
    }

    @Test func multiEditJSONParsesAllEdits() {
        let parsed = ParsedToolDetail.parse(
            detail:
                #"MultiEdit: {"file_path": "a.ts", "edits": [{"old_string": "1", "new_string": "2"}, {"old_string": "3", "new_string": "4"}]}"#,
            itemType: "file_change")
        #expect(
            parsed
                == .fileChange(
                    path: "a.ts",
                    edits: [
                        ToolFileEdit(oldText: "1", newText: "2"),
                        ToolFileEdit(oldText: "3", newText: "4"),
                    ]))
    }

    @Test func truncatedCommandJSONDegradesToPlain() {
        let detail = #"Bash: {"command": "swift build --package-path apps/mac && swift te"#
        let parsed = ParsedToolDetail.parse(detail: detail, itemType: "command_execution")
        #expect(parsed == .plain(detail))
    }

    @Test func truncatedJSONDegradesToPlain() {
        // The server caps serialized inputs at 400 chars, so long edits arrive
        // with a chopped JSON tail.
        let parsed = ParsedToolDetail.parse(
            detail: #"Edit: {"file_path": "src/a.swift", "old_string": "let x ..."#,
            itemType: "file_change")
        #expect(parsed == .plain(#"Edit: {"file_path": "src/a.swift", "old_string": "let x ..."#))
    }

    @Test func barePathInputStaysPlain() {
        let parsed = ParsedToolDetail.parse(
            detail: "Sources/App/Main.swift", itemType: "file_read")
        #expect(parsed == .plain("Sources/App/Main.swift"))
    }

    @Test func readJSONWithOnlyPathStaysPlain() {
        let parsed = ParsedToolDetail.parse(
            detail: #"Read: {"file_path": "src/a.swift"}"#, itemType: nil)
        #expect(parsed == .plain(#"Read: {"file_path": "src/a.swift"}"#))
    }

    @Test func emptyDetailIsPlainEmpty() {
        #expect(ParsedToolDetail.parse(detail: "  ", itemType: nil) == .plain(""))
    }

    @Test func urlLikeDetailIsNotMistakenForToolPrefix() {
        // "https://…" has a colon but the remainder isn't JSON and this isn't
        // a command row, so it must survive untouched.
        let parsed = ParsedToolDetail.parse(
            detail: "https://example.com/docs", itemType: "web_search")
        #expect(parsed == .plain("https://example.com/docs"))
    }
}

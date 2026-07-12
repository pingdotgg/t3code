import Foundation
import Testing

@testable import SergeCodeMac

@Suite("CodeHighlighter")
struct CodeHighlighterTests {
    @Test("highlights Swift with multiple SwiftUI foreground colors")
    func swiftHighlighting() async throws {
        let highlighted = try #require(
            await CodeHighlighter.shared.highlighted(
                code: "import Foundation\nlet answer = 42\nlet text = \"hello\"\n// note",
                language: "swift",
                dark: false))

        let colors = Set(
            highlighted.runs.compactMap { run in
                run.foregroundColor.map { String(describing: $0) }
            })
        #expect(colors.count > 1)
    }

    @Test("preserves leading indentation and blank lines")
    func preservesCodeWhitespace() async throws {
        let code = "    let answer = 42\n\n    return answer"
        let highlighted = try #require(
            await CodeHighlighter.shared.highlighted(
                code: code,
                language: "swift",
                dark: false))

        let rendered = String(highlighted.characters)
        #expect(rendered.hasPrefix("    "))
        #expect(rendered.contains("\n\n"))
    }

    @Test("unknown languages return nil")
    func unknownLanguage() async {
        let highlighted = await CodeHighlighter.shared.highlighted(
            code: "let answer = 42",
            language: "notareallang",
            dark: false)
        #expect(highlighted == nil)
    }

    @Test("plaintext fences skip highlighting")
    func plaintextLanguage() async {
        let highlighted = await CodeHighlighter.shared.highlighted(
            code: "let answer = 42",
            language: "plaintext",
            dark: false)
        #expect(highlighted == nil)
    }

    @Test("cache hits return the same attributed value")
    func cacheHit() async throws {
        let first = try #require(
            await CodeHighlighter.shared.highlighted(
                code: "let answer = 42",
                language: "swift",
                dark: true))
        let second = try #require(
            await CodeHighlighter.shared.highlighted(
                code: "let answer = 42",
                language: "swift",
                dark: true))
        #expect(second == first)
    }

    @Test("maps supported aliases to highlight.js names")
    func aliases() {
        #expect(CodeHighlighter.mappedLanguage(for: "py") == "python")
        #expect(CodeHighlighter.mappedLanguage(for: "tsx") == "typescript")
        #expect(CodeHighlighter.mappedLanguage(for: "notareallang") == nil)
    }

    @Test("bundled highlight.js includes TOML grammar")
    func tomlGrammarIsBundled() async {
        let highlighted = await CodeHighlighter.shared.highlighted(
            code: "name = \"SergeCode\"",
            language: "toml",
            dark: false)
        #expect(highlighted != nil)
    }
}

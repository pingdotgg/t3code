import Foundation
import Testing

@testable import SergeCodeMac

@Suite("SyntaxTint")
struct SyntaxTintTests {
    @Test("detects language from extension")
    func languageFromPath() {
        #expect(SyntaxLanguage.language(forPath: "Foo.swift") == .swift)
        #expect(SyntaxLanguage.language(forPath: "a/b/c.ts") == .typescript)
        #expect(SyntaxLanguage.language(forPath: "index.jsx") == .typescript)
        #expect(SyntaxLanguage.language(forPath: "pkg.json") == .json)
        #expect(SyntaxLanguage.language(forPath: "README.md") == .plain)
    }

    @Test("swift keywords and strings")
    func swiftTokens() {
        let spans = SyntaxTint.tokenize("let x = \"hi\" // c", language: .swift)
        let kinds = spans.map(\.kind)
        #expect(kinds.contains(.keyword))
        #expect(kinds.contains(.string))
        #expect(kinds.contains(.comment))
        #expect(spans.contains(where: { $0.text == "let" && $0.kind == .keyword }))
        #expect(spans.contains(where: { $0.text == "\"hi\"" && $0.kind == .string }))
    }

    @Test("typescript numbers and keywords")
    func typescriptTokens() {
        let spans = SyntaxTint.tokenize("const n = 42", language: .typescript)
        #expect(spans.contains(where: { $0.text == "const" && $0.kind == .keyword }))
        #expect(spans.contains(where: { $0.text == "42" && $0.kind == .number }))
    }

    @Test("json strings and literals")
    func jsonTokens() {
        let spans = SyntaxTint.tokenize("{\"ok\": true, \"n\": 1}", language: .json)
        #expect(spans.contains(where: { $0.kind == .string }))
        #expect(spans.contains(where: { $0.text == "true" && $0.kind == .keyword }))
        #expect(spans.contains(where: { $0.text == "1" && $0.kind == .number }))
    }

    @Test("plain text is a single span")
    func plainText() {
        let spans = SyntaxTint.tokenize("hello world", language: .plain)
        #expect(spans.count == 1)
        #expect(spans[0].kind == .plain)
        #expect(spans[0].text == "hello world")
    }

    @Test("empty input")
    func empty() {
        #expect(SyntaxTint.tokenize("", language: .swift).isEmpty)
    }

    @Test("block comments")
    func blockComment() {
        let spans = SyntaxTint.tokenize("/* a */ let x", language: .swift)
        #expect(spans.contains(where: { $0.kind == .comment && $0.text.contains("a") }))
        #expect(spans.contains(where: { $0.text == "let" && $0.kind == .keyword }))
    }

    @Test("reconstructed text equals input")
    func reconstruct() {
        let samples = [
            "func foo(_ x: Int) -> String { return \"ok\" }",
            "export const a = 1; // end",
            "{\"a\": null, \"b\": false}",
        ]
        for sample in samples {
            for lang: SyntaxLanguage in [.swift, .typescript, .json] {
                let joined = SyntaxTint.tokenize(sample, language: lang).map(\.text).joined()
                #expect(joined == sample)
            }
        }
    }
}

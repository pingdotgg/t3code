import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Code highlight cache", .serialized)
@MainActor
struct CodeHighlightCacheTests {
    init() {
        CodeHighlightCache.resetForTesting()
    }

    @Test("reuses the same code and language")
    func sameKeyHits() {
        let code = "let answer = 42"
        _ = CodeHighlightCache.highlighted(code: code, language: "swift")
        _ = CodeHighlightCache.highlighted(code: code, language: "swift")

        #expect(CodeHighlightCache.hits == 1)
        #expect(CodeHighlightCache.misses == 1)
    }

    @Test("treats a different language as a cache miss")
    func languageIsPartOfKey() {
        let code = "let answer = 42"
        _ = CodeHighlightCache.highlighted(code: code, language: "swift")
        _ = CodeHighlightCache.highlighted(code: code, language: "typescript")

        #expect(CodeHighlightCache.hits == 0)
        #expect(CodeHighlightCache.misses == 2)
    }

    @Test("keeps oversized blocks plain without tokenizing")
    func oversizedBlockUsesPlainAttributedString() {
        let code = String(repeating: "let answer = 42\n", count: 5_000)
        let highlighted = CodeHighlightCache.highlighted(code: code, language: "swift")

        #expect(highlighted == AttributedString(code))
        #expect(String(highlighted.characters) == code)
        #expect(highlighted.runs.count == 1)
        #expect(CodeHighlightCache.misses == 1)
    }

    @Test("wipes the cache at its entry cap")
    func capWipesAndRepopulates() {
        for index in 0..<256 {
            _ = CodeHighlightCache.highlighted(
                code: "let value = \(index)", language: "swift")
        }
        #expect(CodeHighlightCache.misses == 256)

        _ = CodeHighlightCache.highlighted(code: "let value = overflow", language: "swift")
        #expect(CodeHighlightCache.misses == 257)

        _ = CodeHighlightCache.highlighted(code: "let value = 0", language: "swift")
        #expect(CodeHighlightCache.misses == 258)
        #expect(CodeHighlightCache.hits == 0)
    }
}

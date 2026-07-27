import Foundation
import Testing

@testable import SergeCodeMac

/// These replace `split(separator:).first`, `trimmingCharacters(in:).isEmpty`
/// and friends inside view bodies, so equivalence with the spellings they
/// replaced is the whole contract.
@Suite("Text preview reductions")
struct TextPreviewTests {
    @Test("firstNonBlankLine matches the split-and-trim it replaces")
    func firstNonBlankLineEquivalence() {
        let cases = [
            "",
            "\n",
            "   \n\t\n",
            "hello",
            "  hello  ",
            "\n\n  pnpm run verify --all  \nsecond line\nthird",
            "first\nsecond",
            "\r\ncarriage\r\nreturns",
            "single trailing newline\n",
        ]
        for input in cases {
            let expected = input
                .split(separator: "\n", omittingEmptySubsequences: true)
                .lazy
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty }
            #expect(input.firstNonBlankLine == expected, "input: \(input.debugDescription)")
        }
    }

    @Test("firstNonBlankLine stops at the first line with content")
    func firstNonBlankLineTakesTheFirst() {
        let payload = "\n \n  git status --porcelain  \nnever reached\n"
        #expect(payload.firstNonBlankLine == "git status --porcelain")
    }

    @Test("hasVisibleContent matches the trim-and-check it replaces")
    func hasVisibleContentEquivalence() {
        let cases = ["", " ", "\n", " \t\n ", "a", " a ", "\n\nword\n\n", "  …  "]
        for input in cases {
            let expected = !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            #expect(input.hasVisibleContent == expected, "input: \(input.debugDescription)")
        }
    }

    @Test("trimmedIfNotBlank returns nil rather than an empty string")
    func trimmedIfNotBlank() {
        #expect("".trimmedIfNotBlank == nil)
        #expect("   \n ".trimmedIfNotBlank == nil)
        #expect("  Sources/App.swift  ".trimmedIfNotBlank == "Sources/App.swift")
        #expect("a".trimmedIfNotBlank == "a")
        #expect(" a b ".trimmedIfNotBlank == "a b")
    }
}

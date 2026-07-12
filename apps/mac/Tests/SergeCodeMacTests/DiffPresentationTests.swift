import Foundation
import SwiftUI
import Testing

@testable import SergeCodeMac

@Suite("DiffPresentation")
struct DiffPresentationTests {
    @Test("attributed lines preserve text and highlight changed intraline spans")
    func attributedLinePreservesTextAndHighlightsChanges() {
        let text = "let value = old"
        let attributed = DiffTextBuilder.attributedLine(
            text: text,
            lineKind: .deletion,
            intraline: [
                IntralineSpan(text: "let value = ", isChanged: false),
                IntralineSpan(text: "old", isChanged: true),
            ],
            syntax: [
                SyntaxSpan(text: "let", kind: .keyword),
                SyntaxSpan(text: " value = ", kind: .plain),
                SyntaxSpan(text: "old", kind: .plain),
            ])

        #expect(String(attributed.characters) == text)

        let highlightedText = attributed.runs.compactMap { run -> String? in
            guard run.backgroundColor != nil else { return nil }
            return String(attributed[run.range].characters)
        }.joined()
        #expect(highlightedText == "old")
    }
}

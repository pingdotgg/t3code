import Foundation
import Testing
@testable import SergeCodeMac

@Suite("Dictation draft editing")
struct DictationDraftTests {
    @Test("appends to an empty draft without a leading space")
    func appendsToEmptyDraft() {
        #expect(DictationDraft.appending("hello world", to: "") == "hello world")
    }

    @Test("separates the transcript from existing text with one space")
    func appendsWithSeparator() {
        #expect(DictationDraft.appending("next", to: "first") == "first next")
    }

    @Test("does not double the separator when the draft already ends in whitespace")
    func appendsAfterTrailingWhitespace() {
        #expect(DictationDraft.appending("next", to: "first ") == "first next")
        #expect(DictationDraft.appending("next", to: "first\n") == "first\nnext")
    }

    @Test("replaces the last occurrence so later user edits survive the polish swap")
    func replacesLastOccurrence() {
        let draft = "say raw words. raw words typed again"
        let updated = DictationDraft.replacingLastOccurrence(
            of: "raw words", with: "polished words", in: draft)
        #expect(updated == "say raw words. polished words typed again")
    }

    @Test("replacement lands where the raw transcript was inserted, before later typing")
    func replacesInsertedSpanBeforeLaterTyping() {
        let draft = DictationDraft.appending("um hello uh world", to: "prompt:")
            + " — and then the user kept typing"
        let updated = DictationDraft.replacingLastOccurrence(
            of: "um hello uh world", with: "Hello world.", in: draft)
        #expect(updated == "prompt: Hello world. — and then the user kept typing")
    }

    @Test("returns nil when the raw text is gone (edited away or sent)")
    func missingOriginalIsANoOp() {
        #expect(
            DictationDraft.replacingLastOccurrence(of: "raw", with: "polished", in: "other text")
                == nil)
        #expect(DictationDraft.replacingLastOccurrence(of: "", with: "polished", in: "raw") == nil)
    }
}

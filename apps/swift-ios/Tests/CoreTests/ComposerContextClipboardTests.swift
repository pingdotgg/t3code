import Foundation
import Testing
@testable import T3Code

@Suite("Composer context clipboard contract")
struct ComposerContextClipboardTests {
    @Test func portableHTMLAndMIMERoundTripUnknownPayloads() throws {
        let raw = #"{"version":1,"source":{"environmentId":"source","threadId":"thread","messageId":"message"},"records":[{"version":1,"contextId":"future","kind":"future-kind","label":"future","payload":{"integer":9007199254740993,"nested":[null,true,"日本語 & <html>"]}}]}"#
        let fragment = try ComposerContextClipboard.decode(raw)
        let text = "Keep [future](t3-context://v1/future-kind/future)\n<plain & text>"
        let encoded = try ComposerContextClipboard.encode(fragment)
        let html = ComposerContextClipboard.html(text: text, fragment: encoded)
        #expect(html.contains("&lt;plain &amp; text&gt;"))
        #expect(try ComposerContextClipboard.decode(encoded) == fragment)
        #expect(try ComposerContextClipboard.decodeHTML(html) == fragment)
        #expect(try ComposerContextClipboard.decodeHTML("<div data-t3-context-fragment='\(encoded.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!)'>copied</div>") == fragment)
        #expect(encoded.contains("9007199254740993"))
    }

    @Test func selectionKeepsItsScreenshotButNotUnselectedRecords() throws {
        let fragment = try fixture()
        let text = "Look [chosen label](t3-context://v1/preview-annotation/annotation) here"
        let selected = try ComposerContextClipboard.selected(text: text, fragment: fragment)
        #expect(selected.text == text)
        #expect(selected.fragment.records.map(\.contextId) == ["annotation", "shot"])
    }

    @Test func repeatedLinksAndScreenshotDependenciesReceiveFreshIdentities() throws {
        let text = "🐱 [chosen label](t3-context://v1/preview-annotation/annotation)\n![custom shot](t3-context://v1/image/shot) [again](t3-context://v1/preview-annotation/annotation)"
        let original = try ComposerContextClipboard.selected(text: text, fragment: fixture())
        var ordinal = 0
        let imported = try ComposerContextClipboard.reidentified(original) { ordinal += 1; return "new_\(ordinal)" }
        #expect(imported.text == "🐱 [chosen label](t3-context://v1/preview-annotation/new_1)\n![custom shot](t3-context://v1/image/new_2) [again](t3-context://v1/preview-annotation/new_1)")
        guard case let .previewAnnotation(annotation) = imported.fragment.records[0].payload else {
            Issue.record("Expected annotation"); return
        }
        #expect(annotation.screenshotContextId == "new_2")
        #expect(imported.fragment.records[1].attachment?.attachmentId == "source-attachment")
        #expect(original.fragment.records.map(\.contextId) == ["annotation", "shot"])
    }

    @Test func missingRecordsAndScreenshotsRejectTheWholePaste() throws {
        let fragment = try fixture()
        #expect(throws: ComposerContextClipboardError.missingRecord) {
            try ComposerContextClipboard.selected(text: "[missing](t3-context://v1/mention/missing)", fragment: fragment)
        }
        let missingScreenshot = ComposerContextClipboardFragment(source: fragment.source, records: [fragment.records[0]])
        #expect(throws: ComposerContextClipboardError.missingRecord) {
            try ComposerContextClipboard.selected(text: "[annotation](t3-context://v1/preview-annotation/annotation)", fragment: missingScreenshot)
        }
    }

    @Test func recordLimitsAndMalformedKnownKindsAreNotSilentlyTrimmed() throws {
        let records = (0 ... 200).map { ComposerContextRecord(contextId: "id_\($0)", label: "file", payload: .mention(.init(path: "file.swift"))) }
        #expect(throws: ComposerContextClipboardError.contextLimit) {
            try ComposerContextClipboard.encode(.init(source: .init(environmentId: "source"), records: records))
        }
        let malformed = #"{"version":1,"source":{"environmentId":"source"},"records":[{"version":1,"contextId":"bad","kind":"terminal","label":"bad","payload":{"keep":"this"}}]}"#
        #expect(throws: ComposerContextClipboardError.invalidFragment) { try ComposerContextClipboard.decode(malformed) }
        #expect(throws: ComposerContextClipboardError.invalidFragment) {
            try ComposerContextClipboard.encode(.init(source: .init(environmentId: "source"), records: [records[0], records[0]]))
        }
    }

    @Test func encodingRejectsIdentitiesThatTheDecoderCannotRead() {
        let badID = ComposerContextRecord(contextId: "bad id", label: "bad", payload: .mention(.init(path: "file.swift")))
        let badKind = ComposerContextRecord(contextId: "valid_id", label: "bad", payload: .unknown(kind: "Bad Kind", payload: .null))
        for record in [badID, badKind] {
            #expect(throws: ComposerContextClipboardError.invalidFragment) {
                try ComposerContextClipboard.encode(.init(source: .init(environmentId: "source"), records: [record]))
            }
        }
    }

    private func fixture() throws -> ComposerContextClipboardFragment {
        try ComposerContextClipboard.decode(#"{"version":1,"source":{"environmentId":"source"},"records":[{"version":1,"kind":"preview-annotation","contextId":"annotation","label":"Annotation","annotationId":"original","pageUrl":"https://example.com","pageTitle":null,"comment":"Keep this exact comment","targetSummary":"one target","styleChanges":[],"screenshotContextId":"shot"},{"version":1,"kind":"image","contextId":"shot","label":"Screenshot","attachmentId":"source-attachment","name":"shot.png","mimeType":"image/png","sizeBytes":4},{"version":1,"kind":"mention","contextId":"not-selected","label":"not selected","path":"src/unselected.swift"}]}"#)
    }
}

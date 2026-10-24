import Foundation
import Testing
@testable import T3Code

@Suite("Captured attachment inspection")
struct FeatureAttachmentDocumentTests {
    @Test
    func mimeTypeTakesPrecedenceOverTheFileName() {
        #expect(FeatureAttachmentContentKind.infer(name: "clip.mp4", mimeType: "application/pdf") == .pdf)
        #expect(FeatureAttachmentContentKind.infer(name: "table.csv", mimeType: "text/html; charset=utf-8") == .html)
        #expect(FeatureAttachmentContentKind.delimiter(name: "table.csv", mimeType: "application/pdf") == nil)
        #expect(FeatureAttachmentContentKind.infer(name: "capture", mimeType: "TEXT/MARKDOWN") == .markdown)
        #expect(FeatureAttachmentContentKind.infer(name: "capture", mimeType: "audio/mp4") == .audio)
        #expect(FeatureAttachmentContentKind.infer(name: "capture", mimeType: "application/problem+json") == .text)
    }

    @Test
    func genericTypesUseRecognizedExtensionsAndPreserveBinaryViewing() {
        #expect(FeatureAttachmentContentKind.infer(name: "README.MDX", mimeType: "text/plain") == .markdown)
        #expect(FeatureAttachmentContentKind.infer(name: "index.htm") == .html)
        #expect(FeatureAttachmentContentKind.infer(name: "recording.m4a") == .audio)
        #expect(FeatureAttachmentContentKind.infer(name: "script.tsx") == .text)
        #expect(FeatureAttachmentContentKind.infer(name: "LICENSE") == .text)
        #expect(FeatureAttachmentContentKind.infer(name: "archive.zip") == .native)
        #expect(FeatureAttachmentContentKind.infer(name: "report.docx") == .native)
        #expect(FeatureAttachmentContentKind.infer(name: "capture", mimeType: "text/plain") == .text)
        #expect(FeatureAttachmentContentKind.delimiter(name: "TABLE.CSV", mimeType: "text/plain") == ",")
        #expect(FeatureAttachmentContentKind.delimiter(name: "capture", mimeType: "text/tab-separated-values") == "\t")
    }

    @Test
    func tablePreservesQuotesDelimitersLineBreaksAndEmptyFields() {
        let table = FeatureDelimitedPreview(
            text: "\u{feff}name,notes,empty\r\n\"A, B\",\"say \"\"hi\"\"\nagain\",\r\n",
            delimiter: ","
        )
        #expect(table.rows == [["name", "notes", "empty"], ["A, B", "say \"hi\"\nagain", ""]])
        #expect(!table.isTruncated)
        #expect(FeatureDelimitedPreview(text: "one\ttwo\n\tthree", delimiter: "\t").rows == [["one", "two"], ["", "three"]])
        for delimiter: Unicode.Scalar in [",", "\t"] {
            #expect(FeatureDelimitedPreview(text: "\u{feff}", delimiter: delimiter).rows.isEmpty)
            #expect(FeatureDelimitedPreview(text: "name\r\n\"\"", delimiter: delimiter).rows == [["name"], [""]])
            #expect(FeatureDelimitedPreview(text: "name\r\n", delimiter: delimiter).rows == [["name"]])
        }
    }

    @Test
    func tableBoundsRowsColumnsAndCellsWithoutChangingSource() {
        let row = Array(repeating: "value", count: 31).joined(separator: ",")
        let source = Array(repeating: row, count: 101).joined(separator: "\n")
        let table = FeatureDelimitedPreview(text: source, delimiter: ",")
        #expect(table.rows.count == 100)
        #expect(table.rows.allSatisfy { $0.count == 30 })
        #expect(table.isTruncated)
        let longCell = FeatureDelimitedPreview(text: String(repeating: "a", count: 2_001), delimiter: ",")
        #expect(longCell.rows == [[String(repeating: "a", count: 2_000)]])
        #expect(longCell.isTruncated)
        #expect(FeatureDelimitedPreview(text: "a,\"unfinished", delimiter: ",").isTruncated)
        let exact = String(repeating: "name\n", count: 99) + "\"\""
        #expect(FeatureDelimitedPreview(text: exact, delimiter: ",").rows.count == 100)
        #expect(!FeatureDelimitedPreview(text: exact, delimiter: ",").isTruncated)
    }

    @Test
    func textPreviewLimitsBytesAndHandlesSplitUTF8Scalars() throws {
        let prefix = String(repeating: "a", count: FeatureAttachmentText.maximumBytes - 1)
        let content = try FeatureAttachmentText.decode(Data((prefix + "🙂rest").utf8))
        #expect(content.text == prefix)
        #expect(content.isTruncated)
        #expect(try FeatureAttachmentText.decode(Data("let count = 42\n".utf8)).text == "let count = 42\n")
        #expect(try !FeatureAttachmentText.decode(Data(repeating: 97, count: FeatureAttachmentText.maximumBytes)).isTruncated)
    }

    @Test
    func textRejectsBinaryAndMalformedUTF8IncludingInvalidTruncatedSuffixes() {
        #expect(throws: FeatureAttachmentTextError.self) {
            try FeatureAttachmentText.decode(Data([65, 0, 66]))
        }
        #expect(throws: FeatureAttachmentTextError.self) {
            try FeatureAttachmentText.decode(Data([0xff, 0x61]))
        }
        #expect(throws: FeatureAttachmentTextError.self) {
            try FeatureAttachmentText.decode(Data([0xe0, 0x80]), truncated: true)
        }
        #expect(throws: FeatureAttachmentTextError.self) {
            try FeatureAttachmentText.decode(Data([0xf0, 0x9f]))
        }
    }

    @Test
    func capturedLinksCannotInvokeHostOrApplicationRoutes() throws {
        for raw in ["file:///tmp/secret", "t3code://media-preview/open?path=/tmp/a.png&kind=image", "javascript:alert(1)", "../README.md"] {
            #expect(!FeatureAttachmentLinkPolicy.allowsExternal(try #require(URL(string: raw))))
        }
        #expect(FeatureAttachmentLinkPolicy.allowsExternal(try #require(URL(string: "https://example.com/docs"))))
    }
}

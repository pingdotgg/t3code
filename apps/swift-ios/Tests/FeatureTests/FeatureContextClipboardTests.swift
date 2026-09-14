import Foundation
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import T3Code

@Suite("Context clipboard", .serialized)
@MainActor
struct FeatureContextClipboardTests {
    @Test func nativeCopyKeepsCanonicalSelectedTextAndAllPortableFlavors() throws {
        let pasteboard = UIPasteboard.withUniqueName()
        let record = mention("selected")
        let original = "Before \(ComposerContextReferences.format(record)) after"
        let editor = FeatureComposerUITextView()
        let selected = ComposerContextReferences.format(record)
        editor.text = original
        editor.selectedRange = NSRange(location: 7, length: selected.utf16.count)
        let selection = editor.selectedRange
        editor.onCopySelection = { attributed in
            try FeatureContextClipboard.write(
                text: FeatureInlineSkillProjection.plainText(from: attributed),
                source: .init(environmentId: "source"), context: .init(records: [record, mention("other")]),
                pasteboard: pasteboard
            )
        }

        editor.copy(nil)

        #expect(editor.text == original)
        #expect(editor.selectedRange == selection)
        #expect(pasteboard.string == selected)
        #expect(try FeatureContextClipboard.read(from: pasteboard)?.fragment.records == [record])
        let html = try #require(pasteboard.data(forPasteboardType: UTType.html.identifier))
        #expect(try ComposerContextClipboard.decodeHTML(String(decoding: html, as: UTF8.self))?.records == [record])
    }

    @Test func failedRichCutDoesNotDeleteTheSelectionOrReplaceTheClipboard() {
        let editor = FeatureComposerUITextView()
        editor.text = "Before selected after"
        editor.selectedRange = NSRange(location: 7, length: 8)
        editor.onCopySelection = { _ in throw ComposerContextClipboardError.missingRecord }
        var error: String?
        editor.onCopyError = { error = $0 }

        editor.cut(nil)

        #expect(editor.text == "Before selected after")
        #expect(editor.selectedRange == NSRange(location: 7, length: 8))
        #expect(error != nil)
    }

    @Test func HTMLFallbackRecoversWhenTheCustomMIMEIsUnavailableOrInvalid() throws {
        let pasteboard = UIPasteboard.withUniqueName()
        let record = mention("selected")
        let text = ComposerContextReferences.format(record)
        let fragment = ComposerContextClipboardFragment(source: .init(environmentId: "source"), records: [record])
        let html = ComposerContextClipboard.html(text: text, fragment: try ComposerContextClipboard.encode(fragment))
        pasteboard.items = [[UTType.utf8PlainText.identifier: text, UTType.html.identifier: Data(html.utf8)]]
        #expect(try FeatureContextClipboard.read(from: pasteboard)?.fragment == fragment)
        pasteboard.items = [[
            UTType.utf8PlainText.identifier: text, UTType.html.identifier: Data(html.utf8),
            ComposerContextClipboard.mimeType: Data("invalid JSON".utf8),
        ]]
        #expect(try FeatureContextClipboard.read(from: pasteboard)?.fragment == fragment)
    }

    @Test func aMarkdownViewWithoutAnEnvironmentKeepsPlainCopyAvailable() throws {
        let pasteboard = UIPasteboard.withUniqueName()
        let record = mention("source")
        let text = ComposerContextReferences.format(record)
        #expect(try !FeatureContextClipboard.write(text: text, source: nil, context: nil, pasteboard: pasteboard))
        #expect(pasteboard.data(forPasteboardType: ComposerContextClipboard.mimeType) == nil)
    }

    @Test func historySelectionUsesTheOriginalImageReferenceAndKeepsPartialLabels() {
        let source = "Before ![screenshot](t3-context://v1/image/shot) after"
        let selected = NSAttributedString(string: "screenshot", attributes: [.link: URL(string: "t3-context://v1/image/shot")!])
        #expect(FeatureContextClipboard.selectionText(selected, originalSource: source) == "![screenshot](t3-context://v1/image/shot)")
        #expect(FeatureContextClipboard.selectionText(selected.attributedSubstring(from: NSRange(location: 0, length: 6)), originalSource: source)
            == "[screen](t3-context://v1/image/shot)")
    }

    @Test(arguments: ["environment:local-source:thread:one", "logical-project:repo:new-task"])
    func localDraftBytesAreCopiedWithNewIDsAndPastedTextSource(key: String) async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let local = FeatureDraftAttachment(data: Data("retained paste bytes".utf8), filename: "file.txt", mimeType: "text/plain", source: .pastedText)
        let record = file("source-record", attachmentID: local.id.uuidString, size: local.byteCount)
        try await store.setDraft(.init(attachments: [local]), for: key)
        let reloaded = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let importer = importer(directory: directory, draftStore: reloaded)

        let result = try await importer.importContent(content(record, environment: "local-source"), attachmentCount: 0, contextCount: 0, imagesAllowed: true, maximumFileBytes: 1_000)
        let attachment = try #require(result.attachments.first)

        #expect(attachment.id != local.id)
        #expect(attachment.uploadedReference == nil)
        let ownedFile = try #require(attachment.ownedFile)
        #expect(try Data(contentsOf: ownedFile.url) == local.data)
        #expect(attachment.data.isEmpty)
        #expect(attachment.source == .pastedText)
        #expect(result.context.records.first?.attachment?.attachmentId == attachment.id.uuidString)
        #expect(result.context.records.first?.contextId != record.contextId)
        #expect(try await reloaded.draft(for: key)?.attachments == [local])
    }

    @Test func remoteImportResolvesTheSourceAndMakesAnOwnedDestinationFile() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let resolver = Resolver()
        var importer = importer(directory: directory)
        importer.resolver = resolver
        importer.download = { url in
            let temporary = directory.appendingPathComponent(UUID().uuidString)
            try Data("remote file".utf8).write(to: temporary)
            return (temporary, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let record = file("source-record", attachmentID: "source-server-id", size: 11)
        let result = try await importer.importContent(content(record), attachmentCount: 0, contextCount: 0, imagesAllowed: true, maximumFileBytes: 1_000)
        let attachment = try #require(result.attachments.first)
        let owned = try #require(attachment.ownedFile)

        #expect(resolver.requests.map(\.environmentID) == ["remote-source"])
        #expect(resolver.requests.map(\.attachmentID) == ["source-server-id"])
        #expect(try Data(contentsOf: owned.url) == Data("remote file".utf8))
        #expect(attachment.uploadedReference == nil)
        #expect(result.context.records.first?.attachment?.attachmentId == attachment.id.uuidString)
        #expect(result.context.records.first?.attachment?.attachmentId != "source-server-id")
    }

    @Test func mismatchedLocalMetadataDoesNotReuseTheAttachmentBytes() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let local = FeatureDraftAttachment(data: Data("original".utf8), filename: "original.txt", mimeType: "text/plain")
        try await store.setDraft(.init(attachments: [local]), for: "environment:local-source:thread:one")
        let importer = importer(directory: directory, draftStore: store)
        let clipboard = content(file("record", attachmentID: local.id.uuidString, size: local.byteCount), environment: "local-source")
        await #expect(throws: ComposerContextClipboardError.invalidFragment) {
            try await importer.importContent(clipboard, attachmentCount: 0, contextCount: 0, imagesAllowed: true, maximumFileBytes: 1_000)
        }
        #expect(try await store.draft(for: "environment:local-source:thread:one")?.attachments == [local])
    }

    @Test(arguments: [false, true])
    func failedOrCancelledImportsRollBackEarlierFiles(cancelled: Bool) async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let resolver = Resolver(failAfterFirst: true, cancelled: cancelled)
        var importer = importer(directory: directory)
        importer.resolver = resolver
        importer.download = { url in
            let temporary = directory.appendingPathComponent(UUID().uuidString)
            try Data("file".utf8).write(to: temporary)
            return (temporary, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let records = [file("first", attachmentID: "first-file", size: 4), file("second", attachmentID: "second-file", size: 4)]
        let clipboard = ComposerContextClipboard.Content(text: records.map(ComposerContextReferences.format).joined(separator: " "), fragment: .init(source: .init(environmentId: "remote-source"), records: records))
        await #expect(throws: (any Error).self) {
            try await importer.importContent(clipboard, attachmentCount: 0, contextCount: 0, imagesAllowed: true, maximumFileBytes: 1_000)
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: importer.fileStore.rootURL.path).isEmpty)
    }

    @Test func limitsRejectTheImportBeforeAnyDownload() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let resolver = Resolver()
        var importer = importer(directory: directory)
        importer.resolver = resolver
        let clipboard = content(file("file", attachmentID: "server-file", size: 1))
        await #expect(throws: ComposerContextClipboardError.contextLimit) {
            try await importer.importContent(clipboard, attachmentCount: 0, contextCount: 200, imagesAllowed: true, maximumFileBytes: 1_000)
        }
        await #expect(throws: FileAttachmentError.tooMany(maximum: 8)) {
            try await importer.importContent(clipboard, attachmentCount: 8, contextCount: 0, imagesAllowed: true, maximumFileBytes: 1_000)
        }
        await #expect(throws: FileAttachmentError.unsupported) {
            try await importer.importContent(clipboard, attachmentCount: 0, contextCount: 0, imagesAllowed: true, maximumFileBytes: nil)
        }
        #expect(resolver.requests.isEmpty)
    }

    @Test func replacingTheFinalAttachmentLinkRemovesOnlyItsOwnedAttachment() throws {
        let linked = FeatureDraftAttachment(data: Data("linked".utf8), filename: "linked.txt", mimeType: "text/plain")
        let independent = FeatureDraftAttachment(data: Data("strip".utf8), filename: "strip.txt", mimeType: "text/plain")
        let oldRecord = file("old", attachmentID: linked.id.uuidString, size: linked.byteCount)
        let newRecord = mention("new")
        let link = ComposerContextReferences.format(oldRecord)
        let incoming = FeatureContextClipboardImporter.Result(text: ComposerContextReferences.format(newRecord), context: .init(records: [newRecord]), attachments: [])
        let edit = try FeatureContextClipboardEdit.apply(
            text: "Before \(link) after", selection: NSRange(location: 7, length: link.utf16.count),
            context: .init(records: [oldRecord]), attachments: [linked, independent], imported: incoming
        )
        #expect(edit.text == "Before \(incoming.text) after")
        #expect(edit.cursor == 7 + incoming.text.utf16.count)
        #expect(edit.attachments == [independent])
        #expect(edit.context?.records == [newRecord])
        #expect(FeatureContextClipboardEdit.unlinkedAttachmentIDs(context: .init(records: [oldRecord]), previousText: link + link, text: link).isEmpty)
    }

    @Test func replacingContextAtTheLimitUsesOnlyTheRemainingRecords() throws {
        let records = (0 ..< 200).map { mention("item_\($0)") }
        let text = records.map(ComposerContextReferences.format).joined(separator: " ")
        let incoming = mention("incoming")
        let imported = FeatureContextClipboardImporter.Result(text: ComposerContextReferences.format(incoming), context: .init(records: [incoming]), attachments: [])
        let replaced = try FeatureContextClipboardEdit.apply(
            text: text, selection: NSRange(location: 0, length: ComposerContextReferences.format(records[0]).utf16.count),
            context: .init(records: records), attachments: [], imported: imported
        )
        #expect(replaced.context?.records.count == 200)
        #expect(replaced.context?.records.contains(records[0]) == false)
        #expect(replaced.context?.records.contains(incoming) == true)
        #expect(throws: FeatureComposerContext.MergeError.self) {
            try FeatureContextClipboardEdit.apply(text: text, selection: NSRange(location: text.utf16.count, length: 0), context: .init(records: records), attachments: [], imported: imported)
        }
    }

    private func mention(_ id: String) -> ComposerContextRecord {
        .init(contextId: id, label: id, payload: .mention(.init(path: "src/\(id).swift")))
    }

    private func file(_ id: String, attachmentID: String, size: Int) -> ComposerContextRecord {
        .init(contextId: id, label: "File", payload: .file(.init(attachmentId: attachmentID, name: "file.txt", mimeType: "text/plain", sizeBytes: size)))
    }

    private func content(_ record: ComposerContextRecord, environment: String = "remote-source") -> ComposerContextClipboard.Content {
        .init(text: ComposerContextReferences.format(record), fragment: .init(source: .init(environmentId: environment), records: [record]))
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func importer(directory: URL, draftStore: FeatureComposerDraftStore? = nil) -> FeatureContextClipboardImporter {
        FeatureContextClipboardImporter(
            fileStore: .init(rootURL: directory.appendingPathComponent("owned")),
            draftStore: draftStore ?? .init(fileURL: directory.appendingPathComponent("drafts.json")),
            outboxStore: .init(fileURL: directory.appendingPathComponent("outbox.json"))
        )
    }

    private final class Resolver: FeatureContextAttachmentResolving {
        struct Request { let environmentID: String; let attachmentID: String }
        var requests: [Request] = []
        let failAfterFirst: Bool
        let cancelled: Bool

        init(failAfterFirst: Bool = false, cancelled: Bool = false) {
            self.failAfterFirst = failAfterFirst
            self.cancelled = cancelled
        }

        func contextAttachmentAssetURL(environmentID: String, attachment: ComposerContextRecord.Attachment) async throws -> URL {
            requests.append(Request(environmentID: environmentID, attachmentID: attachment.attachmentId))
            if failAfterFirst, requests.count > 1 {
                if cancelled { throw CancellationError() }
                throw ComposerContextClipboardError.sourceUnavailable
            }
            return URL(string: "https://source.invalid/asset?signature=private")!
        }
    }
}

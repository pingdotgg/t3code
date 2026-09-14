import Foundation
import Testing
@testable import T3Code

@Suite("Composer context persistence")
struct ComposerContextPersistenceTests {
    @Test func draftAndOutboxKeepContextAndPasteSourceAcrossLaunches() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = "environment:a:thread:one"
        let record = ComposerContextRecord(contextId: "future", label: "Future", payload: .unknown(
            kind: "future-kind", payload: .object(["kept": .array([.null, .bool(true)])])
        ))
        let context = OrchestrationMessageContext(records: [record])
        let attachment = FeatureDraftAttachment(data: Data("paste".utf8), filename: "pasted-text.txt", mimeType: "text/plain", source: .pastedText)
        let draft = FeatureComposerDraft(text: ComposerContextReferences.format(record), attachments: [attachment], context: context)
        let draftsURL = directory.appendingPathComponent("drafts.json")
        try await FeatureComposerDraftStore(fileURL: draftsURL).setDraft(draft, for: key)
        let reloaded = FeatureComposerDraftStore(fileURL: draftsURL)
        #expect(try await reloaded.draft(for: key) == draft)
        #expect(try await reloaded.draft(for: "environment:b:thread:one") == nil)

        let outboxURL = directory.appendingPathComponent("outbox.json")
        let submission = FeatureQueuedSubmission(environmentID: "a", identity: .init(), threadID: "one",
            text: draft.text, selection: nil, runtimeMode: .fullAccess, interactionMode: .standard,
            attachments: [FeatureUploadAttachment(attachment)], context: context)
        try await FeatureOutboxStore(fileURL: outboxURL).enqueue(submission)
        let queued = try #require(await FeatureOutboxStore(fileURL: outboxURL).submissions().first)
        #expect(queued.context == context)
        #expect(queued.uploads.first?.source == .pastedText)
        #expect(queued.uploads.first?.data == attachment.data)
    }

    @Test func oldQueuedAttachmentsDecodeWithoutSourceOrContext() throws {
        let attachment = try JSONDecoder().decode(FeatureQueuedAttachment.self, from: Data(#"{"data":"cGFzdGU=","name":"old.txt","mimeType":"text/plain"}"#.utf8))
        #expect(attachment.source == nil)
        #expect(attachment.upload?.data == Data("paste".utf8))
    }

    @Test func draftRestoreDoesNotReplaceContextAddedDuringRead() throws {
        let savedRecord = ComposerContextRecord(label: "old", payload: .skill(.init(name: "old")))
        let newRecord = ComposerContextRecord(label: "new", payload: .skill(.init(name: "new")))
        let current = FeatureComposerDraft(text: ComposerContextReferences.format(newRecord), context: .init(records: [newRecord]))
        let restored = try FeatureComposerDraftRestoration.merge(
            saved: .init(text: ComposerContextReferences.format(savedRecord), context: .init(records: [savedRecord])),
            baseline: .init(), current: current
        )
        #expect(restored.context == current.context)
        #expect(restored.text == current.text)
    }

    @Test func terminalCaptureIsBoundedAndPreservesLineNumbers() {
        let record = FeatureComposerContext.terminalRecord(text: String(repeating: "line\n", count: 20_000), terminalID: "term", label: "Shell")
        guard case let .terminal(value) = record.payload else { Issue.record("Expected terminal context"); return }
        #expect(value.text.utf16.count == 64_000)
        #expect(value.lineEnd == 20_000)
        #expect(value.lineStart == 7_200)
    }

    @Test func longReviewCommentsKeepTheirFullTextOutsideTheBoundedRecord() {
        let body = String(repeating: "🙂", count: 8_001) + " keep this instruction"
        let draft = FeatureReviewCommentDraft(filePath: "file.swift", body: body)
        let record = draft.contextRecord(lines: [])
        #expect(draft.submissionText(contextRecord: record).contains(body))
        guard case let .reviewComment(value) = record.payload else { Issue.record("Expected review context"); return }
        #expect(value.text.utf16.count <= 16_000)
    }

    @Test func contextLimitRejectsAnAdditionWithoutChangingExistingRecords() throws {
        let records = (0..<200).map { ComposerContextRecord(contextId: "id_\($0)", label: "skill", payload: .skill(.init(name: "review"))) }
        let existing = OrchestrationMessageContext(records: records)
        let extra = ComposerContextRecord(contextId: "extra", label: "skill", payload: .skill(.init(name: "build")))
        #expect(throws: FeatureComposerContext.MergeError.self) {
            try FeatureComposerContext.merge(existing, .init(records: [extra]))
        }
        #expect(try FeatureComposerContext.merge(existing, .init(records: [records[0]])) == existing)
    }

    @Test func terminalTruncationStartsAtAValidUTF16Boundary() {
        let tail = String(repeating: "x", count: 63_999)
        let record = FeatureComposerContext.terminalRecord(text: "🙂" + tail, terminalID: "term", label: "Shell")
        guard case let .terminal(value) = record.payload else { Issue.record("Expected terminal context"); return }
        #expect(value.text == tail)
    }

    @Test func reviewSelectionUsesRenderedRowsAndKeepsTheSelectedCode() {
        let replacement = [
            FeatureDiffLine(id: "hunk", kind: .hunk, text: "@@ -1 +1 @@"),
            FeatureDiffLine(id: "old", kind: .deletion, oldLine: 1, text: "old"),
            FeatureDiffLine(id: "new", kind: .addition, newLine: 1, text: "new"),
        ]
        let draft = FeatureReviewCommentDraft(filePath: "file.swift", line: .init(side: .new, line: 1), body: "Check this")
        guard case let .reviewComment(value) = draft.contextRecord(lines: replacement).payload else {
            Issue.record("Expected review context"); return
        }
        #expect(value.startIndex == 2)
        #expect(value.diff.contains("-old\n+new"))

        let lines = (1...10_000).map { (number: Int) in
            FeatureDiffLine(id: "\(number)", kind: .context, oldLine: number, newLine: number, text: "source line \(number)")
        }
        let late = FeatureReviewCommentDraft(filePath: "file.swift", line: .init(side: .new, line: 9_000), body: "Check this")
        guard case let .reviewComment(window) = late.contextRecord(lines: lines).payload else {
            Issue.record("Expected review context"); return
        }
        #expect(window.startIndex == 8_999)
        #expect(window.diff.contains("source line 9000"))
        #expect(window.diff.utf16.count <= 32_000)
    }

    @Test(arguments: ["src/file #1.swift", "C:\\repo\\src\\file #1.swift"])
    func mentionLinksUseTheExistingWorkspaceRouter(path: String) throws {
        let url = try #require(FeatureComposerFileLinkSerializer.url(for: path))
        #expect(MarkdownWorkspaceFileLink.relativePath(for: url, workspaceRoot: "C:\\repo") == "src/file #1.swift")
    }
}

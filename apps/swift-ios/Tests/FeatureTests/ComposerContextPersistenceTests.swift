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

    @Test func draftRestoreDoesNotReplaceContextAddedDuringRead() {
        let savedRecord = ComposerContextRecord(label: "old", payload: .skill(.init(name: "old")))
        let newRecord = ComposerContextRecord(label: "new", payload: .skill(.init(name: "new")))
        let current = FeatureComposerDraft(text: ComposerContextReferences.format(newRecord), context: .init(records: [newRecord]))
        let restored = FeatureComposerDraftRestoration.merge(
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
}

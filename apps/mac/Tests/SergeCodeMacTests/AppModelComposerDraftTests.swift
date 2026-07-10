import Testing

@testable import SergeCodeMac

@Suite("AppModel composer drafts")
@MainActor
struct AppModelComposerDraftTests {
    private func makeModel() -> AppModel {
        AppModel(backend: MockBackend())
    }

    private func attachment(_ id: String) -> OutgoingAttachment {
        OutgoingAttachment(
            id: id, name: "\(id).png", mimeType: "image/png", sizeBytes: 3,
            dataURL: "data:image/png;base64,AA==")
    }

    @Test("text and attachments are isolated by thread")
    func draftsArePerThread() {
        let model = makeModel()
        let attachmentA = attachment("a")
        let attachmentB = attachment("b")

        model.setComposerDraftText("draft A", for: "thread-a")
        model.setComposerDraftAttachments([attachmentA], for: "thread-a")
        model.setComposerDraftText("draft B", for: "thread-b")
        model.setComposerDraftAttachments([attachmentB], for: "thread-b")

        model.selectedThreadID = "thread-a"
        #expect(
            model.composerDraft(for: model.selectedThreadID!)
                == ComposerDraft(text: "draft A", attachments: [attachmentA]))
        model.selectedThreadID = "thread-b"
        #expect(
            model.composerDraft(for: model.selectedThreadID!)
                == ComposerDraft(text: "draft B", attachments: [attachmentB]))
        model.selectedThreadID = "thread-a"
        #expect(model.composerDraft(for: model.selectedThreadID!).text == "draft A")
        #expect(model.composerDraft(for: "unknown").isEmpty)
    }

    @Test("prefill targets the selected thread and remains consumable")
    func prefillTargetsSelectedThread() {
        let model = makeModel()
        let stagedAttachment = attachment("kept")
        model.selectedThreadID = "thread-a"
        model.setComposerDraftAttachments([stagedAttachment], for: "thread-a")

        model.stageComposerText("edited message")

        #expect(model.composerDraft(for: "thread-a").text == "edited message")
        #expect(model.composerDraft(for: "thread-a").attachments == [stagedAttachment])
        #expect(model.composerPrefill?.threadID == "thread-a")
        #expect(model.takeComposerPrefill()?.text == "edited message")
        #expect(model.composerPrefill == nil)
    }

    @Test("failed send restores the submitted draft when the composer is empty")
    func failedSendRestoresEmptyDraft() {
        let model = makeModel()
        let submitted = ComposerDraft(text: "send me", attachments: [attachment("sent")])
        model.setComposerDraftText(submitted.text, for: "thread-a")
        model.setComposerDraftAttachments(submitted.attachments, for: "thread-a")

        model.clearComposerDraft(for: "thread-a")
        #expect(model.composerDraft(for: "thread-a").isEmpty)

        #expect(model.restoreComposerDraft(submitted, for: "thread-a"))
        #expect(model.composerDraft(for: "thread-a") == submitted)
    }

    @Test("failed send does not overwrite a newer draft")
    func failedSendPreservesNewerDraft() {
        let model = makeModel()
        let submitted = ComposerDraft(text: "send me", attachments: [attachment("sent")])
        model.setComposerDraftText(submitted.text, for: "thread-a")
        model.setComposerDraftAttachments(submitted.attachments, for: "thread-a")

        model.clearComposerDraft(for: "thread-a")
        model.setComposerDraftText("new text", for: "thread-a")
        #expect(!model.restoreComposerDraft(submitted, for: "thread-a"))
        #expect(model.composerDraft(for: "thread-a").text == "new text")
        #expect(model.composerDraft(for: "thread-a").attachments.isEmpty)
    }

    @Test("thread removal drops its draft and pending prefill")
    func removalCleansUpDraft() {
        let model = makeModel()
        model.selectedThreadID = "thread-a"
        model.setComposerDraftText("temporary", for: "thread-a")
        model.setComposerDraftAttachments([attachment("temporary")], for: "thread-a")
        model.stageComposerText("replacement")
        #expect(model.threadState("thread-a") != nil)

        model.enqueue(.threadRemoved(id: "thread-a"))
        model.flushPendingEvents()

        #expect(model.threadState("thread-a") == nil)
        #expect(model.selectedThreadID == nil)
        #expect(model.composerPrefill == nil)
        #expect(model.composerDraft(for: "thread-a").isEmpty)
    }
}

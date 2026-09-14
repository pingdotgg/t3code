import SwiftUI
import Testing
import UIKit
@testable import T3Code

@Suite("Pasted text")
struct FeaturePastedTextTests {
    @Test(arguments: [
        (String(repeating: "x", count: 32 * 1024 - 1), FeaturePastedText.Disposition.inline),
        (String(repeating: "x", count: 32 * 1024), .attachment),
        (String(repeating: "🙂", count: 8 * 1024), .attachment),
    ])
    func foldingUsesTheUTF8Boundary(text: String, expected: FeaturePastedText.Disposition) {
        #expect(FeaturePastedText.disposition(
            text: text,
            currentTextLength: 0,
            selection: NSRange(location: 0, length: 0),
            maximumAttachmentBytes: 50 * 1024 * 1024
        ) == expected)
    }

    @Test
    func attachmentAvailabilityIncludesPendingItemsAndTheFileCapability() {
        #expect(FeaturePastedText.maximumAttachmentBytes(
            advertisedMaximum: nil, attachmentCount: 0, pendingCount: 0
        ) == nil)
        #expect(FeaturePastedText.maximumAttachmentBytes(
            advertisedMaximum: 100, attachmentCount: 5, pendingCount: 3
        ) == nil)
        #expect(FeaturePastedText.maximumAttachmentBytes(
            advertisedMaximum: 0, attachmentCount: 0, pendingCount: 0
        ) == nil)
        #expect(FeaturePastedText.maximumAttachmentBytes(
            advertisedMaximum: 100, attachmentCount: 5, pendingCount: 2
        ) == 100)
        #expect(FeaturePastedText.maximumAttachmentBytes(
            advertisedMaximum: Int.max, attachmentCount: 0, pendingCount: 0
        ) == ManagedAttachmentFileStore.maximumBytes)
    }

    @Test(arguments: [nil, 32 * 1024 - 1] as [Int?])
    func unavailableAttachmentsFallBackInlineUnlessTheInputWouldOverflow(maximumBytes: Int?) {
        let text = String(repeating: "x", count: 32 * 1024)
        #expect(FeaturePastedText.disposition(
            text: text, currentTextLength: 0,
            selection: NSRange(location: 0, length: 0),
            maximumAttachmentBytes: maximumBytes
        ) == .inline)
        #expect(FeaturePastedText.disposition(
            text: text, currentTextLength: 120_000,
            selection: NSRange(location: 120_000, length: 0),
            maximumAttachmentBytes: maximumBytes
        ) == .rejected)
    }

    @Test
    func overflowCountsTheSelectedUTF16RangeBeforeThePaste() {
        #expect(FeaturePastedText.disposition(
            text: "🙂", currentTextLength: 120_000,
            selection: NSRange(location: 119_998, length: 2),
            maximumAttachmentBytes: 100
        ) == .inline)
        #expect(FeaturePastedText.disposition(
            text: "🙂!", currentTextLength: 120_000,
            selection: NSRange(location: 119_998, length: 2),
            maximumAttachmentBytes: 100
        ) == .attachment)
        #expect(FeaturePastedText.disposition(
            text: "x", currentTextLength: 120_000,
            selection: NSRange(location: NSNotFound, length: 100),
            maximumAttachmentBytes: 100
        ) == .attachment)
    }

    @Test
    func explicitTextPasteBypassesFolding() {
        #expect(FeaturePastedText.disposition(
            text: String(repeating: "x", count: 120_001), currentTextLength: 0,
            selection: NSRange(location: 0, length: 0),
            maximumAttachmentBytes: 50 * 1024 * 1024,
            bypassAutoAttachment: true
        ) == .inline)
    }

    @Test @MainActor
    func pasteAsTextShortcutInsertsTheClipboardAtTheSelection() throws {
        let pastedText = String(repeating: "x", count: 32 * 1024)
        let editor = FeatureComposerUITextView()
        editor.readClipboardText = { pastedText }
        editor.text = "Before selected after"
        editor.selectedRange = NSRange(location: 7, length: 8)
        editor.maximumPastedTextBytes = 50 * 1024 * 1024
        editor.onPasteTextAttachment = { _, _ in
            Issue.record("Paste as Text must keep the text inline")
        }
        let command = try #require(editor.keyCommands?.first {
            $0.input == "v" && $0.modifierFlags == [.command, .shift]
                && $0.action == #selector(FeatureComposerUITextView.pasteAsText(_:))
        })

        _ = editor.perform(command.action, with: nil)

        #expect(editor.text == "Before \(pastedText) after")
        #expect(editor.selectedRange == NSRange(location: 7 + pastedText.utf16.count, length: 0))
    }

    @Test
    func fileNamesUseTheFirstAvailableNumberWithoutCaseCollisions() {
        #expect(FeaturePastedText.nextFileName(existingNames: []) == "pasted-text.txt")
        #expect(FeaturePastedText.nextFileName(existingNames: [
            "PASTED-TEXT.TXT", "pasted-text-2.txt", "pasted-text-4.txt",
        ]) == "pasted-text-3.txt")
    }

    @Test @MainActor
    func foldingReplacesTheSelectionOnlyAfterTheAttachmentIsAccepted() {
        var draft = "Before $review after"
        var attachedText: String?
        var commitSelection: (@MainActor () -> Bool)?
        let input = FeatureComposerTextInput(
            text: Binding(get: { draft }, set: { draft = $0 }),
            focused: .constant(false), placeholder: "", acceptsImages: false,
            isReadOnly: false, skills: [.init(name: "review")],
            selectionRequest: nil, onSelectionChange: { _ in },
            onPasteImages: { _ in }, onDismissKeyboard: nil
        )
        let coordinator = FeatureComposerTextInput.Coordinator(input)
        let editor = FeatureComposerUITextView()
        editor.delegate = coordinator
        editor.font = UIFont.preferredFont(forTextStyle: .body)
        coordinator.synchronizeInlineSkills(
            in: editor, source: draft,
            selection: NSRange(location: 7, length: 7)
        )
        editor.maximumPastedTextBytes = 50 * 1024 * 1024
        editor.onPasteTextAttachment = { text, commit in
            #expect(draft == "Before $review after")
            attachedText = text
            commitSelection = commit
        }

        let pastedText = String(repeating: "🙂", count: 8 * 1024)
        #expect(editor.foldPastedText(pastedText))
        #expect(attachedText == pastedText)
        #expect(draft == "Before $review after")
        #expect(commitSelection?() == true)
        #expect(FeatureInlineSkillProjection.plainText(from: editor.attributedText) == "Before  after")
        #expect(editor.selectedRange == NSRange(location: 7, length: 0))
        #expect(coordinator.parent.text == "Before  after")
    }

    @Test @MainActor
    func aFailedFoldKeepsTheDraftAndSelection() {
        let editor = FeatureComposerUITextView()
        editor.text = "Before selected after"
        editor.selectedRange = NSRange(location: 7, length: 8)
        editor.maximumPastedTextBytes = 50 * 1024 * 1024
        var errorMessage: String?
        editor.onPasteTextError = { errorMessage = $0 }

        #expect(editor.foldPastedText(String(repeating: "x", count: 32 * 1024)))
        #expect(editor.text == "Before selected after")
        #expect(editor.selectedRange == NSRange(location: 7, length: 8))
        #expect(errorMessage != nil)
    }

    @Test @MainActor
    func preparedPasteDoesNotReplaceANewerDraftSelection() {
        let editor = FeatureComposerUITextView()
        editor.text = "Before selected after"
        editor.selectedRange = NSRange(location: 7, length: 8)
        editor.maximumPastedTextBytes = 50 * 1024 * 1024
        var commitSelection: (@MainActor () -> Bool)?
        editor.onPasteTextAttachment = { _, commit in commitSelection = commit }
        #expect(editor.foldPastedText(String(repeating: "x", count: 32 * 1024)))
        editor.text = "New draft"
        editor.selectedRange = NSRange(location: 3, length: 0)
        #expect(commitSelection?() == false)
        #expect(editor.text == "New draft")
        #expect(editor.selectedRange == NSRange(location: 3, length: 0))
    }

    @Test @MainActor
    func preparedPasteDoesNotCrossDraftOwners() {
        let editor = FeatureComposerUITextView()
        editor.draftOwnerID = "environment:a:thread:one"
        editor.text = "Same text"
        editor.selectedRange = NSRange(location: 0, length: 4)
        editor.maximumPastedTextBytes = 50 * 1024 * 1024
        var commitSelection: (@MainActor () -> Bool)?
        editor.onPasteTextAttachment = { _, commit in commitSelection = commit }
        #expect(editor.foldPastedText(String(repeating: "x", count: 32 * 1024)))
        editor.draftOwnerID = "environment:b:thread:two"
        #expect(commitSelection?() == false)
        #expect(editor.text == "Same text")
    }

    @Test
    func largePasteUsesOwnedFilesInDraftAndOutboxJSON() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let files = directory.appendingPathComponent("files")
        let value = String(repeating: "large paste\n", count: 100_000)
        let attachment = try await Task.detached {
            try FeaturePastedText.attachment(text: value, fileName: "pasted-text.txt", maximumBytes: 50 * 1024 * 1024,
                fileStore: ManagedAttachmentFileStore(rootURL: files))
        }.value
        let file = try #require(attachment.ownedFile)
        #expect(attachment.data.isEmpty)
        #expect(try Data(contentsOf: file.url) == Data(value.utf8))
        let draftsURL = directory.appendingPathComponent("drafts.json")
        let drafts = FeatureComposerDraftStore(fileURL: draftsURL, attachmentStorageRootURL: files)
        try await drafts.setDraft(.init(attachments: [attachment]), for: "environment:a:thread:one")
        let outboxURL = directory.appendingPathComponent("outbox.json")
        let outbox = FeatureOutboxStore(fileURL: outboxURL, attachmentStorageRootURL: files)
        try await outbox.enqueue(.init(environmentID: "a", identity: .init(), threadID: "one", text: "Inspect", selection: nil,
            runtimeMode: .fullAccess, interactionMode: .standard, attachments: [FeatureUploadAttachment(attachment)]))
        #expect(try Data(contentsOf: draftsURL).count < 2_000)
        #expect(try Data(contentsOf: outboxURL).count < 2_000)
        let restored = try #require(await FeatureOutboxStore(fileURL: outboxURL, attachmentStorageRootURL: files).submissions().first)
        #expect(restored.uploads.first?.ownedFile == file)
        #expect(restored.uploads.first?.source == .pastedText)
    }

    @Test @MainActor
    func anOverflowWithoutAnAttachmentSlotKeepsTheDraftAndSelection() {
        let editor = FeatureComposerUITextView()
        let original = String(repeating: "x", count: 120_000)
        editor.text = original
        editor.selectedRange = NSRange(location: 119_999, length: 1)
        var errorMessage: String?
        editor.onPasteTextError = { errorMessage = $0 }

        #expect(editor.foldPastedText("more"))
        #expect(editor.text == original)
        #expect(editor.selectedRange == NSRange(location: 119_999, length: 1))
        #expect(errorMessage != nil)
    }
}

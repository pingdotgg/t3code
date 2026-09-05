import Foundation
import SwiftUI
import Testing
import UIKit
@testable import T3Code

@Suite("Local voice input", .serialized)
@MainActor
struct FeatureVoiceInputTests {
    @Test(arguments: [false, true])
    func lockingTheDraftPreservesTheExistingKeyboard(keyboardIsOpen: Bool) async throws {
        var text = "Draft"
        var focused = keyboardIsOpen
        func input(readOnly: Bool) -> FeatureComposerTextInput {
            FeatureComposerTextInput(
                text: Binding(get: { text }, set: { text = $0 }),
                focused: Binding(get: { focused }, set: { focused = $0 }),
                placeholder: "Message", acceptsImages: true, isReadOnly: readOnly,
                skills: [],
                selectionRequest: nil, onSelectionChange: { _ in },
                onPasteImages: { _ in Issue.record("Pasted while dictating") },
                onDismissKeyboard: nil
            )
        }
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: input(readOnly: false))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previousKeyWindow?.makeKey()
        }

        let editor = try #require(await renderedEditor(in: host.view, readOnly: false))
        #expect(editor.isFirstResponder == keyboardIsOpen)
        host.rootView = input(readOnly: true)
        #expect(await renderedEditor(in: host.view, readOnly: true) === editor)
        #expect(editor.isFirstResponder == keyboardIsOpen)
        #expect(focused == keyboardIsOpen)
        #expect(editor.isEditable)
        #expect(!editor.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
        editor.insertText("ignored")
        editor.deleteBackward()
        #expect(text == "Draft")
        #expect(editor.text == "Draft")

        host.rootView = input(readOnly: false)
        #expect(await renderedEditor(in: host.view, readOnly: false) === editor)
        #expect(editor.isFirstResponder == keyboardIsOpen)
        editor.insertText(" works")
        #expect(text == "Draft works")
    }

    private func renderedEditor(in view: UIView, readOnly: Bool) async -> FeatureComposerUITextView? {
        func find(in view: UIView) -> FeatureComposerUITextView? {
            if let editor = view as? FeatureComposerUITextView { return editor }
            return view.subviews.lazy.compactMap { find(in: $0) }.first
        }
        for _ in 0..<30 {
            view.setNeedsLayout()
            view.layoutIfNeeded()
            if let editor = find(in: view), editor.isReadOnly == readOnly {
                return editor
            }
            try? await Task.sleep(for: .milliseconds(16))
        }
        return nil
    }

    @Test
    func insertsAtUTF16SelectionsWithEnglishSpacing() {
        let text = "Fix 🧪 then $review please"
        let selectedRange = (text as NSString).range(of: "$review")
        let selected = snapshot(text: text, selection: selectedRange)

        guard case let .commit(selectedCommit) = FeatureVoiceTranscriptResolver.resolve(
            captured: selected,
            current: selected,
            transcript: "use the mobile skill",
            localeIdentifier: "en-US"
        ) else {
            Issue.record("Expected a selected-text transcript commit")
            return
        }
        #expect(selectedCommit.text == "Fix 🧪 then use the mobile skill please")
        #expect(
            selectedCommit.caretLocation
                == selectedRange.location + "use the mobile skill".utf16.count
        )

        let atEnd = snapshot(
            text: "Fix cache.",
            selection: NSRange(location: "Fix cache.".utf16.count, length: 0)
        )
        guard case let .commit(commit) = FeatureVoiceTranscriptResolver.resolve(
            captured: atEnd,
            current: atEnd,
            transcript: "Also fix tests.",
            localeIdentifier: "en_US"
        ) else {
            Issue.record("Expected a transcript commit")
            return
        }
        #expect(commit.text == "Fix cache. Also fix tests.")
        #expect(commit.caretLocation == commit.text.utf16.count)
    }

    @Test
    func preservesUnicodeBoundariesAndNonEnglishSpacing() {
        let text = "修正🧪キャッシュ"
        let caret = (text as NSString).range(of: "キャッシュ").location
        let draft = snapshot(
            text: text,
            selection: NSRange(location: caret, length: 0)
        )

        guard case let .commit(commit) = FeatureVoiceTranscriptResolver.resolve(
            captured: draft,
            current: draft,
            transcript: "テストも",
            localeIdentifier: "ja-JP"
        ) else {
            Issue.record("Expected a transcript commit")
            return
        }
        #expect(commit.text == "修正🧪テストもキャッシュ")
        #expect(commit.caretLocation == caret + "テストも".utf16.count)
    }

    @Test
    func rejectsChangedDraftTextRevisionAndOwner() {
        let captured = snapshot()
        let changedText = snapshot(text: "newer")
        let changedRevision = snapshot(revision: 2)
        let changedOwner = snapshot(ownerID: "thread:other")

        #expect(resolve(captured, changedText) == .stale)
        #expect(resolve(captured, changedRevision) == .stale)
        #expect(resolve(captured, changedOwner) == .stale)
    }

    @Test
    func cancellationBeforeAndAfterPermissionCleansUpWithoutRecording() async {
        let beforePermission = TestVoiceInputAdapter()
        let beforeController = controller(adapter: beforePermission)
        beforePermission.onPermissionRequest = { beforeController.cancel() }
        beforeController.start()
        await beforeController.waitForCurrentOperation()

        #expect(beforeController.phase == .idle)
        #expect(beforePermission.startRecordingCount == 0)
        #expect(beforePermission.cleanupCount == 1)
        #expect(beforeController.pendingCommit == nil)

        let afterPermission = TestVoiceInputAdapter()
        let afterController = controller(adapter: afterPermission)
        afterPermission.onStartRecording = { afterController.cancel() }
        afterController.start()
        await afterController.waitForCurrentOperation()

        #expect(afterController.phase == .idle)
        #expect(afterPermission.startRecordingCount == 1)
        #expect(afterPermission.cleanupCount == 1)
        #expect(afterController.pendingCommit == nil)
    }

    @Test
    func cancellationDuringTranscriptionDiscardsLateResultsAndOwnedAudio() async {
        let adapter = TestVoiceInputAdapter()
        let controller = controller(adapter: adapter)
        adapter.onTranscribe = { controller.cancel() }

        controller.start()
        await controller.waitForCurrentOperation()
        #expect(controller.phase == .recording)

        controller.stop()
        await controller.waitForCurrentOperation()

        #expect(controller.phase == .idle)
        #expect(controller.pendingCommit == nil)
        #expect(adapter.cleanupCount == 1)
        #expect(adapter.ownedRecordingWasRemoved)
    }

    @Test
    func changedOwnerDuringTranscriptionNeverCommits() async {
        let adapter = TestVoiceInputAdapter()
        let controller = controller(adapter: adapter)
        adapter.onTranscribe = {
            controller.ownerChanged(to: FeatureVoiceDraftSnapshot(
                ownerID: "thread:other",
                text: "hello world",
                revision: 1,
                selection: NSRange(location: 6, length: 5)
            ))
        }

        controller.start()
        await controller.waitForCurrentOperation()
        controller.stop()
        await controller.waitForCurrentOperation()

        #expect(controller.pendingCommit == nil)
        #expect(adapter.cleanupCount == 1)
    }

    private func controller(adapter: TestVoiceInputAdapter) -> FeatureVoiceInputController {
        let controller = FeatureVoiceInputController(adapter: adapter)
        controller.updateDraft(snapshot())
        return controller
    }

    private func resolve(
        _ captured: FeatureVoiceDraftSnapshot,
        _ current: FeatureVoiceDraftSnapshot
    ) -> FeatureVoiceTranscriptCommitResult {
        FeatureVoiceTranscriptResolver.resolve(
            captured: captured,
            current: current,
            transcript: "replacement",
            localeIdentifier: "en-US"
        )
    }

    private func snapshot(
        ownerID: String = "thread:one",
        text: String = "hello world",
        revision: UInt64 = 1,
        selection: NSRange = NSRange(location: 6, length: 5)
    ) -> FeatureVoiceDraftSnapshot {
        FeatureVoiceDraftSnapshot(
            ownerID: ownerID,
            text: text,
            revision: revision,
            selection: selection
        )
    }
}

@MainActor
private final class TestVoiceInputAdapter: FeatureVoiceInputAdapter {
    let isSupported = true
    let localeIdentifier = "en-US"
    var onPermissionRequest: (() -> Void)?
    var onStartRecording: (() -> Void)?
    var onTranscribe: (() -> Void)?
    private(set) var startRecordingCount = 0
    private(set) var cleanupCount = 0
    private(set) var ownedRecordingWasRemoved = false

    func prepare() async throws {}

    func requestMicrophonePermission() async -> FeatureVoiceMicrophonePermission {
        onPermissionRequest?()
        return .granted
    }

    func startRecording(maximumDuration: TimeInterval) throws {
        startRecordingCount += 1
        #expect(maximumDuration == 5 * 60)
        onStartRecording?()
    }

    func stopRecording() async throws -> URL {
        URL(fileURLWithPath: "/tmp/t3-owned-voice-test.m4a")
    }

    func transcribe(recordingURL: URL) async throws -> String {
        onTranscribe?()
        return "late transcript"
    }

    func cancelTranscription() async {}

    func cleanup() async {
        cleanupCount += 1
        ownedRecordingWasRemoved = true
    }
}

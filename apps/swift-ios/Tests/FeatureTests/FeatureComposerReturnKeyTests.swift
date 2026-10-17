import Foundation
import Testing
import UIKit
@testable import T3Code

@MainActor
@Suite("Composer hardware Return")
struct FeatureComposerReturnKeyTests {
    @Test
    func persistedPreferenceDefaultsForOlderSettingsAndRoundTrips() throws {
        let oldSettings = try JSONDecoder().decode(FeatureSettings.self, from: Data(#"{"hapticsEnabled":false}"#.utf8))
        #expect(oldSettings.composerEnterBehavior == .send)
        #expect(!oldSettings.hapticsEnabled)

        var settings = oldSettings
        settings.composerEnterBehavior = .newline
        let reloaded = try JSONDecoder().decode(FeatureSettings.self, from: JSONEncoder().encode(settings))
        #expect(reloaded == settings)
        #expect(reloaded.composerEnterBehavior == .newline)
    }

    @Test
    func sendModeUsesReturnForPrimaryCommandReturnForAlternateAndShiftForNewline() throws {
        let editor = FeatureComposerUITextView()
        editor.text = "draft"
        editor.selectedRange = NSRange(location: 5, length: 0)
        var submits: [Bool] = []
        editor.onHardwareSubmit = { submits.append($0) }
        try performReturn(in: editor, modifiers: [])
        try performReturn(in: editor, modifiers: .command)
        #expect(submits == [false, true])
        #expect(editor.text == "draft")
        try performReturn(in: editor, modifiers: .shift)
        #expect(editor.text == "draft\n")
        #expect(submits == [false, true])
    }

    @Test
    func newlineModeLeavesPlainReturnWithUIKitAndKeepsBothSendActions() throws {
        let editor = FeatureComposerUITextView()
        editor.composerEnterBehavior = .newline
        var submits: [Bool] = []
        editor.onHardwareSubmit = { submits.append($0) }
        #expect(!returnCommands(in: editor).contains { $0.modifierFlags.isEmpty })
        #expect(!returnCommands(in: editor).contains { $0.modifierFlags == .shift })
        try performReturn(in: editor, modifiers: .command)
        try performReturn(in: editor, modifiers: [.command, .shift])
        #expect(submits == [false, true])
    }

    @Test
    func softwareReturnAndPastedNewlinesNeverSubmit() {
        let editor = FeatureComposerUITextView()
        var submits = 0
        editor.onHardwareSubmit = { _ in submits += 1 }
        editor.insertText("one\ntwo")
        editor.insertText("\n")
        #expect(editor.text == "one\ntwo\n")
        #expect(submits == 0)
    }

    @Test
    func readOnlyOrMarkedTextCannotSubmitAnAlreadyResolvedCommand() throws {
        let editor = FeatureComposerUITextView()
        var submits = 0
        editor.onHardwareSubmit = { _ in submits += 1 }
        let command = try #require(returnCommands(in: editor).first { $0.modifierFlags.isEmpty })
        let action = try #require(command.action)
        editor.isReadOnly = true
        #expect(returnCommands(in: editor).isEmpty)
        #expect(!editor.canPerformAction(action, withSender: command))
        editor.perform(action, with: command)
        #expect(submits == 0)

        editor.isReadOnly = false
        editor.setMarkedText("漢", selectedRange: NSRange(location: 1, length: 0))
        #expect(editor.markedTextRange != nil)
        #expect(!editor.canPerformAction(action, withSender: command))
        editor.perform(action, with: command)
        #expect(submits == 0)
    }

    @Test
    func disabledEditorAndUnboundComposerKeepExistingPasteShortcutWithoutSend() {
        let editor = FeatureComposerUITextView()
        #expect(returnCommands(in: editor).isEmpty)
        editor.onHardwareSubmit = { _ in }
        editor.isEditable = false
        #expect(returnCommands(in: editor).isEmpty)
        #expect(editor.keyCommands?.contains { $0.input == "v" && $0.modifierFlags == [.command, .shift] } == true)
    }

    @Test
    func sendShortcutHUDUsesActualQueueAndSteerLabels() throws {
        let editor = FeatureComposerUITextView()
        editor.onHardwareSubmit = { _ in }
        editor.hardwareSubmitTitle = "Queue Message"
        editor.hardwareAlternateSubmitTitle = "Steer Message"
        #expect(returnCommands(in: editor).first { $0.modifierFlags.isEmpty }?.discoverabilityTitle == "Queue Message")
        #expect(returnCommands(in: editor).first { $0.modifierFlags == .command }?.discoverabilityTitle == "Steer Message")
        editor.composerEnterBehavior = .newline
        #expect(returnCommands(in: editor).first { $0.modifierFlags == .command }?.discoverabilityTitle == "Queue Message")
        #expect(returnCommands(in: editor).first { $0.modifierFlags == [.command, .shift] }?.discoverabilityTitle == "Steer Message")
    }

    private func returnCommands(in editor: FeatureComposerUITextView) -> [UIKeyCommand] {
        (editor.keyCommands ?? []).filter { $0.input == "\r" }
    }

    private func performReturn(in editor: FeatureComposerUITextView, modifiers: UIKeyModifierFlags) throws {
        let command = try #require(returnCommands(in: editor).first { $0.modifierFlags == modifiers })
        editor.perform(try #require(command.action), with: command)
    }
}

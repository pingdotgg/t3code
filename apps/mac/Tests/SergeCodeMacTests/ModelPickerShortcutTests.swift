import SwiftUI
import Testing

@testable import SergeCodeMac

@Suite("Model picker shortcut")
struct ModelPickerShortcutTests {
    @Test("only ⌘D toggles the highlighted row's star")
    func favoriteChordRequiresCommandAlone() {
        #expect(ModelPickerShortcut.isFavoriteToggle(modifiers: .command))
        // Caps Lock and the numeric-pad flag ride along on real key events
        // without changing what the user asked for.
        #expect(ModelPickerShortcut.isFavoriteToggle(modifiers: [.command, .capsLock]))
        #expect(ModelPickerShortcut.isFavoriteToggle(modifiers: [.command, .numericPad]))

        // Plain "d" has to keep reaching the search field, and the other
        // chords belong to whoever else claims them.
        #expect(ModelPickerShortcut.isFavoriteToggle(modifiers: []) == false)
        #expect(ModelPickerShortcut.isFavoriteToggle(modifiers: [.command, .shift]) == false)
        #expect(ModelPickerShortcut.isFavoriteToggle(modifiers: [.command, .option]) == false)
        #expect(ModelPickerShortcut.isFavoriteToggle(modifiers: .option) == false)
    }

    @Test("the favorite key is the same kind of value as the named key equivalents")
    func favoriteKeyIsAKeyEquivalent() {
        #expect(ModelPickerShortcut.favoriteKey.character == "d")
        #expect(ModelPickerShortcut.favoriteKey != KeyEquivalent.upArrow)
    }
}

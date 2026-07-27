import Foundation
import Testing

@testable import SergeCodeMac

@MainActor
@Suite("Model picker preferences")
struct ModelPickerPreferencesTests {
    private func makeDefaults() -> UserDefaults {
        let suite = "ModelPickerPreferencesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test("favorites toggle and survive a reload")
    func favoritesPersist() {
        let defaults = makeDefaults()
        let preferences = ModelPickerPreferences(defaults: defaults)

        #expect(preferences.toggleFavorite("codex/gpt-5") == true)
        #expect(preferences.isFavorite("codex/gpt-5"))
        #expect(ModelPickerPreferences(defaults: defaults).isFavorite("codex/gpt-5"))

        #expect(preferences.toggleFavorite("codex/gpt-5") == false)
        #expect(ModelPickerPreferences(defaults: defaults).favorites.isEmpty)
    }

    @Test("recents move to the front without duplicating")
    func recentsDeduplicate() {
        let preferences = ModelPickerPreferences(defaults: makeDefaults())

        preferences.recordUsage("codex/gpt-5")
        preferences.recordUsage("claude/sonnet-5")
        preferences.recordUsage("codex/gpt-5")

        #expect(preferences.recents == ["codex/gpt-5", "claude/sonnet-5"])
        #expect(preferences.recencyRank(of: "claude/sonnet-5") == 1)
        #expect(preferences.recencyRank(of: "grok/grok-4") == nil)
    }

    @Test("recents are capped so the scope stays a shortcut, not a second catalog")
    func recentsAreCapped() {
        let defaults = makeDefaults()
        let preferences = ModelPickerPreferences(defaults: defaults)

        for index in 0..<(ModelPickerPreferences.recentLimit + 4) {
            preferences.recordUsage("codex/model-\(index)")
        }

        #expect(preferences.recents.count == ModelPickerPreferences.recentLimit)
        #expect(preferences.recents.first == "codex/model-\(ModelPickerPreferences.recentLimit + 3)")
        #expect(
            ModelPickerPreferences(defaults: defaults).recents.count
                == ModelPickerPreferences.recentLimit)
    }

    @Test("clearing recents leaves favorites alone")
    func clearRecentsKeepsFavorites() {
        let preferences = ModelPickerPreferences(defaults: makeDefaults())
        preferences.toggleFavorite("codex/gpt-5")
        preferences.recordUsage("codex/gpt-5")

        preferences.clearRecents()

        #expect(preferences.recents.isEmpty)
        #expect(preferences.isFavorite("codex/gpt-5"))
    }
}

import Foundation

/// Starred models and most-recently-used models for the model picker.
///
/// Keyed by the picker's collapsed catalog key (`provider/model-id`) rather
/// than by `ModelOption.id`, so a favorite survives the provider instance
/// behind it being replaced — reconnecting a provider mints a new instance id
/// but the same model keeps its star and its place in the recents list.
///
/// Stored in `UserDefaults` because this is a local taste preference, not
/// server state: it must not round-trip through a session and must be readable
/// before the first backend connection lands.
@MainActor
@Observable
final class ModelPickerPreferences {
    static let shared = ModelPickerPreferences()

    static let favoritesDefaultsKey = "modelPicker.favorites"
    static let recentsDefaultsKey = "modelPicker.recents"

    /// Enough to cover a working set without turning the Recent scope into a
    /// second copy of the whole catalog.
    static let recentLimit = 8

    private(set) var favorites: Set<String>
    /// Most recent first.
    private(set) var recents: [String]

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.favorites = Set(defaults.stringArray(forKey: Self.favoritesDefaultsKey) ?? [])
        self.recents = Array(
            (defaults.stringArray(forKey: Self.recentsDefaultsKey) ?? []).prefix(Self.recentLimit))
    }

    func isFavorite(_ key: String) -> Bool {
        favorites.contains(key)
    }

    /// Returns the new state so call sites can drive feedback without re-reading.
    @discardableResult
    func toggleFavorite(_ key: String) -> Bool {
        let isNowFavorite: Bool
        if favorites.contains(key) {
            favorites.remove(key)
            isNowFavorite = false
        } else {
            favorites.insert(key)
            isNowFavorite = true
        }
        defaults.set(Array(favorites), forKey: Self.favoritesDefaultsKey)
        return isNowFavorite
    }

    func recordUsage(_ key: String) {
        var updated = recents.filter { $0 != key }
        updated.insert(key, at: 0)
        recents = Array(updated.prefix(Self.recentLimit))
        defaults.set(recents, forKey: Self.recentsDefaultsKey)
    }

    /// Recency position, `nil` when the model has not been picked recently.
    func recencyRank(of key: String) -> Int? {
        recents.firstIndex(of: key)
    }

    func clearRecents() {
        recents = []
        defaults.set(recents, forKey: Self.recentsDefaultsKey)
    }
}

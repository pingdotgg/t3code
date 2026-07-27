import Foundation

/// One visually unique model row. Multiple provider instances can advertise
/// the same provider/model pair; those alternatives are collapsed here so the
/// picker never makes the user scan indistinguishable duplicates.
struct ModelPickerItem: Identifiable, Hashable {
    let option: ModelOption
    let matchingInstanceCount: Int

    var id: String { ModelPickerCatalog.key(for: option) }
}

/// What the browser is currently showing. Provider filters and the two
/// cross-provider scopes (favorites, recents) are one choice, because they are
/// one sidebar list to the user.
enum ModelPickerScope: Hashable {
    case all
    case favorites
    case recents
    case provider(ProviderKind)
}

enum ModelPickerCatalog {
    static func items(
        from options: [ModelOption],
        selectedInstanceID: String?,
        selectedModelID: String?
    ) -> [ModelPickerItem] {
        let selectedID = selectedInstanceID.map { "\($0)/\(selectedModelID ?? "")" }
        let grouped = Dictionary(grouping: options) { key(for: $0) }

        return grouped.values.map { matches in
            let representative = matches.sorted { lhs, rhs in
                let lhsSelected = lhs.id == selectedID
                let rhsSelected = rhs.id == selectedID
                if lhsSelected != rhsSelected { return lhsSelected }
                if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
                return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
            }.first!
            return ModelPickerItem(option: representative, matchingInstanceCount: matches.count)
        }.sorted(by: catalogOrder)
    }

    /// Stable identity of a picker row: the provider plus the normalized model
    /// id, with the provider instance deliberately left out so favorites and
    /// recents survive a reconnect minting a new instance id.
    static func key(for option: ModelOption) -> String {
        "\(option.provider.rawValue)/\(normalized(option.modelID))"
    }

    static func filteredItems(
        _ items: [ModelPickerItem],
        scope: ModelPickerScope,
        query: String,
        favorites: Set<String> = [],
        recents: [String] = []
    ) -> [ModelPickerItem] {
        let scoped = itemsInScope(items, scope: scope, favorites: favorites, recents: recents)
        let normalizedQuery = normalized(query)
        guard !normalizedQuery.isEmpty else { return scoped }

        // Ranked results replace the scope's natural order while searching:
        // typing is a request for the best match, not for alphabetical order.
        return
            scoped
            .enumerated()
            .compactMap { index, item in
                matchScore(item, query: normalizedQuery).map {
                    (item: item, score: $0, index: index)
                }
            }
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                return lhs.index < rhs.index
            }
            .map(\.item)
    }

    static func favoriteItems(_ items: [ModelPickerItem], favorites: Set<String>)
        -> [ModelPickerItem]
    {
        items.filter { favorites.contains($0.id) }
    }

    /// Recents in recency order. Models the backend no longer offers are
    /// dropped rather than shown as dead rows.
    static func recentItems(_ items: [ModelPickerItem], recents: [String]) -> [ModelPickerItem] {
        let byKey = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return recents.compactMap { byKey[$0] }
    }

    /// `nil` when the item does not match at all. Higher is a better match.
    ///
    /// Fields are weighted (display name > model id > provider name) and each
    /// field is scored by how direct the hit is: exact, prefix, word-boundary
    /// substring, mid-word substring, then subsequence — so "s5" still finds
    /// "Sonnet 5" while "sonnet" keeps Sonnet above anything that merely
    /// contains those letters.
    static func matchScore(_ item: ModelPickerItem, query: String) -> Int? {
        let normalizedQuery = normalized(query)
        guard !normalizedQuery.isEmpty else { return 0 }

        // Weights multiply rather than add so a strong hit on the model's name
        // always outranks the same hit on its provider — "code" should find
        // Grok Code before every Codex model.
        let fields: [(value: String, weight: Int)] = [
            (normalized(item.option.displayName), 10),
            (normalized(item.option.modelID), 9),
            (normalized(item.option.provider.displayName), 7),
        ]

        return fields.compactMap { field in
            fieldScore(field.value, query: normalizedQuery).map { $0 * field.weight }
        }.max()
    }

    static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    // MARK: - Internals

    private static func itemsInScope(
        _ items: [ModelPickerItem],
        scope: ModelPickerScope,
        favorites: Set<String>,
        recents: [String]
    ) -> [ModelPickerItem] {
        switch scope {
        case .all:
            return items
        case .favorites:
            return favoriteItems(items, favorites: favorites)
        case .recents:
            return recentItems(items, recents: recents)
        case .provider(let provider):
            return items.filter { $0.option.provider == provider }
        }
    }

    private static func catalogOrder(_ lhs: ModelPickerItem, _ rhs: ModelPickerItem) -> Bool {
        let lhsProvider = ProviderKind.allCases.firstIndex(of: lhs.option.provider) ?? .max
        let rhsProvider = ProviderKind.allCases.firstIndex(of: rhs.option.provider) ?? .max
        if lhsProvider != rhsProvider { return lhsProvider < rhsProvider }
        return lhs.option.displayName.localizedStandardCompare(rhs.option.displayName)
            == .orderedAscending
    }

    private static func fieldScore(_ field: String, query: String) -> Int? {
        if field == query { return 1000 }
        if field.hasPrefix(query) { return 700 }
        if let range = field.range(of: query) {
            let offset = field.distance(from: field.startIndex, to: range.lowerBound)
            let previous = field[field.index(before: range.lowerBound)]
            let startsWord = !previous.isLetter && !previous.isNumber
            guard startsWord else {
                // Later mid-word hits read as weaker matches, but never below
                // the best subsequence score.
                return max(300, 500 - offset * 5)
            }
            // A whole word ("code" in "Grok Code") beats a word that merely
            // starts with the query ("code" in "GPT-5 Codex").
            let isWholeWord =
                range.upperBound == field.endIndex
                || !(field[range.upperBound].isLetter || field[range.upperBound].isNumber)
            return isWholeWord ? 650 : 600
        }
        return subsequenceScore(field, query: query)
    }

    /// Scores an in-order, possibly gapped match ("gp5" in "gpt-5"). Tighter
    /// runs score higher; a query that is not a subsequence returns `nil`.
    private static func subsequenceScore(_ field: String, query: String) -> Int? {
        var gaps = 0
        var isFirstMatch = true
        var fieldIndex = field.startIndex

        for character in query {
            var advanced = 0
            while fieldIndex < field.endIndex, field[fieldIndex] != character {
                fieldIndex = field.index(after: fieldIndex)
                advanced += 1
            }
            guard fieldIndex < field.endIndex else { return nil }
            // Leading skips cost less than gaps inside the match itself.
            gaps += isFirstMatch ? min(advanced, 5) : advanced
            isFirstMatch = false
            fieldIndex = field.index(after: fieldIndex)
        }

        return max(100, 250 - gaps * 5)
    }
}

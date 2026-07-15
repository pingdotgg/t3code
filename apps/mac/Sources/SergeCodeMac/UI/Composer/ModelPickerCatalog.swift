import Foundation

/// One visually unique model row. Multiple provider instances can advertise
/// the same provider/model pair; those alternatives are collapsed here so the
/// picker never makes the user scan indistinguishable duplicates.
struct ModelPickerItem: Identifiable, Hashable {
    let option: ModelOption
    let matchingInstanceCount: Int

    var id: String {
        "\(option.provider.rawValue)/\(ModelPickerCatalog.normalized(option.modelID))"
    }
}

enum ModelPickerProviderFilter: Hashable {
    case all
    case provider(ProviderKind)
}

enum ModelPickerCatalog {
    static func items(
        from options: [ModelOption],
        selectedInstanceID: String?,
        selectedModelID: String?
    ) -> [ModelPickerItem] {
        let selectedID = selectedInstanceID.map { "\($0)/\(selectedModelID ?? "")" }
        let grouped = Dictionary(grouping: options) { option in
            "\(option.provider.rawValue)/\(normalized(option.modelID))"
        }

        return grouped.values.map { matches in
            let representative = matches.sorted { lhs, rhs in
                let lhsSelected = lhs.id == selectedID
                let rhsSelected = rhs.id == selectedID
                if lhsSelected != rhsSelected { return lhsSelected }
                if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
                return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
            }.first!
            return ModelPickerItem(option: representative, matchingInstanceCount: matches.count)
        }.sorted { lhs, rhs in
            let lhsProvider = ProviderKind.allCases.firstIndex(of: lhs.option.provider) ?? .max
            let rhsProvider = ProviderKind.allCases.firstIndex(of: rhs.option.provider) ?? .max
            if lhsProvider != rhsProvider { return lhsProvider < rhsProvider }
            return lhs.option.displayName.localizedStandardCompare(rhs.option.displayName) == .orderedAscending
        }
    }

    static func filteredItems(
        _ items: [ModelPickerItem],
        providerFilter: ModelPickerProviderFilter,
        query: String
    ) -> [ModelPickerItem] {
        let normalizedQuery = normalized(query)
        return items.filter { item in
            let providerMatches: Bool
            switch providerFilter {
            case .all:
                providerMatches = true
            case .provider(let provider):
                providerMatches = item.option.provider == provider
            }

            guard providerMatches else { return false }
            guard !normalizedQuery.isEmpty else { return true }
            return normalized(item.option.displayName).contains(normalizedQuery)
                || normalized(item.option.modelID).contains(normalizedQuery)
                || normalized(item.option.provider.displayName).contains(normalizedQuery)
        }
    }

    static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

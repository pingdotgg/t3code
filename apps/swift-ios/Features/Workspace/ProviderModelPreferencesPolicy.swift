import Foundation

enum ProviderModelPreferencesPolicy {
    static func providers(
        _ providers: [FeatureProvider],
        preferences: ServerModelPreferencesSnapshot?,
        includeHidden: Bool
    ) -> [FeatureProvider] {
        providers.map { provider in
            guard let preferences = preferences?.providerModelPreferences?[provider.id] else { return provider }
            var result = provider
            let hidden = Set(preferences.hiddenModels)
            var order: [String: Int] = [:]
            for (index, modelID) in preferences.modelOrder.enumerated() where order[modelID] == nil {
                order[modelID] = index
            }
            result.models = provider.models.enumerated().filter {
                includeHidden || $0.element.isCustom == true || !hidden.contains($0.element.id)
            }.sorted {
                let left = order[$0.element.id] ?? Int.max
                let right = order[$1.element.id] ?? Int.max
                return left == right ? $0.offset < $1.offset : left < right
            }.map(\.element)
            return result
        }
    }

    static func isHidden(_ option: DailyUXModelOption, preferences: ServerModelPreferencesSnapshot?) -> Bool {
        option.model.isCustom != true
            && preferences?.providerModelPreferences?[option.provider.id]?.hiddenModels.contains(option.model.id) == true
    }
}

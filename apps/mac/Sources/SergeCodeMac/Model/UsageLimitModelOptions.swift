/// Pure selection policy for the usage-limit card's model switcher.
enum UsageLimitModelOptions {
    static func options(
        available: [ModelOption],
        currentInstanceID: String?,
        currentModelID: String?,
        exhaustedProvider: ProviderKind?
    ) -> [ModelOption] {
        let candidates = available.filter { option in
            !(option.instanceID == currentInstanceID && option.modelID == currentModelID)
        }

        guard let exhaustedProvider else { return candidates }

        // A different provider is the useful escape hatch when this provider's
        // quota is exhausted. Partitioning keeps the server-provided order
        // stable within both groups.
        return candidates.filter { $0.provider != exhaustedProvider }
            + candidates.filter { $0.provider == exhaustedProvider }
    }
}

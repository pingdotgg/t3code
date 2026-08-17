enum FeatureComposerReasoningSummary {
    static func resolve(
        explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider],
        materializesDefaultSelection: Bool
    ) -> String? {
        let providers = ProviderModelCatalogNormalizer.normalized(providers)
        let selection = if materializesDefaultSelection {
            ProviderModelSelectionResolver.validated(explicit, in: providers)
        } else {
            ThreadComposerModelSelectionPolicy.resolvedSelection(
                explicit: explicit,
                inherited: inherited,
                providers: providers
            )
        }
        guard let selection,
              let provider = providers.first(where: { $0.id == selection.providerID }),
              let model = provider.models.first(where: { $0.id == selection.modelID }) else {
            return nil
        }
        return DailyUXModelOptions.reasoningSummary(
            for: model,
            selections: selection.options
        )
    }
}

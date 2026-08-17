/// The composer's reasoning control is described entirely by the selected
/// model's own option descriptor, so the app never assumes which levels a
/// provider exposes. A descriptor the user can choose from becomes an inline
/// selector; anything else keeps the read-only summary the composer showed
/// before, including hiding itself when nothing resolves.
struct FeatureComposerReasoningControl: Equatable {
    let descriptorID: String
    let descriptorLabel: String
    let value: String
    let choices: [FeatureModelOptionChoice]
    let currentChoiceID: String?
    private let resolvedSelection: FeatureSelection

    var isInteractive: Bool { !choices.isEmpty }

    static func resolve(
        explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider],
        materializesDefaultSelection: Bool
    ) -> FeatureComposerReasoningControl? {
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
              let model = provider.models.first(where: { $0.id == selection.modelID }),
              let descriptor = DailyUXModelOptions.reasoningDescriptor(for: model),
              let value = DailyUXModelOptions.reasoningSummary(
                  for: model,
                  selections: selection.options
              ) else {
            return nil
        }
        return FeatureComposerReasoningControl(
            descriptorID: descriptor.id,
            descriptorLabel: descriptor.label,
            value: value,
            choices: descriptor.kind == .select ? descriptor.choices : [],
            currentChoiceID: currentChoiceID(for: descriptor, in: selection.options),
            resolvedSelection: selection
        )
    }

    /// Choosing a level writes the same selection shape the model picker's
    /// configuration screen writes, so the effective level travels through the
    /// existing model-selection path instead of a second client mechanism.
    func selection(choosing choiceID: String) -> FeatureSelection {
        var next = resolvedSelection
        next.options = DailyUXModelOptions.updating(
            next.options,
            id: descriptorID,
            value: .string(choiceID)
        )
        return next
    }

    private static func currentChoiceID(
        for descriptor: FeatureModelOptionDescriptor,
        in selections: [FeatureModelOptionSelection]
    ) -> String? {
        guard case let .string(choiceID) = DailyUXModelOptions.value(
            for: descriptor,
            in: selections
        ), descriptor.choices.contains(where: { $0.id == choiceID }) else {
            return nil
        }
        return choiceID
    }
}

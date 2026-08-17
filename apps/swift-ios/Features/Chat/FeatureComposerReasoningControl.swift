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

    /// The only product rule in an otherwise descriptor-driven control: the two
    /// prompt-tier "ultra" reasoning levels are not offered in the composer.
    /// Everything else — which levels exist, their labels, and their order —
    /// still comes from the model's own descriptor. A level that is excluded
    /// here is still displayed when it is already the effective level, because
    /// the composer must show the truth about the current setting even when it
    /// no longer offers that level.
    static let excludedChoiceIDs: Set<String> = ["ultracode", "ultrathink"]

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
        // The descriptor lists its levels lowest first; that order is preserved
        // and the composer pins it so the menu cannot flip it when it opens
        // upward.
        let choices = descriptor.kind == .select
            ? descriptor.choices.filter { !excludedChoiceIDs.contains($0.id) }
            : []
        return FeatureComposerReasoningControl(
            descriptorID: descriptor.id,
            descriptorLabel: descriptor.label,
            value: value,
            choices: choices,
            currentChoiceID: currentChoiceID(for: descriptor, among: choices, in: selection.options),
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

    /// Only a level the selector actually offers can be marked as current, so a
    /// level chosen elsewhere and excluded here simply leaves nothing checked.
    private static func currentChoiceID(
        for descriptor: FeatureModelOptionDescriptor,
        among choices: [FeatureModelOptionChoice],
        in selections: [FeatureModelOptionSelection]
    ) -> String? {
        guard case let .string(choiceID) = DailyUXModelOptions.value(
            for: descriptor,
            in: selections
        ), choices.contains(where: { $0.id == choiceID }) else {
            return nil
        }
        return choiceID
    }
}

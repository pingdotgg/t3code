/// The composer traits menu is derived from the selected model's option
/// descriptors. It deliberately knows nothing about which providers expose
/// which sections: select descriptors use their advertised choices, boolean
/// descriptors use On/Off, and descriptors without a usable control disappear.
struct FeatureComposerTraitsControl: Equatable {
    struct Choice: Identifiable, Equatable {
        let id: String
        let label: String
        let detail: String?
        let isDefault: Bool
        let value: FeatureModelOptionValue
    }

    struct Section: Identifiable, Equatable {
        let id: String
        let label: String
        let choices: [Choice]
        let currentChoiceID: String
    }

    let sections: [Section]
    let triggerLabel: String
    let showsFastModeIcon: Bool
    private let resolvedSelection: FeatureSelection

    static func resolve(
        explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider],
        materializesDefaultSelection: Bool
    ) -> FeatureComposerTraitsControl? {
        let providers = ProviderModelCatalogNormalizer.normalized(providers)
        let selection = if materializesDefaultSelection {
            ProviderModelSelectionResolver.materialized(explicit, in: providers)
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

        let sections = model.options.compactMap {
            section(for: $0, selections: selection.options)
        }
        guard !sections.isEmpty else { return nil }

        let trigger = triggerDisplay(
            sections: sections,
            descriptors: model.options,
            providerDriver: provider.driver
        )
        return FeatureComposerTraitsControl(
            sections: sections,
            triggerLabel: trigger.label,
            showsFastModeIcon: trigger.showsFastModeIcon,
            resolvedSelection: selection
        )
    }

    /// A traits choice writes through the same selection binding as the model
    /// picker. The effective values of every visible descriptor are materialized
    /// at the same time, matching Electron and preventing neighboring defaults
    /// from disappearing on the next turn.
    func selection(choosing choiceID: String, in descriptorID: String) -> FeatureSelection {
        guard let section = sections.first(where: { $0.id == descriptorID }),
              let choice = section.choices.first(where: { $0.id == choiceID }) else {
            return resolvedSelection
        }

        var next = resolvedSelection
        for section in sections {
            guard let current = section.choices.first(where: {
                $0.id == section.currentChoiceID
            }) else { continue }
            next.options = DailyUXModelOptions.updating(
                next.options,
                id: section.id,
                value: current.value
            )
        }
        next.options = DailyUXModelOptions.updating(
            next.options,
            id: descriptorID,
            value: choice.value
        )
        return next
    }

    private static func section(
        for descriptor: FeatureModelOptionDescriptor,
        selections: [FeatureModelOptionSelection]
    ) -> Section? {
        switch descriptor.kind {
        case .select:
            let supportedChoices = descriptor.choices.filter {
                !(descriptor.promptInjectedValues ?? []).contains($0.id)
            }
            guard !supportedChoices.isEmpty else { return nil }
            return Section(
                id: descriptor.id,
                label: descriptor.label,
                choices: supportedChoices.map {
                    Choice(
                        id: $0.id,
                        label: $0.label,
                        detail: $0.detail,
                        isDefault: $0.isDefault,
                        value: .string($0.id)
                    )
                },
                currentChoiceID: currentSelectChoiceID(
                    for: descriptor,
                    among: supportedChoices,
                    selections: selections
                )
            )
        case .boolean:
            let current = currentBooleanValue(for: descriptor, selections: selections)
            return Section(
                id: descriptor.id,
                label: descriptor.label,
                choices: [
                    Choice(
                        id: "on",
                        label: "On",
                        detail: nil,
                        isDefault: false,
                        value: .boolean(true)
                    ),
                    Choice(
                        id: "off",
                        label: "Off",
                        detail: nil,
                        isDefault: false,
                        value: .boolean(false)
                    ),
                ],
                currentChoiceID: current ? "on" : "off"
            )
        }
    }

    private static func currentSelectChoiceID(
        for descriptor: FeatureModelOptionDescriptor,
        among choices: [FeatureModelOptionChoice],
        selections: [FeatureModelOptionSelection]
    ) -> String {
        if case .string(let selected)? = selections.first(where: {
            $0.id == descriptor.id
        })?.value,
           choices.contains(where: { $0.id == selected })
               || (descriptor.promptInjectedValues ?? []).contains(selected) {
            return selected
        }
        if case .string(let defaultID) = descriptor.defaultValue,
           choices.contains(where: { $0.id == defaultID }) {
            return defaultID
        }
        return choices.first(where: \.isDefault)?.id ?? choices[0].id
    }

    private static func currentBooleanValue(
        for descriptor: FeatureModelOptionDescriptor,
        selections: [FeatureModelOptionSelection]
    ) -> Bool {
        if case .boolean(let selected)? = selections.first(where: {
            $0.id == descriptor.id
        })?.value {
            return selected
        }
        if case .boolean(let defaultValue) = descriptor.defaultValue {
            return defaultValue
        }
        return false
    }

    /// Mirrors Electron's compact TraitsPicker display. Fast mode is a bolt when
    /// another trait supplies readable text; when it is the only trait its state
    /// remains text so the trigger never becomes an unexplained icon.
    private static func triggerDisplay(
        sections: [Section],
        descriptors: [FeatureModelOptionDescriptor],
        providerDriver: String
    ) -> (label: String, showsFastModeIcon: Bool) {
        var fastModeFallbackLabel: String?
        var fastModeEnabled = false
        var labels: [String] = []

        for descriptor in descriptors {
            guard let section = sections.first(where: { $0.id == descriptor.id }) else {
                continue
            }
            let current = section.choices.first(where: {
                $0.id == section.currentChoiceID
            })

            if descriptor.id == "fastMode", descriptor.kind == .boolean {
                fastModeEnabled = current?.value == .boolean(true)
                fastModeFallbackLabel = fastModeEnabled ? "Fast" : "Normal"
                continue
            }

            if providerDriver == "codex",
               descriptor.id == "serviceTier",
               descriptor.kind == .select,
               let fastChoice = section.choices.first(where: { $0.label == "Fast" }),
               section.currentChoiceID == "default"
                   || section.currentChoiceID == fastChoice.id {
                fastModeEnabled = section.currentChoiceID == fastChoice.id
                fastModeFallbackLabel = current?.label
                continue
            }

            switch descriptor.kind {
            case .select:
                let label = current?.label ?? descriptor.choices.first(where: {
                    $0.id == section.currentChoiceID
                })?.label
                if let label {
                    labels.append(label)
                }
            case .boolean:
                guard case .boolean(let value)? = current?.value else { continue }
                labels.append("\(descriptor.label) \(value ? "On" : "Off")")
            }
        }

        if labels.isEmpty, let fastModeFallbackLabel {
            return (fastModeFallbackLabel, false)
        }
        return (labels.joined(separator: " · "), fastModeEnabled)
    }
}

import Foundation

enum ProjectProviderModelPolicy {
    /// Keep catalog metadata so a disabled saved selection still has its name and options.
    static func providers(_ providers: [FeatureProvider], for project: FeatureProject?) -> [FeatureProvider] {
        providers.map { provider in
            var scoped = provider
            let enabled = project?.providerInstanceOverrides?[provider.id] ?? provider.isEnabled ?? true
            scoped.isAvailable = provider.isAvailable && enabled
            return scoped
        }
    }

    static func selectableProviders(_ providers: [FeatureProvider]) -> [FeatureProvider] {
        providers.map { provider in
            var selectable = provider
            let gated = Set((provider.updateRequiredModels ?? []).map(\.slug))
            selectable.models.removeAll { gated.contains($0.id) }
            return selectable
        }
    }

    static func canSelect(_ selection: FeatureSelection?, in providers: [FeatureProvider]) -> Bool {
        guard let selection, let provider = providers.first(where: { $0.id == selection.providerID }) else {
            return false
        }
        return provider.isAvailable
            && provider.updateRequiredModels?.contains(where: { $0.slug == selection.modelID }) != true
            && provider.models.contains(where: { $0.id == selection.modelID })
    }

    static func preservesUnavailableSelection(_ selection: FeatureSelection, in providers: [FeatureProvider]) -> Bool {
        guard let provider = providers.first(where: { $0.id == selection.providerID }) else { return false }
        return !provider.isAvailable
            || provider.updateRequiredModels?.contains(where: { $0.slug == selection.modelID }) == true
    }
}

enum ProviderUpdateRequiredNotice {
    static func models(for provider: FeatureProvider, query: String) -> [ServerProviderUpdateRequiredModel] {
        guard provider.isAvailable else { return [] }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var seen = Set<String>()
        return (provider.updateRequiredModels ?? []).filter {
            seen.insert($0.slug).inserted
                && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
                    || $0.slug.localizedCaseInsensitiveContains(query))
        }
    }

    static func message(driver: String, model: ServerProviderUpdateRequiredModel) -> String {
        let runtime: String
        switch driver {
        case "codex": runtime = "the Codex CLI"
        case "claudeAgent": runtime = "Claude Code"
        default: runtime = ProviderInstanceDisplay.name(instanceID: driver, driver: driver, displayName: nil)
        }
        let version = model.minVersion.hasPrefix("v") ? model.minVersion : "v\(model.minVersion)"
        return "Update \(runtime) to \(version) or newer to use \(model.name)."
    }
}

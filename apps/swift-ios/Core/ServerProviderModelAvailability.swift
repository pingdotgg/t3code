import Foundation

public enum ServerProviderModelSelectionError: LocalizedError, Sendable {
    case unavailable
    case noAvailableModels

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This model is unavailable for this project. Enable its provider, update it, or choose another model."
        case .noAvailableModels: "No models are available for this project. Enable a provider before sending."
        }
    }
}

public enum ServerProviderModelAvailability {
    /// Project IDs here are environment-local wire IDs, never aggregate UI IDs.
    public static func canSelect(
        _ selection: ModelSelection,
        in config: ServerConfigSnapshot,
        projectID: String?
    ) -> Bool {
        guard let provider = config.providers.first(where: { $0.instanceId == selection.instanceId }) else {
            return false
        }
        return canRun(provider, in: config, projectID: projectID)
            && provider.updateRequiredModels?.contains(where: { $0.slug == selection.model }) != true
            && provider.models.contains(where: { $0.slug == selection.model })
    }

    public static func canRun(
        _ provider: ServerProviderSnapshot,
        in config: ServerConfigSnapshot,
        projectID: String?
    ) -> Bool {
        let enabled = config.settings?.providerInstanceEnabled(
            instanceID: provider.instanceId, projectID: projectID
        ) ?? provider.enabled
        return enabled && provider.enabled && provider.installed
            && provider.status != "error" && provider.status != "disabled"
            && provider.auth.status != "unauthenticated"
            && provider.availability != "unavailable"
    }

    public static func disabledProviderIDs(in config: ServerConfigSnapshot, projectID: String?) -> Set<String> {
        Set(config.providers.filter { !canRun($0, in: config, projectID: projectID) }.map(\.instanceId))
    }

    public static func defaultSelection(in config: ServerConfigSnapshot, projectID: String?) -> ModelSelection? {
        let candidates = config.providers.flatMap { provider in
            provider.models.filter { $0.isLegacy != true }.map { (provider, $0) }
        }.filter { provider, model in
            canSelect(.init(instanceId: provider.instanceId, model: model.slug), in: config, projectID: projectID)
        }
        guard let (provider, model) = candidates.first(where: { $0.1.isDefault == true }) ?? candidates.first else {
            return nil
        }
        return ModelSelection(instanceId: provider.instanceId, model: model.slug)
    }
}

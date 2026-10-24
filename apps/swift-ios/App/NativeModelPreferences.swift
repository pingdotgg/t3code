import Foundation

extension NativeFeatureClient: FeatureModelPreferencesClient {
    func modelPreferences(environmentID: String) async throws -> ServerModelPreferencesSnapshot {
        let client = try await environmentServiceClient(environmentID: environmentID)
        guard let preferences = try await client.serverSettings().modelPreferences else {
            throw FeatureCapabilityUnavailable("Model preferences")
        }
        return preferences
    }

    func updateModelPreferences(
        environmentID: String,
        change: ServerModelPreferencesChange
    ) async throws -> ServerModelPreferencesSnapshot {
        let client = try await environmentServiceClient(environmentID: environmentID)
        try await requireScope("settings:write", client: client)
        guard try await client.serverSettings().modelPreferences != nil else {
            throw FeatureCapabilityUnavailable("Model preferences")
        }
        // Model preferences belong to this environment. The general settings
        // updater also copies shared preferences to other environments.
        let settings = try await saveServerPreferences(
            client: client, environmentID: environmentID, change: .sharedPreferences(change.jsonValue)
        )
        guard let preferences = settings.modelPreferences else {
            throw FeatureCapabilityUnavailable("Model preferences")
        }
        return preferences
    }
}

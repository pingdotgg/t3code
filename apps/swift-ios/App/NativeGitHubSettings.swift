import Foundation

extension NativeFeatureClient {
    func updateGitHubSettings(
        environmentID: String,
        change: FeatureGitHubSettingsChange
    ) async throws {
        let client = try await projectCreationClient(environmentID: environmentID)
        try await requireScope("settings:write", client: client)
        guard let current = try await client.serverSettings().github else {
            throw FeatureCapabilityUnavailable("GitHub settings")
        }
        let patch = try change.patch(current: current)
        // Credentials belong to this environment. Never fan out this patch.
        _ = try await saveServerPreferences(
            client: client, environmentID: environmentID,
            change: .sharedPreferences(patch)
        )
        // Server invalidation refreshes subscribed PR reads with the new credential.
        try? await client.invalidatePullRequests()
    }
}

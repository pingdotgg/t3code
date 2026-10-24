import Foundation

extension NativeFeatureClient: FeatureCloudPreferencesManaging {
    func cloudLinkState(environmentID: String) async throws -> EnvironmentCloudLinkState {
        let client = try await environmentServiceClient(environmentID: environmentID)
        return try await client.cloudLinkState()
    }

    func setHoldWebhooksWhileOffline(environmentID: String, enabled: Bool) async throws -> EnvironmentCloudLinkState {
        let client = try await environmentServiceClient(environmentID: environmentID)
        try await requireScope("relay:write", client: client)
        return try await client.setHoldWebhooksWhileOffline(enabled)
    }
}

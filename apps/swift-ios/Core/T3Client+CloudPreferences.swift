import Foundation

extension T3Client {
    public func cloudLinkState() async throws -> EnvironmentCloudLinkState {
        try await api.cloudLinkState(for: environment)
    }

    public func setHoldWebhooksWhileOffline(_ enabled: Bool) async throws -> EnvironmentCloudLinkState {
        // Read at execution so changing webhook delivery preserves the current activity preference.
        let current = try await api.cloudLinkState(for: environment)
        guard current.holdWebhooksWhileOffline != nil else {
            throw EnvironmentCloudPreferencesError.unsupported
        }
        return try await api.updateCloudPreferences(.init(
            publishAgentActivity: current.publishAgentActivity, holdWebhooksWhileOffline: enabled
        ), environment: environment)
    }
}

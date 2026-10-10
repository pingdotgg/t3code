import Foundation

extension EnvironmentAPI {
    public func cloudLinkState(for environment: Environment) async throws -> EnvironmentCloudLinkState {
        try await authorized(environment: environment, path: "/api/connect/link-state", method: "GET",
                             as: EnvironmentCloudLinkState.self)
    }

    public func updateCloudPreferences(_ preferences: EnvironmentCloudPreferences,
                                       environment: Environment) async throws -> EnvironmentCloudLinkState {
        try await authorized(environment: environment, path: "/api/connect/preferences", method: "POST",
                             body: JSONEncoder.t3.encode(preferences), as: EnvironmentCloudLinkState.self)
    }
}

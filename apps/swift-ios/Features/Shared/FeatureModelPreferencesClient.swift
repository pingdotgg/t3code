import Foundation

@MainActor
public protocol FeatureModelPreferencesClient {
    func modelPreferences(environmentID: String) async throws -> ServerModelPreferencesSnapshot
    func updateModelPreferences(
        environmentID: String,
        change: ServerModelPreferencesChange
    ) async throws -> ServerModelPreferencesSnapshot
}

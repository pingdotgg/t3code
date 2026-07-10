// server.* mutation RPCs (rpc.ts §3.2): provider refresh/update and the
// settings get/patch pair. Read-side models live in ServerModels.swift.

import Foundation

/// `server.refreshProviders` / `server.updateProvider` success payload:
/// the full post-action provider list.
public struct ServerProviderUpdatedPayload: Decodable, Sendable {
    public var providers: [ServerProvider]
}

struct ServerRefreshProvidersInput: Encodable, Sendable {
    var instanceId: String?
}

struct ServerUpdateProviderInput: Encodable, Sendable {
    var provider: String
    var instanceId: String?
}

struct ServerUpdateSettingsInput: Encodable, Sendable {
    var patch: ServerSettingsPatch
}

/// `ServerSettingsPatch` (settings.ts) — every key optionalKey; absent keys
/// leave the setting untouched. Only the fields the mac client edits are
/// modeled; the server merges partial patches.
public struct ServerSettingsPatch: Encodable, Sendable {
    public var enableAssistantStreaming: Bool?
    public var enableProviderUpdateChecks: Bool?
    public var defaultThreadEnvMode: ThreadEnvMode?
    public var newWorktreesStartFromOrigin: Bool?
    public var addProjectBaseDirectory: String?

    public init(
        enableAssistantStreaming: Bool? = nil, enableProviderUpdateChecks: Bool? = nil,
        defaultThreadEnvMode: ThreadEnvMode? = nil, newWorktreesStartFromOrigin: Bool? = nil,
        addProjectBaseDirectory: String? = nil
    ) {
        self.enableAssistantStreaming = enableAssistantStreaming
        self.enableProviderUpdateChecks = enableProviderUpdateChecks
        self.defaultThreadEnvMode = defaultThreadEnvMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
        self.addProjectBaseDirectory = addProjectBaseDirectory
    }

    private enum CodingKeys: String, CodingKey {
        case enableAssistantStreaming, enableProviderUpdateChecks, defaultThreadEnvMode,
            newWorktreesStartFromOrigin, addProjectBaseDirectory
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(enableAssistantStreaming, forKey: .enableAssistantStreaming)
        try c.encodeIfPresent(enableProviderUpdateChecks, forKey: .enableProviderUpdateChecks)
        try c.encodeIfPresent(defaultThreadEnvMode, forKey: .defaultThreadEnvMode)
        try c.encodeIfPresent(newWorktreesStartFromOrigin, forKey: .newWorktreesStartFromOrigin)
        try c.encodeIfPresent(addProjectBaseDirectory, forKey: .addProjectBaseDirectory)
    }
}

extension T3Client {
    /// Re-probe installed provider CLIs; pass `instanceId` to target one.
    @discardableResult
    public func refreshProviders(instanceId: String? = nil) async throws
        -> ServerProviderUpdatedPayload
    {
        try await call(
            "server.refreshProviders", ServerRefreshProvidersInput(instanceId: instanceId))
    }

    /// Run the provider CLI's own update command (e.g. `npm i -g`).
    @discardableResult
    public func updateProviderCLI(driver: String, instanceId: String? = nil) async throws
        -> ServerProviderUpdatedPayload
    {
        try await call(
            "server.updateProvider",
            ServerUpdateProviderInput(provider: driver, instanceId: instanceId))
    }

    public func getSettings() async throws -> ServerSettings {
        try await call("server.getSettings", EmptyPayload())
    }

    /// Applies a partial settings patch; returns the merged settings.
    @discardableResult
    public func updateSettings(patch: ServerSettingsPatch) async throws -> ServerSettings {
        try await call("server.updateSettings", ServerUpdateSettingsInput(patch: patch))
    }

    /// AI-curated scenery set for a user-typed location (`server.generateScenerySet`).
    public func generateScenerySet(location: String) async throws -> GeneratedScenerySet {
        try await call(
            "server.generateScenerySet", GenerateScenerySetInput(location: location))
    }
}

/// `server.generateScenerySet` payload.
struct GenerateScenerySetInput: Encodable, Sendable {
    var location: String
}

/// Optional tags on an Unsplash query produced by text generation.
public enum GeneratedSceneryTimeOfDay: String, Codable, Sendable, Hashable {
    case dawn, day, dusk, night
}

public enum GeneratedScenerySeason: String, Codable, Sendable, Hashable {
    case spring, summer, autumn, winter
}

public struct GeneratedSceneryQuery: Codable, Sendable, Hashable {
    public var text: String
    public var timeOfDay: GeneratedSceneryTimeOfDay?
    public var season: GeneratedScenerySeason?

    public init(
        text: String,
        timeOfDay: GeneratedSceneryTimeOfDay? = nil,
        season: GeneratedScenerySeason? = nil
    ) {
        self.text = text
        self.timeOfDay = timeOfDay
        self.season = season
    }
}

/// One iconic place with a place-specific Unsplash search query.
public struct GeneratedSceneryLocation: Codable, Sendable, Hashable {
    public var name: String
    public var query: String
    public var timeOfDay: GeneratedSceneryTimeOfDay?
    public var season: GeneratedScenerySeason?

    public init(
        name: String,
        query: String,
        timeOfDay: GeneratedSceneryTimeOfDay? = nil,
        season: GeneratedScenerySeason? = nil
    ) {
        self.name = name
        self.query = query
        self.timeOfDay = timeOfDay
        self.season = season
    }
}

/// Success payload for `server.generateScenerySet`.
public struct GeneratedScenerySet: Codable, Sendable, Hashable {
    public var sceneNames: [String]
    public var queries: [GeneratedSceneryQuery]
    /// Per-location fetch targets. Nil/empty → legacy query-pool path.
    public var locations: [GeneratedSceneryLocation]?

    public init(
        sceneNames: [String],
        queries: [GeneratedSceneryQuery],
        locations: [GeneratedSceneryLocation]? = nil
    ) {
        self.sceneNames = sceneNames
        self.queries = queries
        self.locations = locations
    }
}

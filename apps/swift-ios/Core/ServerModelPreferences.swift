import Foundation

public struct ServerModelFavorite: Codable, Hashable, Sendable {
    public let provider: String
    public let model: String

    public init(provider: String, model: String) {
        self.provider = provider
        self.model = model
    }

    public var pickerID: String { "\(provider)::\(model)" }
}

public struct ServerProviderModelPreferences: Codable, Equatable, Sendable {
    public var hiddenModels: [String]
    public var modelOrder: [String]

    public init(hiddenModels: [String] = [], modelOrder: [String] = []) {
        self.hiddenModels = hiddenModels
        self.modelOrder = modelOrder
    }

    private enum CodingKeys: String, CodingKey { case hiddenModels, modelOrder }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hiddenModels = try container.decodeIfPresent([String].self, forKey: .hiddenModels) ?? []
        modelOrder = try container.decodeIfPresent([String].self, forKey: .modelOrder) ?? []
    }
}

public struct ServerModelPreferencesSnapshot: Codable, Equatable, Sendable {
    /// Nil permits legacy migration. An empty collection is authoritative.
    public var favorites: [ServerModelFavorite]?
    public var providerModelPreferences: [String: ServerProviderModelPreferences]?

    private enum CodingKeys: String, CodingKey { case favorites, providerModelPreferences }

    public init(
        favorites: [ServerModelFavorite]? = nil,
        providerModelPreferences: [String: ServerProviderModelPreferences]? = nil
    ) {
        self.favorites = favorites
        self.providerModelPreferences = providerModelPreferences
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(favorites, forKey: .favorites)
        try container.encode(providerModelPreferences, forKey: .providerModelPreferences)
    }

    public func favoriteIDs(legacyStorage: String) -> Set<String> {
        Set((favorites ?? Self.legacyFavorites(legacyStorage)).map(\.pickerID))
    }

    public func migrationChange(legacyStorage: String) -> ServerModelPreferencesChange? {
        let legacy = Self.legacyFavorites(legacyStorage)
        guard favorites == nil, !legacy.isEmpty else { return nil }
        return .migrateFavorites(legacy)
    }

    public static func legacyFavorites(_ storage: String) -> [ServerModelFavorite] {
        var seen = Set<ServerModelFavorite>()
        return storage.split(separator: "\n").compactMap { line in
            guard let separator = line.range(of: "::") else { return nil }
            let provider = String(line[..<separator.lowerBound])
            let model = String(line[separator.upperBound...])
            guard !provider.isEmpty, !model.isEmpty else { return nil }
            let favorite = ServerModelFavorite(provider: provider, model: model)
            return seen.insert(favorite).inserted ? favorite : nil
        }
    }
}

public enum ServerModelPreferencesChange: Equatable, Sendable {
    case migrateFavorites([ServerModelFavorite])
    case favorite(ServerModelFavorite, enabled: Bool, legacyFavorites: [ServerModelFavorite])
    case hidden(ServerModelFavorite, hidden: Bool)

    public var jsonValue: JSONValue {
        switch self {
        case let .migrateFavorites(favorites):
            .object(["migrateModelPreferences": .object(["favorites": Self.favoritesJSON(favorites)])])
        case let .favorite(favorite, enabled, legacyFavorites):
            .object([
                "setModelFavorites": .array([.object([
                    "provider": .string(favorite.provider), "model": .string(favorite.model), "favorite": .bool(enabled),
                ])]),
                "migrateModelPreferences": .object(["favorites": Self.favoritesJSON(legacyFavorites)]),
            ])
        case let .hidden(favorite, hidden):
            .object(["setModelsHidden": .array([.object([
                "provider": .string(favorite.provider), "model": .string(favorite.model), "hidden": .bool(hidden),
            ])])])
        }
    }

    private static func favoritesJSON(_ favorites: [ServerModelFavorite]) -> JSONValue {
        .array(favorites.map { .object(["provider": .string($0.provider), "model": .string($0.model)]) })
    }
}

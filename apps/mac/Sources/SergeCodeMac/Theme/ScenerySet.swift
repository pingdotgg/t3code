import Foundation

/// Local time-of-day bucket for a scenery search query (Phase 4 rotation).
public enum SceneryTimeOfDay: String, Codable, Hashable, Sendable {
    case dawn, day, dusk, night
}

/// Season tag for a scenery search query (Phase 4 rotation).
public enum ScenerySeason: String, Codable, Hashable, Sendable {
    case spring, summer, autumn, winter
}

/// Whether a set ships with the app or was created by the user.
public enum ScenerySetOrigin: String, Codable, Hashable, Sendable {
    case builtin, custom
}

/// One Unsplash search used to build a set's photo pool.
public struct SceneryQuery: Codable, Hashable, Sendable {
    public var text: String
    public var timeOfDay: SceneryTimeOfDay?
    public var season: ScenerySeason?
    /// How many results to pull for this query when refreshing the pool.
    public var take: Int

    public init(
        text: String,
        timeOfDay: SceneryTimeOfDay? = nil,
        season: ScenerySeason? = nil,
        take: Int = 8
    ) {
        self.text = text
        self.timeOfDay = timeOfDay
        self.season = season
        self.take = take
    }

    private enum CodingKeys: String, CodingKey {
        case text, timeOfDay, season, take
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        timeOfDay = try container.decodeIfPresent(SceneryTimeOfDay.self, forKey: .timeOfDay)
        season = try container.decodeIfPresent(ScenerySeason.self, forKey: .season)
        take = try container.decodeIfPresent(Int.self, forKey: .take) ?? 8
    }
}

/// Adaptive color palette derived from a set's photos (Phase 3). Present in
/// the manifest schema so later phases can fill it without another migration.
public struct SceneryPalette: Codable, Hashable, Sendable {
    public var accentHex: String?
    /// Duotone pairs as `#RRGGBB` strings: (dark base, lighter wash).
    public var washes: [[String]]?

    public init(accentHex: String? = nil, washes: [[String]]? = nil) {
        self.accentHex = accentHex
        self.washes = washes
    }
}

/// A curated location photo set: manifest + on-disk pool under `sets/<id>/`.
public struct ScenerySet: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var origin: ScenerySetOrigin
    public var createdAt: Date
    public var queries: [SceneryQuery]
    public var sceneNames: [String]
    public var palette: SceneryPalette?

    public init(
        id: String,
        title: String,
        origin: ScenerySetOrigin,
        createdAt: Date,
        queries: [SceneryQuery],
        sceneNames: [String],
        palette: SceneryPalette? = nil
    ) {
        self.id = id
        self.title = title
        self.origin = origin
        self.createdAt = createdAt
        self.queries = queries
        self.sceneNames = sceneNames
        self.palette = palette
    }

    public static let dolomitesID = "dolomites"

    /// Builtin Dolomites set — queries and names match the pre-multi-set pool.
    public static func makeBuiltinDolomites() -> ScenerySet {
        ScenerySet(
            id: dolomitesID,
            title: "Dolomites",
            origin: .builtin,
            // Stable epoch so synthesized manifests don't churn on every launch.
            createdAt: Date(timeIntervalSince1970: 0),
            queries: [
                SceneryQuery(text: "dolomites italy mountains", take: 12),
                SceneryQuery(text: "alpine meadow dolomites", take: 8),
                SceneryQuery(text: "italian alps grass field", take: 6),
            ],
            sceneNames: [
                "Tre Cime", "Seceda", "Alpe di Siusi", "Lago di Braies", "Marmolada",
                "Sassolungo", "Cadini di Misurina", "Passo Giau", "Cinque Torri",
                "Val Gardena", "Croda da Lago", "Odle Ridge", "Fanes Meadow",
                "Puez Alm", "Sciliar", "Latemar", "Catinaccio", "Passo Pordoi",
                "Sella Towers", "Passo Falzarego", "Val di Funes", "Monte Paterno",
                "Croda Rossa", "Piz Boè", "Sass de Putia", "Vajolet Towers",
                "Passo Rolle", "Pale di San Martino", "Brenta Ridge", "Piz Duleda",
            ],
            palette: nil)
    }
}

/// Global scenery settings (`scenery/settings.json`).
public struct ScenerySettingsFile: Codable, Hashable, Sendable {
    public var defaultSetId: String

    public init(defaultSetId: String = ScenerySet.dolomitesID) {
        self.defaultSetId = defaultSetId
    }
}

/// Per-project scenery preferences (`scenery/project-prefs.json` values).
/// `accentHex` / `sfSymbol` are reserved for later phases.
public struct ProjectSceneryPrefs: Codable, Hashable, Sendable {
    public var setId: String?
    public var accentHex: String?
    public var sfSymbol: String?

    public init(setId: String? = nil, accentHex: String? = nil, sfSymbol: String? = nil) {
        self.setId = setId
        self.accentHex = accentHex
        self.sfSymbol = sfSymbol
    }
}

/// Thread → photo assignment record. Legacy assignments were bare photo-id
/// strings; the multi-set format is an object with optional `setId`
/// (absent = dolomites).
public struct SceneryAssignment: Codable, Hashable, Sendable {
    public var photoID: String
    public var setId: String?

    public init(photoID: String, setId: String? = nil) {
        self.photoID = photoID
        self.setId = setId
    }

    public init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(),
            let photoID = try? single.decode(String.self)
        {
            self.photoID = photoID
            self.setId = nil
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let photoID = try container.decodeIfPresent(String.self, forKey: .photoID) {
            self.photoID = photoID
        } else if let photoID = try container.decodeIfPresent(String.self, forKey: .photoId) {
            // Tolerate camelCase variant if written by another client.
            self.photoID = photoID
        } else {
            throw DecodingError.keyNotFound(
                CodingKeys.photoID,
                .init(codingPath: container.codingPath, debugDescription: "photoID required"))
        }
        self.setId = try container.decodeIfPresent(String.self, forKey: .setId)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(photoID, forKey: .photoID)
        try container.encodeIfPresent(setId, forKey: .setId)
    }

    private enum CodingKeys: String, CodingKey {
        case photoID
        case photoId
        case setId
    }

    /// Effective set for this assignment (legacy records without setId → dolomites).
    public var resolvedSetId: String {
        setId ?? ScenerySet.dolomitesID
    }
}

// MARK: - Set resolution (pure)

/// Resolves which scenery set applies for a project path.
/// Precedence: project-prefs setId → defaultSetId → dolomites.
public enum ScenerySetResolution {
    public static func resolveSetId(
        projectPath: String?,
        projectPrefs: [String: ProjectSceneryPrefs],
        defaultSetId: String,
        knownSetIds: Set<String>
    ) -> String {
        if let projectPath,
            let preferred = projectPrefs[projectPath]?.setId,
            !preferred.isEmpty,
            knownSetIds.contains(preferred)
        {
            return preferred
        }
        if !defaultSetId.isEmpty, knownSetIds.contains(defaultSetId) {
            return defaultSetId
        }
        if knownSetIds.contains(ScenerySet.dolomitesID) {
            return ScenerySet.dolomitesID
        }
        // Last resort even if the registry is empty mid-boot.
        return ScenerySet.dolomitesID
    }
}

// MARK: - On-disk migration

/// Moves legacy flat `scenery/` layout into `scenery/sets/dolomites/`.
/// Idempotent: safe to call on every launch.
public enum SceneryLayoutMigration {
    public static let legacyFileNames = [
        "pool.json", "names.json", "registered-downloads.json",
    ]

    /// Runs migration against a scenery root directory. Returns true when any
    /// file move or manifest synthesis occurred.
    @discardableResult
    public static func migrateIfNeeded(root: URL, fileManager fm: FileManager = .default) throws
        -> Bool
    {
        var didChange = false
        let setsDir = root.appendingPathComponent("sets", isDirectory: true)
        let dolomitesDir = setsDir.appendingPathComponent(ScenerySet.dolomitesID, isDirectory: true)

        try fm.createDirectory(at: dolomitesDir, withIntermediateDirectories: true)

        for name in legacyFileNames {
            let src = root.appendingPathComponent(name)
            let dst = dolomitesDir.appendingPathComponent(name)
            guard fm.fileExists(atPath: src.path) else { continue }
            if fm.fileExists(atPath: dst.path) {
                try fm.removeItem(at: src)
            } else {
                try fm.moveItem(at: src, to: dst)
            }
            didChange = true
        }

        let legacyImages = root.appendingPathComponent("images", isDirectory: true)
        let destImages = dolomitesDir.appendingPathComponent("images", isDirectory: true)
        if fm.fileExists(atPath: legacyImages.path) {
            if !fm.fileExists(atPath: destImages.path) {
                try fm.moveItem(at: legacyImages, to: destImages)
                didChange = true
            } else {
                // Both exist (partial prior run): merge then drop legacy.
                let contents = (try? fm.contentsOfDirectory(
                    at: legacyImages, includingPropertiesForKeys: nil)) ?? []
                for file in contents {
                    let dest = destImages.appendingPathComponent(file.lastPathComponent)
                    if !fm.fileExists(atPath: dest.path) {
                        try fm.moveItem(at: file, to: dest)
                        didChange = true
                    }
                }
                try? fm.removeItem(at: legacyImages)
                didChange = true
            }
        }
        try fm.createDirectory(at: destImages, withIntermediateDirectories: true)

        let manifestURL = dolomitesDir.appendingPathComponent("manifest.json")
        if !fm.fileExists(atPath: manifestURL.path) {
            let manifest = ScenerySet.makeBuiltinDolomites()
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(manifest)
            try data.write(to: manifestURL, options: .atomic)
            didChange = true
        }

        return didChange
    }
}

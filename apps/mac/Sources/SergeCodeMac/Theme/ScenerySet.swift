import Foundation

/// Local time-of-day bucket for a scenery search query (Phase 4 rotation).
public enum SceneryTimeOfDay: String, Codable, Hashable, Sendable {
    case dawn, day, dusk, night
}

/// Season tag for a scenery search query (Phase 4 rotation).
public enum ScenerySeason: String, Codable, Hashable, Sendable {
    case spring, summer, autumn, winter
}

/// The query tags that caused a photo to enter a set's pool. Persisted in
/// `photo-tags.json`, separate from the mobile-shared `pool.json` schema.
public struct SceneryPhotoTags: Codable, Hashable, Sendable {
    public var timeOfDay: SceneryTimeOfDay?
    public var season: ScenerySeason?

    public init(timeOfDay: SceneryTimeOfDay? = nil, season: ScenerySeason? = nil) {
        self.timeOfDay = timeOfDay
        self.season = season
    }

    init?(query: SceneryQuery) {
        guard query.timeOfDay != nil || query.season != nil else { return nil }
        self.init(timeOfDay: query.timeOfDay, season: query.season)
    }

    var isUntagged: Bool {
        timeOfDay == nil && season == nil
    }

    func matches(_ bucket: SceneryBucket) -> Bool {
        guard !isUntagged else { return false }
        if let timeOfDay, timeOfDay != bucket.timeOfDay { return false }
        if let season, season != bucket.season { return false }
        return true
    }
}

/// Clock-based local scenery bucket. Seasons use the northern hemisphere's
/// meteorological month groupings.
public struct SceneryBucket: Equatable, Hashable, Sendable {
    public var timeOfDay: SceneryTimeOfDay
    public var season: ScenerySeason

    public init(timeOfDay: SceneryTimeOfDay, season: ScenerySeason) {
        self.timeOfDay = timeOfDay
        self.season = season
    }

    /// Pure and unit-testable: callers inject both the instant and calendar.
    public static func compute(for date: Date, calendar: Calendar) -> SceneryBucket {
        let components = calendar.dateComponents([.hour, .minute, .month], from: date)
        let minuteOfDay = (components.hour ?? 0) * 60 + (components.minute ?? 0)
        let timeOfDay: SceneryTimeOfDay
        switch minuteOfDay {
        case (5 * 60 + 30)..<(8 * 60):
            timeOfDay = .dawn
        case (8 * 60)..<(17 * 60):
            timeOfDay = .day
        case (17 * 60)..<(20 * 60 + 30):
            timeOfDay = .dusk
        default:
            timeOfDay = .night
        }

        let season: ScenerySeason
        switch components.month ?? 1 {
        case 3...5:
            season = .spring
        case 6...8:
            season = .summer
        case 9...11:
            season = .autumn
        default:
            season = .winter
        }
        return SceneryBucket(timeOfDay: timeOfDay, season: season)
    }
}

enum SceneryPhotoSelection {
    /// Preference order: matching tagged photos, untagged photos, then the
    /// complete pool when neither preferred subset has any candidates.
    static func preferredCandidates(
        photos: [SceneryPhoto],
        tagsByPhotoID: [String: SceneryPhotoTags],
        bucket: SceneryBucket
    ) -> [SceneryPhoto] {
        let matching = photos.filter { tagsByPhotoID[$0.id]?.matches(bucket) == true }
        if !matching.isEmpty { return matching }

        let untagged = photos.filter {
            guard let tags = tagsByPhotoID[$0.id] else { return true }
            return tags.isUntagged
        }
        return untagged.isEmpty ? photos : untagged
    }

    static func select(
        photos: [SceneryPhoto],
        tagsByPhotoID: [String: SceneryPhotoTags],
        bucket: SceneryBucket,
        seed: String
    ) -> SceneryPhoto? {
        let candidates = preferredCandidates(
            photos: photos,
            tagsByPhotoID: tagsByPhotoID,
            bucket: bucket)
        guard !candidates.isEmpty else { return nil }
        return candidates[AlpineTheme.stableIndex(seed, candidates.count)]
    }
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
    /// Opacity of the scenery photo layer over the window material.
    /// `1.0` = fully solid (historical look); lower values let the
    /// behind-window glass base show through. Clamped to `translucencyRange`.
    public var sceneryTranslucency: Double

    public static let defaultTranslucency: Double = 0.85
    public static let translucencyRange: ClosedRange<Double> = 0.5...1.0

    public init(
        defaultSetId: String = ScenerySet.dolomitesID,
        sceneryTranslucency: Double = Self.defaultTranslucency
    ) {
        self.defaultSetId = defaultSetId
        self.sceneryTranslucency = Self.clampTranslucency(sceneryTranslucency)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        defaultSetId =
            try container.decodeIfPresent(String.self, forKey: .defaultSetId)
            ?? ScenerySet.dolomitesID
        let raw =
            try container.decodeIfPresent(Double.self, forKey: .sceneryTranslucency)
            ?? Self.defaultTranslucency
        sceneryTranslucency = Self.clampTranslucency(raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(defaultSetId, forKey: .defaultSetId)
        try container.encode(sceneryTranslucency, forKey: .sceneryTranslucency)
    }

    private enum CodingKeys: String, CodingKey {
        case defaultSetId
        case sceneryTranslucency
    }

    /// Clamps a raw translucency to the supported range.
    public static func clampTranslucency(_ value: Double) -> Double {
        min(max(value, translucencyRange.lowerBound), translucencyRange.upperBound)
    }

    /// Legibility-wash multiplier for a given translucency.
    /// At `1.0` the factor is `1.0` (pixel-identical wash); at `0.5` it stays
    /// high enough that `.primary` text remains readable over a bright desktop.
    public static func washScale(forTranslucency value: Double) -> Double {
        let t = clampTranslucency(value)
        return 0.7 + 0.3 * t
    }
}

/// Per-project scenery preferences (`scenery/project-prefs.json` values).
/// `accentHex` / `sfSymbol` drive the optional project badges in app chrome.
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

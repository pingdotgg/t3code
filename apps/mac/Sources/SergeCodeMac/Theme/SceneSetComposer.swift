import Foundation
import Observation
import T3Kit

/// Async pipeline that turns a user-typed location into a registered custom
/// `ScenerySet` (AI names/queries → Unsplash pool → disk registry).
///
/// Phase 5 Settings UI binds to `state` / `createSet` / `cancel`. This type is
/// the observable machinery only — no UI.
@MainActor
@Observable
public final class SceneSetComposer {
    public enum State: Equatable, Sendable {
        case idle
        case generatingNames
        case fetchingPhotos(completed: Int, total: Int)
        case finished(setId: String)
        case failed(SceneSetComposerError)
    }

    public enum SceneSetComposerError: Error, Equatable, LocalizedError, Sendable {
        case invalidLocation
        case missingUnsplashKey
        case backendFailure(String)
        case noPhotosFound
        case cancelled

        public var errorDescription: String? {
            switch self {
            case .invalidLocation:
                return "Enter a location name to create a scenery set."
            case .missingUnsplashKey:
                return
                    "Unsplash access key is missing. Set SERGECODE_UNSPLASH_KEY or add ~/Library/Application Support/SergeCode/unsplash-access-key."
            case .backendFailure(let detail):
                return detail.isEmpty
                    ? "Could not generate scenery names. Check that a coding provider is available."
                    : detail
            case .noPhotosFound:
                return "No landscape photos were found for that location. Try a different place name."
            case .cancelled:
                return "Scenery set creation was cancelled."
            }
        }
    }

    public private(set) var state: State = .idle

    private let store: SceneryStore
    private let backend: any BackendService
    private let client: UnsplashClient?
    /// Accessed from MainActor methods and from `deinit` (cancel only).
    /// `Task.cancel()` is thread-safe; only the create/cancel writers mutate.
    @ObservationIgnored
    nonisolated(unsafe) private var workTask: Task<Void, Never>?

    public init(
        store: SceneryStore,
        backend: any BackendService,
        client: UnsplashClient? = UnsplashClient()
    ) {
        self.store = store
        self.backend = backend
        self.client = client
    }

    deinit {
        // Task.cancel is thread-safe. State is not updated here (deinit is
        // nonisolated); SettingsScene also cancels on disappear so in-flight
        // create runs are stopped when the window goes away even while
        // `runCreate` still holds self for the active method frame.
        workTask?.cancel()
    }

    /// Start creating a custom set for `location`. Cancels any in-flight run.
    ///
    /// When `replacingSetId` is set, the new pool is registered under that id
    /// (in-place regenerate) instead of a fresh slug derived from the title.
    public func createSet(location: String, replacingSetId: String? = nil) {
        cancel()
        let trimmed = location.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            state = .failed(.invalidLocation)
            return
        }
        guard client != nil else {
            state = .failed(.missingUnsplashKey)
            return
        }
        if let replacingSetId {
            guard let existing = store.set(id: replacingSetId), existing.origin == .custom else {
                state = .failed(.backendFailure("That scenery set cannot be regenerated."))
                return
            }
        }

        workTask = Task { [weak self] in
            await self?.runCreate(location: trimmed, replacingSetId: replacingSetId)
        }
    }

    public func cancel() {
        workTask?.cancel()
        workTask = nil
        if case .generatingNames = state {
            state = .failed(.cancelled)
        } else if case .fetchingPhotos = state {
            state = .failed(.cancelled)
        }
    }

    /// Resets to idle after a finished/failed run (UI dismiss).
    public func reset() {
        cancel()
        state = .idle
    }

    // MARK: - Pipeline

    private func runCreate(location: String, replacingSetId: String?) async {
        state = .generatingNames

        let generated: GeneratedScenerySet
        do {
            let fromBackend = try await backend.generateScenerySet(location: location)
            try Task.checkCancellation()
            generated = fromBackend
        } catch is CancellationError {
            state = .failed(.cancelled)
            return
        } catch {
            // Fallback: templated queries + metadata-derived names after fetch.
            generated = ScenerySetFallback.templatedGeneration(location: location)
        }

        let queries = Self.makeStoreQueries(from: generated.queries, location: location)
        guard !queries.isEmpty else {
            state = .failed(.backendFailure("No search queries were produced for that location."))
            return
        }

        // Prefer explicit replace id so title edits / random slug suffixes do
        // not orphan the existing set on regenerate.
        let setId = replacingSetId ?? ScenerySetSlug.make(from: location)
        let title = location
        /// Set only after `registerSet` succeeds for this run — used to roll
        /// back if cancel lands during palette extraction. Never roll back a
        /// regenerate (would wipe the set the user already had).
        var registeredSetId: String?
        let isReplace = replacingSetId != nil

        do {
            let generatedLocations = generated.locations ?? []
            let persistedLocations = Self.makeStoreLocations(from: generatedLocations)
            let poolResult: PoolBuildResult
            if !persistedLocations.isEmpty {
                poolResult = try await fetchPoolFromLocations(
                    locations: persistedLocations,
                    queries: queries,
                    location: location)
            } else {
                // No usable locations (legacy server, sanitization drop, or
                // templated backend fallback). Prefer AI sceneNames when present;
                // otherwise bare set title — never "Iceland 1"…"Iceland N".
                poolResult = try await fetchPoolLegacy(
                    queries: queries,
                    location: location,
                    curatedNames: generated.sceneNames)
            }
            try Task.checkCancellation()

            let set = ScenerySet(
                id: setId,
                title: title,
                origin: .custom,
                createdAt: Date(),
                queries: queries,
                sceneNames: poolResult.sceneNames,
                locations: persistedLocations.isEmpty ? nil : persistedLocations,
                palette: nil)

            store.registerSet(
                set,
                pool: poolResult.photos,
                photoTags: poolResult.photoTags,
                replacePoolResidue: true)
            if !isReplace {
                registeredSetId = setId
            }
            await store.generatePaletteIfNeeded(for: setId, downloadSamples: true)
            try Task.checkCancellation()
            state = .finished(setId: setId)
        } catch is CancellationError {
            // Choice: roll back (not treat-as-success). Cancel after register
            // must not leave a *new* set on disk while state is .failed(.cancelled).
            // Regenerates keep the last registered pool (do not delete).
            if let registeredSetId {
                try? store.deleteCustomSet(id: registeredSetId)
            }
            state = .failed(.cancelled)
        } catch let err as SceneSetComposerError {
            state = .failed(err)
        } catch {
            state = .failed(.backendFailure(error.localizedDescription))
        }
    }

    // MARK: - Per-location fetch (preferred)

    private struct PoolBuildResult {
        var photos: [SceneryPhoto]
        var sceneNames: [String]
        var photoTags: [String: SceneryPhotoTags]
    }

    /// Fetch 1 deduped photo per named location (query targets that place),
    /// then top up from general queries when needed. Shared implementation
    /// lives in `SceneryPoolBuilder` (also used by store refresh).
    private func fetchPoolFromLocations(
        locations: [SceneryLocation],
        queries: [SceneryQuery],
        location: String
    ) async throws -> PoolBuildResult {
        guard let client else { throw SceneSetComposerError.missingUnsplashKey }

        let totalSteps = max(locations.count + queries.count, 1)
        state = .fetchingPhotos(completed: 0, total: totalSteps)

        do {
            let built = try await SceneryPoolBuilder.buildFromLocations(
                client: client,
                locations: locations,
                queries: queries,
                setTitle: location,
                onProgress: { [weak self] completed, total in
                    await MainActor.run {
                        self?.state = .fetchingPhotos(completed: completed, total: total)
                    }
                })
            return PoolBuildResult(
                photos: built.photos,
                sceneNames: built.sceneNames,
                photoTags: built.photoTags)
        } catch is CancellationError {
            throw CancellationError()
        } catch SceneryPoolBuilder.BuildError.noPhotosFound {
            throw SceneSetComposerError.noPhotosFound
        } catch {
            throw SceneSetComposerError.backendFailure(error.localizedDescription)
        }
    }

    // MARK: - Legacy fetch (no locations — old server / templated fallback)

    private func fetchPoolLegacy(
        queries: [SceneryQuery],
        location: String,
        curatedNames: [String] = []
    ) async throws -> PoolBuildResult {
        guard let client else { throw SceneSetComposerError.missingUnsplashKey }

        var fetched: [(photo: UnsplashClient.APIPhoto, tags: SceneryPhotoTags?)] = []
        let total = queries.count
        state = .fetchingPhotos(completed: 0, total: max(total, 1))

        for (index, query) in queries.enumerated() {
            try Task.checkCancellation()
            let take = max(1, query.take)
            if let results = try? await client.searchPhotos(query: query.text, count: take) {
                let tags = SceneryPhotoTags(query: query)
                for photo in results {
                    fetched.append((photo: photo, tags: tags))
                }
            }
            state = .fetchingPhotos(completed: index + 1, total: total)
        }

        var seen: Set<String> = []
        let unique = Array(
            fetched.filter { seen.insert($0.photo.id).inserted }.prefix(SceneryPoolBuilder.maxPhotos))
        guard !unique.isEmpty else { throw SceneSetComposerError.noPhotosFound }

        // Caption-free naming priority:
        // 1) Unsplash location metadata — needs a per-photo detail request, as
        //    search results carry no `location` field at all
        // 2) AI-curated sceneNames (older servers without `locations`)
        // 3) bare set title — never pool-index labels like "Iceland 5"
        let metadataNames = await SceneryPoolBuilder.placeNames(
            client: client, photoIDs: unique.map(\.photo.id))
        try Task.checkCancellation()
        let curated = Self.normalizeSceneNames(curatedNames)
        let fallbackName = Self.bareSetTitle(location)
        var curatedIndex = 0
        let photos: [SceneryPhoto] = unique.map { entry in
            let name: String
            if let meta = entry.photo.suggestedSceneName ?? metadataNames[entry.photo.id] {
                name = meta
            } else if !curated.isEmpty {
                name = curated[curatedIndex % curated.count]
                curatedIndex += 1
            } else {
                name = fallbackName
            }
            return SceneryPoolBuilder.sceneryPhoto(from: entry.photo, name: name)
        }
        let photoTags = Dictionary(
            unique.compactMap { entry in
                entry.tags.map { (entry.photo.id, $0) }
            },
            uniquingKeysWith: { first, _ in first })
        let sceneNames = Self.normalizeSceneNames(photos.map(\.name))
        return PoolBuildResult(photos: photos, sceneNames: sceneNames, photoTags: photoTags)
    }

    // MARK: - Pure helpers (unit-tested)

    /// Maps generated RPC locations into persisted manifest locations.
    nonisolated static func makeStoreLocations(
        from generated: [GeneratedSceneryLocation]
    ) -> [SceneryLocation] {
        var seen = Set<String>()
        var out: [SceneryLocation] = []
        for loc in generated {
            let name = normalizeSceneNames([loc.name]).first
            let query = loc.query.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            guard let name, !query.isEmpty else { continue }
            let key = name.lowercased()
            guard seen.insert(key).inserted else { continue }
            out.append(
                SceneryLocation(
                    name: name,
                    query: query,
                    timeOfDay: loc.timeOfDay.flatMap { SceneryTimeOfDay(rawValue: $0.rawValue) },
                    season: loc.season.flatMap { ScenerySeason(rawValue: $0.rawValue) }))
            if out.count >= 16 { break }
        }
        return out
    }

    nonisolated static func tags(from location: GeneratedSceneryLocation) -> SceneryPhotoTags? {
        let mapped = makeStoreLocations(from: [location]).first
        return mapped.flatMap { SceneryPoolBuilder.tags(from: $0) }
    }

    nonisolated static func makeStoreQueries(
        from generated: [GeneratedSceneryQuery], location: String
    ) -> [SceneryQuery] {
        var seen = Set<String>()
        var out: [SceneryQuery] = []
        for query in generated {
            let text = query.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let key = text.lowercased()
            guard seen.insert(key).inserted else { continue }
            out.append(
                SceneryQuery(
                    text: text,
                    timeOfDay: query.timeOfDay.flatMap { SceneryTimeOfDay(rawValue: $0.rawValue) },
                    season: query.season.flatMap { ScenerySeason(rawValue: $0.rawValue) },
                    take: out.isEmpty ? 12 : 8))
            // Align with server sanitize cap (4–6 general top-up queries).
            if out.count >= 6 { break }
        }
        if out.isEmpty {
            return ScenerySetFallback.templatedQueries(location: location)
        }
        return out
    }

    nonisolated static func normalizeSceneNames(_ names: [String]) -> [String] {
        var nameCounts: [String: Int] = [:]
        var nameIndices: [String: Int] = [:]
        var out: [String] = []

        // First pass: count occurrences of each base name
        for raw in names {
            let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            guard !name.isEmpty else { continue }
            let key = name.lowercased()
            nameCounts[key, default: 0] += 1
        }

        // Second pass: assign names with feature suffixes for duplicates
        for raw in names {
            let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            guard !name.isEmpty else { continue }
            let key = name.lowercased()

            let finalName: String
            if let count = nameCounts[key], count > 1 {
                // Multiple photos from same place - add feature-based suffix
                let index = nameIndices[key, default: 0]
                nameIndices[key] = index + 1
                let suffix = Self.featureSuffix(for: index)
                finalName = "\(name) \(suffix)"
            } else {
                // Unique place name - use as-is
                finalName = name
            }

            let truncated = finalName.count <= 48 ? finalName : String(finalName.prefix(45)).trimmingCharacters(in: .whitespaces) + "..."
            out.append(truncated)
            if out.count >= 40 { break }
        }
        return out
    }

    /// Returns a feature-based suffix for differentiating photos from the same location.
    /// Creates evocative names like "Harbor", "Sunset", "Streets", "Vista" rather than numbers.
    private nonisolated static func featureSuffix(for index: Int) -> String {
        let suffixes = [
            "Harbor", "Sunset", "Streets", "Vista", "Coast",
            "Peaks", "Valley", "Dawn", "Hills", "Beach",
            "Village", "Market", "Square", "Gardens", "Lighthouse",
            "Cliffs", "Bridge", "Lake", "Forest", "Ruins",
            "Cathedral", "Castle", "Tower", "Pathway", "Waterfront"
        ]
        // Cycle through suffixes if we have more photos than suffix options
        return suffixes[index % suffixes.count]
    }

    /// Bare place label for metadata-less pool photos (never numbered).
    nonisolated static func bareSetTitle(_ location: String) -> String {
        let base = location.trimmingCharacters(in: .whitespacesAndNewlines)
        return base.isEmpty ? "Scene" : base
    }

    /// Historical helper: pool-index labels. Prefer `bareSetTitle` for new pools;
    /// kept for tests and for stripping old on-disk names in `baseSceneName`.
    nonisolated static func numberedNames(location: String, count: Int) -> [String] {
        let label = bareSetTitle(location)
        return (1...max(count, 1)).map { "\(label) \($0)" }
    }
}

// MARK: - Slug + fallback (pure)

public enum ScenerySetSlug {
    /// Filesystem-safe set id: `kyoto-3f2a` style.
    public static func make(from location: String, suffix: String? = nil) -> String {
        let folded = location
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            .lowercased()
        let slug = folded
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let base = slug.isEmpty ? "set" : String(slug.prefix(40))
        let tail =
            suffix
            ?? String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(4))
            .lowercased()
        return "\(base)-\(tail)"
    }
}

public enum ScenerySetFallback {
    /// Templated Unsplash queries when the backend RPC fails.
    public static func templatedQueries(location: String) -> [SceneryQuery] {
        let loc = location.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = loc.isEmpty ? "landscape" : loc
        return [
            SceneryQuery(text: "\(base) landscape", take: 12),
            SceneryQuery(text: "\(base) mountains", timeOfDay: .day, take: 8),
            SceneryQuery(text: "\(base) sunrise", timeOfDay: .dawn, take: 6),
            SceneryQuery(text: "\(base) sunset", timeOfDay: .dusk, take: 6),
            SceneryQuery(text: "\(base) night", timeOfDay: .night, take: 4),
            SceneryQuery(text: "\(base) coast", take: 6),
            SceneryQuery(text: "\(base) autumn", season: .autumn, take: 4),
            SceneryQuery(text: "\(base) winter snow", season: .winter, take: 4),
        ]
    }

    public static func templatedGeneration(location: String) -> GeneratedScenerySet {
        let queries = templatedQueries(location: location).map {
            GeneratedSceneryQuery(
                text: $0.text,
                timeOfDay: $0.timeOfDay.flatMap {
                    GeneratedSceneryTimeOfDay(rawValue: $0.rawValue)
                },
                season: $0.season.flatMap { GeneratedScenerySeason(rawValue: $0.rawValue) })
        }
        // Empty locations + empty scene names → legacy path: metadata / numbered.
        return GeneratedScenerySet(sceneNames: [], queries: queries, locations: nil)
    }
}

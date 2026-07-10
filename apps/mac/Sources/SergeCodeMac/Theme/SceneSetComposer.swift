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
            let locations = generated.locations ?? []
            let poolResult: PoolBuildResult
            if !locations.isEmpty {
                poolResult = try await fetchPoolFromLocations(
                    locations: locations,
                    queries: queries,
                    location: location)
            } else {
                poolResult = try await fetchPoolLegacy(
                    queries: queries,
                    location: location)
            }
            try Task.checkCancellation()

            let set = ScenerySet(
                id: setId,
                title: title,
                origin: .custom,
                createdAt: Date(),
                queries: queries,
                sceneNames: poolResult.sceneNames,
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
    /// then top up from general queries when needed.
    private func fetchPoolFromLocations(
        locations: [GeneratedSceneryLocation],
        queries: [SceneryQuery],
        location: String
    ) async throws -> PoolBuildResult {
        guard let client else { throw SceneSetComposerError.missingUnsplashKey }

        let maxPhotos = 24
        let minNamed = 12
        let totalSteps = locations.count + queries.count
        state = .fetchingPhotos(completed: 0, total: max(totalSteps, 1))

        var photos: [SceneryPhoto] = []
        var photoTags: [String: SceneryPhotoTags] = [:]
        var seen = Set<String>()
        var completed = 0

        for loc in locations {
            try Task.checkCancellation()
            defer {
                completed += 1
                state = .fetchingPhotos(completed: completed, total: totalSteps)
            }
            guard photos.count < maxPhotos else { continue }
            let queryText = loc.query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !queryText.isEmpty else { continue }
            guard let results = try? await client.searchPhotos(query: queryText, count: 2) else {
                continue
            }
            guard let apiPhoto = results.first(where: { !seen.contains($0.id) }) else { continue }
            seen.insert(apiPhoto.id)

            let placeName = Self.normalizeSceneNames([loc.name]).first ?? loc.name
            photos.append(
                Self.sceneryPhoto(from: apiPhoto, name: placeName))
            if let tags = Self.tags(from: loc) {
                photoTags[apiPhoto.id] = tags
            }
        }

        // Top up from general queries only when named photos fall short of 12.
        if photos.count < minNamed {
            for query in queries {
                try Task.checkCancellation()
                defer {
                    completed += 1
                    state = .fetchingPhotos(
                        completed: min(completed, totalSteps), total: totalSteps)
                }
                guard photos.count < maxPhotos else { continue }
                let take = max(1, min(query.take, maxPhotos - photos.count))
                guard let results = try? await client.searchPhotos(query: query.text, count: take)
                else { continue }
                let tags = SceneryPhotoTags(query: query)
                for apiPhoto in results {
                    guard photos.count < maxPhotos else { break }
                    guard seen.insert(apiPhoto.id).inserted else { continue }
                    let name =
                        apiPhoto.suggestedSceneName
                        ?? Self.numberedNames(location: location, count: photos.count + 1).last!
                    photos.append(Self.sceneryPhoto(from: apiPhoto, name: name))
                    if let tags { photoTags[apiPhoto.id] = tags }
                }
            }
        } else {
            // Still advance progress for skipped general-query steps.
            completed = totalSteps
            state = .fetchingPhotos(completed: completed, total: totalSteps)
        }

        guard !photos.isEmpty else { throw SceneSetComposerError.noPhotosFound }

        // sceneNames = ordered unique names actually assigned to pool photos.
        let sceneNames = Self.normalizeSceneNames(photos.map(\.name))
        return PoolBuildResult(photos: photos, sceneNames: sceneNames, photoTags: photoTags)
    }

    // MARK: - Legacy fetch (no locations — old server / templated fallback)

    private func fetchPoolLegacy(
        queries: [SceneryQuery],
        location: String
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
        let unique = Array(fetched.filter { seen.insert($0.photo.id).inserted }.prefix(24))
        guard !unique.isEmpty else { throw SceneSetComposerError.noPhotosFound }

        // Caption-free: metadata location only, else numbered set-title names.
        var usedNumber = 0
        let photos: [SceneryPhoto] = unique.map { entry in
            let name: String
            if let meta = entry.photo.suggestedSceneName {
                name = meta
            } else {
                usedNumber += 1
                name = Self.numberedNames(location: location, count: usedNumber).last!
            }
            return Self.sceneryPhoto(from: entry.photo, name: name)
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

    nonisolated static func sceneryPhoto(from photo: UnsplashClient.APIPhoto, name: String)
        -> SceneryPhoto
    {
        SceneryPhoto(
            id: photo.id,
            name: name,
            averageColorHex: photo.color,
            heroURL: photo.urls.regular,
            thumbURL: photo.urls.thumb,
            rawURL: photo.urls.raw,
            downloadLocationURL: photo.links?.downloadLocation,
            photographerName: photo.user.name,
            photographerProfileURL: photo.user.links?.html)
    }

    nonisolated static func tags(from location: GeneratedSceneryLocation) -> SceneryPhotoTags? {
        let timeOfDay = location.timeOfDay.flatMap { SceneryTimeOfDay(rawValue: $0.rawValue) }
        let season = location.season.flatMap { ScenerySeason(rawValue: $0.rawValue) }
        guard timeOfDay != nil || season != nil else { return nil }
        return SceneryPhotoTags(timeOfDay: timeOfDay, season: season)
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
            if out.count >= 12 { break }
        }
        if out.isEmpty {
            return ScenerySetFallback.templatedQueries(location: location)
        }
        return out
    }

    nonisolated static func normalizeSceneNames(_ names: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in names {
            let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            guard !name.isEmpty else { continue }
            let key = name.lowercased()
            guard seen.insert(key).inserted else { continue }
            out.append(name.count <= 48 ? name : String(name.prefix(45)) + "...")
            if out.count >= 40 { break }
        }
        return out
    }

    nonisolated static func numberedNames(location: String, count: Int) -> [String] {
        let base = location.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = base.isEmpty ? "Scene" : base
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

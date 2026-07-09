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
    private var workTask: Task<Void, Never>?

    public init(
        store: SceneryStore,
        backend: any BackendService,
        client: UnsplashClient? = UnsplashClient()
    ) {
        self.store = store
        self.backend = backend
        self.client = client
    }

    /// Start creating a custom set for `location`. Cancels any in-flight run.
    public func createSet(location: String) {
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

        workTask = Task { [weak self] in
            await self?.runCreate(location: trimmed)
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

    private func runCreate(location: String) async {
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

        let setId = ScenerySetSlug.make(from: location)
        let title = location
        var sceneNames = Self.normalizeSceneNames(generated.sceneNames)

        do {
            let (photos, metaNames, photoTags) = try await fetchPool(
                queries: queries,
                sceneNames: sceneNames,
                location: location)
            try Task.checkCancellation()

            if sceneNames.count < 8, !metaNames.isEmpty {
                sceneNames = Self.normalizeSceneNames(sceneNames + metaNames)
            }
            if sceneNames.isEmpty {
                sceneNames = Self.numberedNames(location: location, count: max(photos.count, 12))
            }

            let set = ScenerySet(
                id: setId,
                title: title,
                origin: .custom,
                createdAt: Date(),
                queries: queries,
                sceneNames: sceneNames,
                palette: nil)

            // Re-apply names against the final sceneNames list.
            let namedPhotos = photos.enumerated().map { index, photo in
                var copy = photo
                let base = sceneNames[index % sceneNames.count]
                copy.name = base
                return copy
            }

            store.registerSet(set, pool: namedPhotos, photoTags: photoTags)
            await store.generatePaletteIfNeeded(for: setId, downloadSamples: true)
            try Task.checkCancellation()
            state = .finished(setId: setId)
        } catch is CancellationError {
            state = .failed(.cancelled)
        } catch let err as SceneSetComposerError {
            state = .failed(err)
        } catch {
            state = .failed(.backendFailure(error.localizedDescription))
        }
    }

    private func fetchPool(
        queries: [SceneryQuery],
        sceneNames: [String],
        location: String
    ) async throws -> (
        photos: [SceneryPhoto],
        metaNames: [String],
        photoTags: [String: SceneryPhotoTags]
    ) {
        guard let client else { throw SceneSetComposerError.missingUnsplashKey }

        var fetched: [(photo: UnsplashClient.APIPhoto, tags: SceneryPhotoTags?)] = []
        var metaNames: [String] = []
        let total = queries.count
        state = .fetchingPhotos(completed: 0, total: total)

        for (index, query) in queries.enumerated() {
            try Task.checkCancellation()
            let take = max(1, query.take)
            if let results = try? await client.searchPhotos(query: query.text, count: take) {
                let tags = SceneryPhotoTags(query: query)
                for photo in results {
                    fetched.append((photo: photo, tags: tags))
                    if let name = photo.suggestedSceneName {
                        metaNames.append(name)
                    }
                }
            }
            state = .fetchingPhotos(completed: index + 1, total: total)
        }

        var seen: Set<String> = []
        let unique = Array(fetched.filter { seen.insert($0.photo.id).inserted }.prefix(24))
        guard !unique.isEmpty else { throw SceneSetComposerError.noPhotosFound }

        let names =
            sceneNames.isEmpty
            ? Self.numberedNames(location: location, count: unique.count)
            : sceneNames
        let photos = unique.enumerated().map { index, entry in
            let photo = entry.photo
            let base = names[index % names.count]
            return SceneryPhoto(
                id: photo.id,
                name: base,
                averageColorHex: photo.color,
                heroURL: photo.urls.regular,
                thumbURL: photo.urls.thumb,
                rawURL: photo.urls.raw,
                downloadLocationURL: photo.links?.downloadLocation,
                photographerName: photo.user.name,
                photographerProfileURL: photo.user.links?.html)
        }
        let photoTags = Dictionary(
            unique.compactMap { entry in
                entry.tags.map { (entry.photo.id, $0) }
            },
            uniquingKeysWith: { first, _ in first })
        return (photos, metaNames, photoTags)
    }

    // MARK: - Pure helpers (unit-tested)

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
        // Empty scene names → filled from Unsplash metadata / numbered fallback.
        return GeneratedScenerySet(sceneNames: [], queries: queries)
    }
}

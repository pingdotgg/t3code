import Foundation
import T3Kit

/// Shared Unsplash pool construction for the builtin World set refresh.
///
/// `SceneryStore` is `@MainActor`; `UnsplashClient` is an actor. This helper
/// is intentionally nonisolated so callers can `await` it without isolation
/// friction.
enum SceneryPoolBuilder {
    /// Two landscape results for each of the 48 location searches in one
    /// rate-safe catalog batch.
    static let maxPhotos = 96

    struct BuildResult: Sendable {
        var photos: [SceneryPhoto]
        var sceneNames: [String]
        var photoTags: [String: SceneryPhotoTags]
    }

    enum BuildError: Error, Sendable {
        case noPhotosFound
    }

    /// How many location searches are in flight at once. Bounded rather than
    /// unlimited: Unsplash rate-limits per hour, and a burst of two dozen
    /// simultaneous requests is the shape most likely to trip it.
    static let searchConcurrency = 6

    /// Up to two deduped photos per curated location (search count 2), named
    /// verbatim with the location's curated name — never captions, never
    /// pool-index numbering, never AI-generated names. A location whose
    /// search yields nothing is skipped rather than failing the whole build.
    ///
    /// The searches run concurrently because this build sits on the new-thread
    /// path — `SceneryStore.start()` awaits it and `createSceneThread` awaits
    /// that — so serial round trips showed up to the user as a new session
    /// taking tens of seconds to open. Results are collected by
    /// location index and deduped in location order afterwards, so the pool is
    /// identical to the serial build's regardless of completion order. The one
    /// behavioural difference: the serial version stopped searching once
    /// `maxPhotos` was reached, which cannot be known in advance here. Callers
    /// therefore pass at most one bounded catalog batch.
    nonisolated static func buildFromLocations(
        client: UnsplashClient,
        locations: [SceneryLocation],
        excludingPhotoIDs: Set<String> = [],
        onProgress: (@Sendable (Int, Int) async -> Void)? = nil
    ) async throws -> BuildResult {
        let totalSteps = max(locations.count, 1)
        await onProgress?(0, totalSteps)

        let queries = locations.map { $0.query.trimmingCharacters(in: .whitespacesAndNewlines) }
        let fetch: @Sendable (Int) async throws -> (Int, [UnsplashClient.APIPhoto]?) = { index in
            guard !queries[index].isEmpty else { return (index, nil) }
            return (index, try await search(client: client, query: queries[index], count: 2))
        }

        var resultsByIndex: [Int: [UnsplashClient.APIPhoto]] = [:]
        try await withThrowingTaskGroup(of: (Int, [UnsplashClient.APIPhoto]?).self) { group in
            var next = 0
            var completed = 0
            while next < min(searchConcurrency, locations.count) {
                let index = next
                group.addTask { try await fetch(index) }
                next += 1
            }
            while let (index, results) = try await group.next() {
                if let results { resultsByIndex[index] = results }
                completed += 1
                await onProgress?(completed, totalSteps)
                guard next < locations.count else { continue }
                let index = next
                group.addTask { try await fetch(index) }
                next += 1
            }
        }

        var photos: [SceneryPhoto] = []
        var photoTags: [String: SceneryPhotoTags] = [:]
        var seen = excludingPhotoIDs
        for (index, loc) in locations.enumerated() {
            for apiPhoto in resultsByIndex[index] ?? [] {
                guard photos.count < maxPhotos else { break }
                guard seen.insert(apiPhoto.id).inserted else { continue }
                photos.append(sceneryPhoto(from: apiPhoto, name: loc.name))
                if let tags = tags(from: loc) {
                    photoTags[apiPhoto.id] = tags
                }
            }
        }

        guard !photos.isEmpty else { throw BuildError.noPhotosFound }

        return BuildResult(photos: photos, sceneNames: photos.map(\.name), photoTags: photoTags)
    }

    /// Cancellation-aware search: rethrows cancellation (see `isCancellation`
    /// for the shapes it arrives in) so a cancelled build aborts instead of
    /// silently degrading to a partial pool, but swallows ordinary API errors
    /// (returns nil) so one flaky query keeps the existing partial-result
    /// behavior.
    private nonisolated static func search(
        client: UnsplashClient, query: String, count: Int
    ) async throws -> [UnsplashClient.APIPhoto]? {
        do {
            return try await client.searchPhotos(query: query, count: count)
        } catch {
            if error.isCancellation { throw CancellationError() }
            return nil
        }
    }

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

    nonisolated static func tags(from location: SceneryLocation) -> SceneryPhotoTags? {
        guard location.timeOfDay != nil || location.season != nil else { return nil }
        return SceneryPhotoTags(timeOfDay: location.timeOfDay, season: location.season)
    }
}

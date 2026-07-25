import Foundation

/// Shared Unsplash pool construction for the builtin World set refresh.
///
/// `SceneryStore` is `@MainActor`; `UnsplashClient` is an actor. This helper
/// is intentionally nonisolated so callers can `await` it without isolation
/// friction.
enum SceneryPoolBuilder {
    static let maxPhotos = 24

    struct BuildResult: Sendable {
        var photos: [SceneryPhoto]
        var sceneNames: [String]
        var photoTags: [String: SceneryPhotoTags]
    }

    enum BuildError: Error, Sendable {
        case noPhotosFound
    }

    /// One deduped photo per curated location (search count 2), named
    /// verbatim with the location's curated name — never captions, never
    /// pool-index numbering, never AI-generated names. A location whose
    /// search yields nothing is skipped rather than failing the whole build.
    nonisolated static func buildFromLocations(
        client: UnsplashClient,
        locations: [SceneryLocation],
        onProgress: (@Sendable (Int, Int) async -> Void)? = nil
    ) async throws -> BuildResult {
        let totalSteps = max(locations.count, 1)
        await onProgress?(0, totalSteps)

        var photos: [SceneryPhoto] = []
        var photoTags: [String: SceneryPhotoTags] = [:]
        var seen = Set<String>()

        for (index, loc) in locations.enumerated() {
            try Task.checkCancellation()

            if photos.count < maxPhotos {
                let queryText = loc.query.trimmingCharacters(in: .whitespacesAndNewlines)
                if !queryText.isEmpty,
                    let results = try await search(client: client, query: queryText, count: 2),
                    let apiPhoto = results.first(where: { !seen.contains($0.id) })
                {
                    seen.insert(apiPhoto.id)
                    photos.append(sceneryPhoto(from: apiPhoto, name: loc.name))
                    if let tags = tags(from: loc) {
                        photoTags[apiPhoto.id] = tags
                    }
                }
            }

            await onProgress?(index + 1, totalSteps)
        }

        guard !photos.isEmpty else { throw BuildError.noPhotosFound }

        return BuildResult(photos: photos, sceneNames: photos.map(\.name), photoTags: photoTags)
    }

    /// Cancellation-aware search: rethrows cancellation (either
    /// `CancellationError` or the `URLError.cancelled` that `URLSession`'s
    /// async `data(for:)` surfaces when its task is cancelled) so a cancelled
    /// build aborts instead of silently degrading to a partial pool, but
    /// swallows ordinary API errors (returns nil) so one flaky query keeps
    /// the existing partial-result behavior.
    private nonisolated static func search(
        client: UnsplashClient, query: String, count: Int
    ) async throws -> [UnsplashClient.APIPhoto]? {
        do {
            return try await client.searchPhotos(query: query, count: count)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
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

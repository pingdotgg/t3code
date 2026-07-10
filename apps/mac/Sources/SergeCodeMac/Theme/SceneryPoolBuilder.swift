import Foundation

/// Shared Unsplash pool construction for create/regenerate and refresh.
///
/// Both `SceneSetComposer` and `SceneryStore` are `@MainActor`; `UnsplashClient`
/// is an actor. This helper is intentionally nonisolated so either caller can
/// `await` it without isolation friction.
enum SceneryPoolBuilder {
    static let maxPhotos = 24
    static let minNamedPhotos = 12

    struct BuildResult: Sendable {
        var photos: [SceneryPhoto]
        var sceneNames: [String]
        var photoTags: [String: SceneryPhotoTags]
    }

    enum BuildError: Error, Sendable {
        case noPhotosFound
    }

    /// One deduped photo per location (name from location, never captions),
    /// then top up from general queries only when named photos fall short of
    /// `minNamedPhotos`. Top-up names use Unsplash location metadata or the
    /// bare set title — never captions, never pool-index numbering
    /// (`"Iceland 5"`), never curated-name round-robin.
    nonisolated static func buildFromLocations(
        client: UnsplashClient,
        locations: [SceneryLocation],
        queries: [SceneryQuery],
        setTitle: String,
        onProgress: (@Sendable (Int, Int) async -> Void)? = nil
    ) async throws -> BuildResult {
        let totalSteps = max(locations.count + queries.count, 1)
        await onProgress?(0, totalSteps)
        let fallbackName = SceneSetComposer.bareSetTitle(setTitle)

        var photos: [SceneryPhoto] = []
        var photoTags: [String: SceneryPhotoTags] = [:]
        var seen = Set<String>()
        var completed = 0

        for loc in locations {
            try Task.checkCancellation()

            if photos.count < maxPhotos {
                let queryText = loc.query.trimmingCharacters(in: .whitespacesAndNewlines)
                if !queryText.isEmpty,
                    let results = try? await client.searchPhotos(query: queryText, count: 2),
                    let apiPhoto = results.first(where: { !seen.contains($0.id) })
                {
                    seen.insert(apiPhoto.id)
                    let placeName =
                        SceneSetComposer.normalizeSceneNames([loc.name]).first ?? loc.name
                    photos.append(sceneryPhoto(from: apiPhoto, name: placeName))
                    if let tags = tags(from: loc) {
                        photoTags[apiPhoto.id] = tags
                    }
                }
            }

            completed += 1
            await onProgress?(completed, totalSteps)
        }

        // Top up from general queries only when named photos fall short of 12.
        if photos.count < minNamedPhotos {
            for query in queries {
                try Task.checkCancellation()

                if photos.count < maxPhotos {
                    let take = max(1, min(query.take, maxPhotos - photos.count))
                    if let results = try? await client.searchPhotos(query: query.text, count: take)
                    {
                        let queryTags = SceneryPhotoTags(query: query)
                        for apiPhoto in results {
                            guard photos.count < maxPhotos else { break }
                            guard seen.insert(apiPhoto.id).inserted else { continue }
                            // Bare set title — never "Iceland 1"…"Iceland N". Pool
                            // index must not leak into thread titles.
                            let name = apiPhoto.suggestedSceneName ?? fallbackName
                            photos.append(sceneryPhoto(from: apiPhoto, name: name))
                            if let queryTags { photoTags[apiPhoto.id] = queryTags }
                        }
                    }
                }

                completed += 1
                await onProgress?(min(completed, totalSteps), totalSteps)
            }
        } else {
            await onProgress?(totalSteps, totalSteps)
        }

        guard !photos.isEmpty else { throw BuildError.noPhotosFound }

        let sceneNames = SceneSetComposer.normalizeSceneNames(photos.map(\.name))
        return BuildResult(photos: photos, sceneNames: sceneNames, photoTags: photoTags)
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

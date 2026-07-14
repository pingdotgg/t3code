import Foundation

/// Shared Unsplash pool construction for create/regenerate and refresh.
///
/// Both `SceneSetComposer` and `SceneryStore` are `@MainActor`; `UnsplashClient`
/// is an actor. This helper is intentionally nonisolated so either caller can
/// `await` it without isolation friction.
enum SceneryPoolBuilder {
    static let maxPhotos = 24
    static let minNamedPhotos = 12
    /// Cap on per-photo detail requests spent hydrating place names in one
    /// build. A build already spends up to ~22 requests on searches and an
    /// Unsplash demo key allows 50 per hour.
    static let maxPlaceNameFetches = 24
    private static let placeNameFetchConcurrency = 4

    struct BuildResult: Sendable {
        var photos: [SceneryPhoto]
        var sceneNames: [String]
        var photoTags: [String: SceneryPhotoTags]
    }

    enum BuildError: Error, Sendable {
        case noPhotosFound
    }

    /// One deduped photo per location (name from location, never captions),
    /// then top up in two phases when named photos fall short of
    /// `minNamedPhotos`: first cycle additional fetches back across the same
    /// named locations (round-robin, still location-named), then — only if
    /// still short — fall back to the general queries with the bare set
    /// title. Those title-named top-ups are then hydrated with the real place
    /// name from each photo's Unsplash location metadata; only photos Unsplash
    /// has no location for keep the set title. Names never come from captions,
    /// from pool-index numbering (`"Iceland 5"`), or from curated-name
    /// round-robin.
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
                    let results = try await search(client: client, query: queryText, count: 2),
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

        // Top up STILL-named photos first: cycle additional fetches across the
        // same locations (round-robin, deduped by photo id) so the extra
        // photos keep their place name instead of falling straight to the
        // bare set title. Bounded to a couple of laps with modestly larger
        // `count` per lap (existing per-location fetch already only asks for
        // 2) so a thin location list can't spin unbounded API calls.
        if photos.count < minNamedPhotos, !locations.isEmpty {
            let maxLaps = 2
            var lap = 0
            while photos.count < minNamedPhotos, photos.count < maxPhotos, lap < maxLaps {
                var madeProgress = false
                for loc in locations {
                    try Task.checkCancellation()
                    guard photos.count < minNamedPhotos, photos.count < maxPhotos else { break }
                    let queryText = loc.query.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !queryText.isEmpty else { continue }
                    let take = 2 + (lap + 1) * 2
                    if let results = try await search(
                        client: client, query: queryText, count: take),
                        let apiPhoto = results.first(where: { !seen.contains($0.id) })
                    {
                        seen.insert(apiPhoto.id)
                        let placeName =
                            SceneSetComposer.normalizeSceneNames([loc.name]).first ?? loc.name
                        photos.append(sceneryPhoto(from: apiPhoto, name: placeName))
                        if let tags = tags(from: loc) {
                            photoTags[apiPhoto.id] = tags
                        }
                        madeProgress = true
                    }
                }
                lap += 1
                if !madeProgress { break }
            }
        }

        // Top up from general queries only when named photos still fall short
        // of 12 after the named-location round-robin above.
        if photos.count < minNamedPhotos {
            for query in queries {
                try Task.checkCancellation()

                if photos.count < maxPhotos {
                    let take = max(1, min(query.take, maxPhotos - photos.count))
                    if let results = try await search(
                        client: client, query: query.text, count: take)
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

        // General top-up photos were fetched by scenic query rather than by
        // place, so they carry the bare set title. Unsplash exposes `location`
        // only on the per-photo endpoint, so ask for it now: a thread named
        // after the photo's real place beats another "Iceland".
        let named = await hydratedNames(client: client, photos: photos, generic: fallbackName)

        let sceneNames = SceneSetComposer.normalizeSceneNames(named.map(\.name))
        return BuildResult(photos: named, sceneNames: sceneNames, photoTags: photoTags)
    }

    /// Replaces the `generic` placeholder name (the bare set title) with each
    /// photo's real Unsplash place name where one exists. Photos already named
    /// after a known `SceneryLocation` are left untouched and cost no request.
    nonisolated static func hydratedNames(
        client: UnsplashClient,
        photos: [SceneryPhoto],
        generic: String
    ) async -> [SceneryPhoto] {
        let genericIDs = photos.filter { $0.name == generic }.map(\.id)
        guard !genericIDs.isEmpty else { return photos }
        let names = await placeNames(client: client, photoIDs: genericIDs)
        guard !names.isEmpty else { return photos }
        return photos.map { photo in
            guard photo.name == generic, let name = names[photo.id] else { return photo }
            var renamed = photo
            renamed.name = name
            return renamed
        }
    }

    /// Real place names for `photoIDs`, one Unsplash detail request each,
    /// bounded by `maxPlaceNameFetches` and run a few at a time.
    ///
    /// Best-effort: an id whose request fails (rate limit, transport) or whose
    /// photo carries no location metadata is simply absent from the result, and
    /// the caller keeps whatever name it already had.
    nonisolated static func placeNames(
        client: UnsplashClient,
        photoIDs: [String]
    ) async -> [String: String] {
        let ids = Array(photoIDs.prefix(maxPlaceNameFetches))
        guard !ids.isEmpty else { return [:] }

        return await withTaskGroup(of: (String, String?).self) { group in
            var names: [String: String] = [:]
            var next = 0

            func addNextTask() {
                guard next < ids.count else { return }
                let id = ids[next]
                next += 1
                group.addTask {
                    guard !Task.isCancelled else { return (id, nil) }
                    let details = try? await client.photoDetails(id: id)
                    return (id, details?.suggestedSceneName)
                }
            }

            for _ in 0..<min(placeNameFetchConcurrency, ids.count) { addNextTask() }
            while let (id, name) = await group.next() {
                if let name, let normalized = SceneSetComposer.normalizeSceneNames([name]).first {
                    names[id] = normalized
                }
                addNextTask()
            }
            return names
        }
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

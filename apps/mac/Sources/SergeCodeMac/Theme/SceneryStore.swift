import AppKit
import Observation
import SwiftUI

/// Owns the app's alpine identity photos: one or more location photo sets
/// (builtin Dolomites + future custom sets), a stable thread → photo
/// assignment (each thread keeps "its" scene and the name derived from it),
/// and an in-memory NSImage cache for the views.
///
/// Disk layout (`~/Library/Application Support/SergeCode/scenery/`):
/// - `assignments.json` — global thread → { photoID, setId? }
/// - `settings.json` — `{ defaultSetId }`
/// - `project-prefs.json` — projectPath → `{ setId?, accentHex?, sfSymbol? }`
/// - `sets/<setId>/` — manifest.json, pool.json, photo-tags.json,
///   names.json, registered-downloads.json, images/
///
/// Everything degrades gracefully without a key or network: `photo(for:)`
/// returns nil and the views fall back to `AlpineTheme.gradient(seed:)`.
@MainActor
@Observable
public final class SceneryStore {
    public enum ImageVariant: String, Sendable {
        case hero  // CDN render sized to the display — wallpapers, empty-state hero
        case thumb  // urls.thumb (~200w) — sidebar rows
    }

    /// Default set's pool (kept for observation / source compatibility).
    /// Prefer `photo(for:)` which resolves the correct per-thread set.
    public private(set) var pool: [SceneryPhoto] = []
    /// Loaded set manifests (builtin + custom).
    public private(set) var availableSets: [ScenerySet] = []

    /// threadID → assignment (photo + owning set).
    private var assignments: [String: SceneryAssignment] = [:]
    /// setId → (threadID → scene display name committed at creation).
    private var namesBySet: [String: [String: String]] = [:]
    /// setId → photo pool.
    private var pools: [String: [SceneryPhoto]] = [:]
    /// setId → (photoID → query tags), stored outside mobile-shared pool.json.
    private var photoTagsBySet: [String: [String: SceneryPhotoTags]] = [:]
    /// setId → last successful pool fetch time.
    private var poolFetchedAt: [String: Date] = [:]
    /// setId → photos whose download_location was already pinged.
    private var registeredBySet: [String: Set<String>] = [:]

    private var images: [String: NSImage] = [:]  // "setId/photoID/variant" -> image
    private var loadingKeys: Set<String> = []
    /// Session-scoped in-flight + failed-extraction guard. Prevents unbounded
    /// re-spawns when extract returns nil; cleared only when no sample files
    /// exist yet (so a later image load can try once). Retry next launch is OK.
    private var paletteExtractionAttempted: Set<String> = []

    private var settings = ScenerySettingsFile()
    private var projectPrefs: [String: ProjectSceneryPrefs] = [:]

    private let client: UnsplashClient?
    private let root: URL

    /// Updated only on activation/day-change notifications. `@Observable`
    /// tracks these stores so surfaces that call `dailyFeatured()` /
    /// `peekNextScene()` (which read them) invalidate when the bucket flips —
    /// without polling or per-frame date reads, and without notifying views
    /// that never touch rotation state.
    public private(set) var rotationBucket: SceneryBucket
    /// Day identity used by `dailyFeatured()` (year + ordinal). Public so
    /// views can also depend on day rollover explicitly if needed.
    public private(set) var rotationDayKey: String

    /// Pixel width heroes are fetched and cached at: the widest attached
    /// screen's pixel width (so full-screen never upscales), capped to keep
    /// download size and decode memory sane. `urls.regular` is only 1080w —
    /// blurry the moment it stretches across a retina display.
    private let heroPixelWidth: Int

    private static let poolCap = 24
    private static let poolMaxAge: TimeInterval = 14 * 24 * 3600

    /// Optional lookup: threadID → project workspace path. Wired from
    /// AppModel so set resolution can read `project-prefs.json`.
    @ObservationIgnored
    public var projectPathForThread: ((String) -> String?)?

    public init(client: UnsplashClient? = UnsplashClient(), root: URL? = nil) {
        self.client = client
        let now = Date()
        let calendar = Calendar.autoupdatingCurrent
        rotationBucket = SceneryBucket.compute(for: now, calendar: calendar)
        rotationDayKey = Self.dayKey(for: now, calendar: calendar)
        let widestScreen =
            NSScreen.screens
            .map { $0.frame.width * $0.backingScaleFactor }
            .max() ?? 2560
        heroPixelWidth = min(Int(widestScreen.rounded()), 3840)
        if let root {
            self.root = root
        } else {
            let support =
                FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
                .first ?? FileManager.default.temporaryDirectory
            self.root = support.appendingPathComponent("SergeCode/scenery", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
    }

    // MARK: - Lifecycle

    private var startTask: Task<Void, Never>?

    /// Load sets + caches from disk, then refresh each set from the API when
    /// empty or stale. Idempotent: concurrent callers share one load.
    public func start() async {
        if startTask == nil {
            startTask = Task {
                loadFromDisk()
                for set in availableSets {
                    await generatePaletteIfNeeded(for: set.id)
                }
                for set in availableSets {
                    let fetchedAt = poolFetchedAt[set.id]
                    let stale =
                        fetchedAt.map { Date().timeIntervalSince($0) > Self.poolMaxAge } ?? true
                    let empty = (pools[set.id] ?? []).isEmpty
                    if empty || stale {
                        await refreshPool(for: set.id)
                    }
                }
                syncDefaultPool()
            }
        }
        await startTask?.value
    }

    /// Refreshes the cached local bucket. The app calls this on activation and
    /// NSCalendarDayChanged; tests can inject a fixed date/calendar.
    /// Writes only when the bucket or day key actually change so repeated
    /// activation notifications do not spuriously invalidate rotation readers.
    public func reevaluateRotation(
        at date: Date = Date(), calendar: Calendar = .autoupdatingCurrent
    ) {
        let nextBucket = SceneryBucket.compute(for: date, calendar: calendar)
        let nextDayKey = Self.dayKey(for: date, calendar: calendar)
        guard nextBucket != rotationBucket || nextDayKey != rotationDayKey else { return }
        rotationBucket = nextBucket
        rotationDayKey = nextDayKey
    }

    /// Pure calendar helper; `nonisolated` so tests and non-UI call sites can
    /// use it without hopping to the main actor.
    nonisolated private static func dayKey(for date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .day], from: date)
        let ordinal = calendar.ordinality(of: .day, in: .year, for: date) ?? 0
        return "\(parts.year ?? 0)-\(ordinal)"
    }

    // MARK: - Set resolution

    /// Resolves which set applies for a project path (or the global default).
    public func resolvedSetId(projectPath: String?) -> String {
        ScenerySetResolution.resolveSetId(
            projectPath: projectPath,
            projectPrefs: projectPrefs,
            defaultSetId: settings.defaultSetId,
            knownSetIds: Set(availableSets.map(\.id)))
    }

    /// Resolves the set for a thread via its project path (when wired) and
    /// assignment fallback.
    public func resolvedSetId(forThread threadID: String) -> String {
        if let assignment = assignments[threadID] {
            return assignment.resolvedSetId
        }
        let path = projectPathForThread?(threadID)
        return resolvedSetId(projectPath: path)
    }

    public func set(id: String) -> ScenerySet? {
        availableSets.first { $0.id == id }
    }

    /// Photos currently registered for a set (may be empty before first fetch).
    public func photos(forSetId setId: String) -> [SceneryPhoto] {
        pools[setId] ?? []
    }

    /// Palette for a resolved set. An explicit set id wins; otherwise the
    /// photo's owning set and then the global default are used.
    public func palette(for photo: SceneryPhoto?, setId: String? = nil) -> SceneryPalette? {
        let owner =
            setId
            ?? photo.flatMap { setIdContaining(photoID: $0.id) }
            ?? resolvedSetId(projectPath: nil)
        return set(id: owner)?.palette
    }

    public var defaultSetId: String {
        settings.defaultSetId
    }

    public func projectPrefs(for path: String) -> ProjectSceneryPrefs? {
        projectPrefs[path]
    }

    // MARK: - Assignment & naming

    /// The scene bound to a thread. Explicit assignment first (threads
    /// created in-app); stable hash fallback for threads that predate the
    /// scenery system or were created elsewhere.
    public func photo(for threadID: String) -> SceneryPhoto? {
        let setId = resolvedSetId(forThread: threadID)
        let setPool = pools[setId] ?? []
        if let assignment = assignments[threadID] {
            // Prefer the assignment's set pool; fall back to scanning all pools
            // so a renamed/missing set never blanks an existing photo.
            if let photo = pools[assignment.resolvedSetId]?.first(where: {
                $0.id == assignment.photoID
            }) {
                return photo
            }
            for pool in pools.values {
                if let photo = pool.first(where: { $0.id == assignment.photoID }) {
                    return photo
                }
            }
        }
        guard !setPool.isEmpty else { return nil }
        return setPool[AlpineTheme.stableIndex(threadID, setPool.count)]
    }

    /// The scene the next created thread will get. The preview and subsequent
    /// assignment use the same cached bucket and deterministic FNV seed.
    public func peekNextScene(
        projectPath: String? = nil,
        setIdOverride: String? = nil
    ) -> SceneryPhoto? {
        var setId = resolvedSetId(projectPath: projectPath)
        if let setIdOverride,
            availableSets.contains(where: { $0.id == setIdOverride })
        {
            setId = setIdOverride
        }
        let setPool = pools[setId] ?? []
        let assignmentCount = assignments.values.count { $0.resolvedSetId == setId }
        let seed = [
            "next", setId, projectPath ?? "", String(assignmentCount),
            rotationBucket.timeOfDay.rawValue, rotationBucket.season.rawValue,
        ].joined(separator: "|")
        return SceneryPhotoSelection.select(
            photos: setPool,
            tagsByPhotoID: photoTagsBySet[setId] ?? [:],
            bucket: rotationBucket,
            seed: seed)
    }

    /// Thread title for a scene: the plain place name, even when reused.
    public func threadTitle(for photo: SceneryPhoto) -> String {
        baseSceneName(photo.name, setId: setIdContaining(photoID: photo.id))
    }

    /// Commit a thread → photo binding (after the backend confirmed create),
    /// remembering the scene display name the thread was created under.
    public func assign(
        photoID: String,
        name: String,
        to threadID: String,
        projectPath: String? = nil,
        setIdOverride: String? = nil
    ) {
        let setId =
            setIdOverride.flatMap { candidate in
                guard pools[candidate]?.contains(where: { $0.id == photoID }) == true else {
                    return nil
                }
                return candidate
            }
            ?? setIdContaining(photoID: photoID)
            ?? resolvedSetId(projectPath: projectPath)
        let base = baseSceneName(name, setId: setId)
        assignments[threadID] = SceneryAssignment(
            photoID: photoID,
            setId: setId == ScenerySet.dolomitesID ? nil : setId)
        var names = namesBySet[setId] ?? [:]
        names[threadID] = base
        namesBySet[setId] = names
        saveAssignments()
        saveNames(for: setId)
    }

    /// Stable scene name for a thread ("Seceda"). Falls back to the
    /// assigned/hashed photo's base name for threads that predate the name map
    /// or were created by another client.
    public func sceneName(for threadID: String) -> String? {
        let setId = resolvedSetId(forThread: threadID)
        if let name = namesBySet[setId]?[threadID] {
            return baseSceneName(name, setId: setId)
        }
        // Scan other sets' name maps (legacy threads after migration).
        for (otherSetId, names) in namesBySet {
            if let name = names[threadID] {
                return baseSceneName(name, setId: otherSetId)
            }
        }
        return photo(for: threadID).map {
            baseSceneName($0.name, setId: setIdContaining(photoID: $0.id) ?? setId)
        }
    }

    /// Two-line naming for a thread: the scene place name as the stable
    /// primary name, plus the server title as the descriptive second line
    /// once first-turn title generation has replaced the scene seed.
    public func displayNames(for thread: ChatThread) -> (primary: String, description: String?) {
        let title = thread.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let scene = sceneName(for: thread.id) else {
            return (title, nil)
        }
        if title.isEmpty { return (scene, nil) }
        // Titles still matching the per-thread scene seed mean no description
        // was generated yet. Keep explicit compatibility for old local titles
        // that were numbered before scene reuse stopped changing the seed.
        if title == scene || Self.isLegacyNumberedSceneTitle(title, base: scene) {
            return (scene, nil)
        }
        return (scene, title)
    }

    private func baseSceneName(_ name: String, setId: String?) -> String {
        let sceneNames =
            setId.flatMap { set(id: $0)?.sceneNames }
            ?? ScenerySet.makeBuiltinDolomites().sceneNames
        for base in sceneNames.sorted(by: { $0.count > $1.count }) {
            if name == base || Self.isLegacyNumberedSceneTitle(name, base: base) {
                return base
            }
        }
        return name
    }

    /// Legacy scene numbering started at 2 (`<base> 1` was never produced).
    /// Plain-space lap names are capped to one digit to avoid hiding AI titles
    /// that end in years or large numbers.
    private static func isLegacyNumberedSceneTitle(_ title: String, base: String) -> Bool {
        let reuseSeparator = " · "
        if title.hasPrefix(base + reuseSeparator) {
            let suffix = title.dropFirst(base.count + reuseSeparator.count)
            return Int(suffix).map { $0 >= 2 } ?? false
        }

        let lapSeparator = " "
        guard title.hasPrefix(base + lapSeparator) else { return false }
        let suffix = title.dropFirst(base.count + lapSeparator.count)
        guard suffix.count == 1, let lap = Int(suffix) else { return false }
        return (2...9).contains(lap)
    }

    /// Empty-state hero: rotates by day and current time/season bucket through
    /// the default set's preferred subset.
    public func dailyFeatured() -> SceneryPhoto? {
        let setId = resolvedSetId(projectPath: nil)
        let setPool = pools[setId] ?? []
        let seed = [
            "daily", setId, rotationDayKey, rotationBucket.timeOfDay.rawValue,
            rotationBucket.season.rawValue,
        ].joined(separator: "|")
        return SceneryPhotoSelection.select(
            photos: setPool,
            tagsByPhotoID: photoTagsBySet[setId] ?? [:],
            bucket: rotationBucket,
            seed: seed)
    }

    // MARK: - Images

    /// Cached image, if already decoded this session. Views pair this with
    /// `ensureImage` in a `.task`.
    public func image(_ photo: SceneryPhoto, variant: ImageVariant) -> NSImage? {
        let setId = setIdContaining(photoID: photo.id) ?? ScenerySet.dolomitesID
        return images[cacheKey(setId, photo.id, variant)]
    }

    /// Load a photo's image into the in-memory cache: disk first, CDN on
    /// miss (writing back to disk). Safe to call repeatedly.
    public func ensureImage(_ photo: SceneryPhoto?, variant: ImageVariant) async {
        await ensureImage(photo, variant: variant, triggerPaletteBackfill: true)
    }

    private func ensureImage(
        _ photo: SceneryPhoto?,
        variant: ImageVariant,
        triggerPaletteBackfill: Bool
    ) async {
        guard let photo else { return }
        let setId = setIdContaining(photoID: photo.id) ?? ScenerySet.dolomitesID
        let key = cacheKey(setId, photo.id, variant)
        guard images[key] == nil, !loadingKeys.contains(key) else { return }
        loadingKeys.insert(key)
        defer { loadingKeys.remove(key) }

        let fileURL = setDirectory(setId)
            .appendingPathComponent("images/\(fileName(photo.id, variant))")
        var data = await Task.detached { try? Data(contentsOf: fileURL) }.value
        if data == nil, let client {
            let remote = remoteURL(for: photo, variant: variant)
            data = try? await client.fetchImageData(from: remote)
            if let data {
                await Task.detached {
                    try? FileManager.default.createDirectory(
                        at: fileURL.deletingLastPathComponent(),
                        withIntermediateDirectories: true)
                    try? data.write(to: fileURL, options: .atomic)
                }.value
                // Ping first; only persist registration on success so a
                // transient Unsplash failure is retried on the next load.
                await registerDownloadIfNeeded(
                    setId: setId,
                    photoId: photo.id,
                    downloadLocationURL: photo.downloadLocationURL
                ) { ping in
                    try await client.registerDownload(ping)
                }
            }
        }
        if let data, let image = NSImage(data: data) {
            images[key] = image
            if triggerPaletteBackfill {
                await generatePaletteIfNeeded(for: setId)
            }
        }
    }

    /// Extracts and persists a custom set's palette once. New-set creation can
    /// request thumbnail downloads first; startup and image loads use existing
    /// disk files as a lazy backfill. Bitmap work stays off the main actor.
    ///
    /// Failed extractions are not retried this launch (in-memory attempt marker).
    /// Missing sample files still allow a later retry once images land on disk.
    public func generatePaletteIfNeeded(for setId: String, downloadSamples: Bool = false) async {
        guard let manifest = set(id: setId), manifest.origin == .custom,
            manifest.palette == nil, !paletteExtractionAttempted.contains(setId)
        else { return }

        paletteExtractionAttempted.insert(setId)

        if downloadSamples {
            let samplePhotos = Array((pools[setId] ?? []).prefix(
                SceneryPaletteExtractor.maximumImageCount))
            for photo in samplePhotos {
                guard !Task.isCancelled else { return }
                await ensureImage(photo, variant: .thumb, triggerPaletteBackfill: false)
            }
        }

        let sampleURLs = paletteSampleURLs(for: setId)
        guard !sampleURLs.isEmpty else {
            // No samples yet — clear so a later ensureImage can try once images exist.
            paletteExtractionAttempted.remove(setId)
            return
        }
        let palette = await Task.detached(priority: .utility) {
            SceneryPaletteExtractor.extract(contentsOf: sampleURLs)
        }.value
        // On nil extract / cancel: leave setId in paletteExtractionAttempted so
        // rapid ensureImage calls do not re-spawn unbounded concurrent work.
        guard !Task.isCancelled, let palette,
            let index = availableSets.firstIndex(where: { $0.id == setId }),
            availableSets[index].palette == nil
        else { return }

        var updated = availableSets[index]
        updated.palette = palette
        availableSets[index] = updated
        saveManifest(updated)
    }

    private func paletteSampleURLs(for setId: String) -> [URL] {
        let imagesDirectory = setDirectory(setId).appendingPathComponent("images", isDirectory: true)
        let files =
            ((try? FileManager.default.contentsOfDirectory(
                at: imagesDirectory,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles])) ?? [])
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        var result: [URL] = []
        for photo in pools[setId] ?? [] {
            let thumbName = fileName(photo.id, .thumb)
            let currentHeroName = fileName(photo.id, .hero)
            let heroPrefix = "\(photo.id)-hero-w"
            if let file = files.first(where: { $0.lastPathComponent == thumbName })
                ?? files.first(where: { $0.lastPathComponent == currentHeroName })
                ?? files.first(where: {
                    $0.lastPathComponent.hasPrefix(heroPrefix)
                        && $0.pathExtension.lowercased() == "jpg"
                })
            {
                result.append(file)
                if result.count == SceneryPaletteExtractor.maximumImageCount { break }
            }
        }
        return result
    }

    private func cacheKey(_ setId: String, _ photoID: String, _ variant: ImageVariant) -> String {
        "\(setId)/\(photoID)/\(variant.rawValue)"
    }

    /// Disk name for a cached render. Heroes carry their pixel width so a
    /// resolution bump (bigger screen, cap change) never re-serves an old
    /// low-res file.
    private func fileName(_ photoID: String, _ variant: ImageVariant) -> String {
        switch variant {
        case .thumb: "\(photoID)-thumb.jpg"
        case .hero: "\(photoID)-hero-w\(heroPixelWidth).jpg"
        }
    }

    private func remoteURL(for photo: SceneryPhoto, variant: ImageVariant) -> URL {
        switch variant {
        case .thumb:
            return photo.thumbURL
        case .hero:
            // Ask the CDN for a render at the display's real width. Prefer
            // the unprocessed base (`urls.raw`); legacy pool entries cached
            // before rawURL existed get heroURL's sizing params rewritten
            // instead (same imgix pipeline).
            let base = photo.rawURL ?? photo.heroURL
            return Self.sizedImageURL(base, width: heroPixelWidth)
        }
    }

    /// Rewrites an Unsplash/imgix URL to a specific render width: replaces
    /// any existing sizing params, keeps identity params (ixid) intact.
    /// `fit=max` never upscales past the original asset.
    static func sizedImageURL(_ url: URL, width: Int) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        var items = (components.queryItems ?? []).filter {
            !["w", "h", "q", "fm", "fit", "crop"].contains($0.name)
        }
        items.append(contentsOf: [
            URLQueryItem(name: "w", value: String(width)),
            URLQueryItem(name: "q", value: "85"),
            URLQueryItem(name: "fm", value: "jpg"),
            URLQueryItem(name: "fit", value: "max"),
        ])
        components.queryItems = items
        return components.url ?? url
    }

    // MARK: - Pool refresh

    private func refreshPool(for setId: String) async {
        guard let client else { return }
        guard let set = set(id: setId) else { return }

        let refreshed: [SceneryPhoto]
        var refreshedTags: [String: SceneryPhotoTags] = [:]

        if let locations = set.locations, !locations.isEmpty {
            // Per-location path: re-fetch by place query and keep authentic names.
            // Never round-robin sceneNames onto generic top-up photos.
            guard
                let built = try? await SceneryPoolBuilder.buildFromLocations(
                    client: client,
                    locations: locations,
                    queries: set.queries,
                    setTitle: set.title)
            else { return }
            refreshed = built.photos
            refreshedTags = built.photoTags
        } else {
            // Legacy path (builtin Dolomites, older custom sets without locations):
            // query-pool fetch + curated sceneNames round-robin.
            var fetched: [(photo: UnsplashClient.APIPhoto, tags: SceneryPhotoTags?)] = []
            for query in set.queries {
                let take = max(1, query.take)
                guard let results = try? await client.searchPhotos(query: query.text, count: take)
                else { continue }
                let tags = SceneryPhotoTags(query: query)
                fetched.append(contentsOf: results.map { (photo: $0, tags: tags) })
            }
            var seen: Set<String> = []
            let unique = Array(
                fetched.filter { seen.insert($0.photo.id).inserted }.prefix(Self.poolCap))
            guard !unique.isEmpty else { return }

            let sceneNames =
                set.sceneNames.isEmpty
                ? ScenerySet.makeBuiltinDolomites().sceneNames
                : set.sceneNames
            refreshed = unique.enumerated().map { index, entry in
                let photo = entry.photo
                let base = sceneNames[index % sceneNames.count]
                return SceneryPoolBuilder.sceneryPhoto(from: photo, name: base)
            }
            for entry in unique {
                if let tags = entry.tags {
                    refreshedTags[entry.photo.id] = tags
                }
            }
        }

        // Carry over photos still assigned to threads but missing from the new
        // results, so a refresh never swaps an existing thread's scene out from
        // under its scene-derived title.
        let refreshedIDs = Set(refreshed.map(\.id))
        let assignedIDs = Set(
            assignments.values
                .filter { $0.resolvedSetId == setId }
                .map(\.photoID))
        let previous = pools[setId] ?? []
        let kept = previous.filter { assignedIDs.contains($0.id) && !refreshedIDs.contains($0.id) }
        let previousTags = photoTagsBySet[setId] ?? [:]
        for photo in kept {
            if let tags = previousTags[photo.id] {
                refreshedTags[photo.id] = tags
            }
        }
        pools[setId] = refreshed + kept
        photoTagsBySet[setId] = refreshedTags
        poolFetchedAt[setId] = Date()
        savePool(for: setId)
        savePhotoTags(for: setId)
        // Drop stale decoded images for this set from a previous pool.
        let prefix = "\(setId)/"
        images = images.filter { !$0.key.hasPrefix(prefix) }
        if setId == settings.defaultSetId || setId == ScenerySet.dolomitesID {
            syncDefaultPool()
        }
    }

    /// Test hook for `refreshPool` (stale/empty pool rebuild).
    func refreshPoolForTesting(setId: String) async {
        await refreshPool(for: setId)
    }

    private func syncDefaultPool() {
        let setId = resolvedSetId(projectPath: nil)
        pool = pools[setId] ?? []
    }

    private func setIdContaining(photoID: String) -> String? {
        for (setId, setPool) in pools {
            if setPool.contains(where: { $0.id == photoID }) {
                return setId
            }
        }
        return nil
    }

    // MARK: - Paths

    private func setsDirectory() -> URL {
        root.appendingPathComponent("sets", isDirectory: true)
    }

    private func setDirectory(_ setId: String) -> URL {
        setsDirectory().appendingPathComponent(setId, isDirectory: true)
    }

    private var assignmentsURL: URL { root.appendingPathComponent("assignments.json") }
    private var settingsURL: URL { root.appendingPathComponent("settings.json") }
    private var projectPrefsURL: URL { root.appendingPathComponent("project-prefs.json") }

    // MARK: - Persistence

    private struct PoolFile: Codable {
        var fetchedAt: Date
        var photos: [SceneryPhoto]
    }

    private func loadFromDisk() {
        _ = try? SceneryLayoutMigration.migrateIfNeeded(root: root)
        loadSettings()
        loadProjectPrefs()
        loadAssignments()
        loadSetRegistry()
        for set in availableSets {
            loadSetData(set.id)
        }
        // Ensure builtin dolomites is always present even on empty disk.
        if !availableSets.contains(where: { $0.id == ScenerySet.dolomitesID }) {
            let builtin = ScenerySet.makeBuiltinDolomites()
            availableSets.append(builtin)
            saveManifest(builtin)
            loadSetData(builtin.id)
        }
        syncDefaultPool()
    }

    private func loadSetRegistry() {
        let setsDir = setsDirectory()
        let fm = FileManager.default
        guard
            let contents = try? fm.contentsOfDirectory(
                at: setsDir, includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles])
        else {
            availableSets = []
            return
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var loaded: [ScenerySet] = []
        for dir in contents {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
                continue
            }
            let manifestURL = dir.appendingPathComponent("manifest.json")
            guard let data = try? Data(contentsOf: manifestURL),
                let manifest = try? decoder.decode(ScenerySet.self, from: data)
            else { continue }
            loaded.append(manifest)
        }
        // Builtin first for stable UI ordering later.
        loaded.sort { lhs, rhs in
            if lhs.id == ScenerySet.dolomitesID { return true }
            if rhs.id == ScenerySet.dolomitesID { return false }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
        availableSets = loaded
    }

    private func loadSetData(_ setId: String) {
        let dir = setDirectory(setId)
        let poolURL = dir.appendingPathComponent("pool.json")
        if let data = try? Data(contentsOf: poolURL),
            let file = try? JSONDecoder().decode(PoolFile.self, from: data)
        {
            pools[setId] = file.photos
            poolFetchedAt[setId] = file.fetchedAt
        } else {
            pools[setId] = pools[setId] ?? []
        }

        let photoTagsURL = dir.appendingPathComponent("photo-tags.json")
        if let data = try? Data(contentsOf: photoTagsURL),
            let tags = try? JSONDecoder().decode([String: SceneryPhotoTags].self, from: data)
        {
            photoTagsBySet[setId] = tags.filter { !$0.value.isUntagged }
        } else {
            photoTagsBySet[setId] = photoTagsBySet[setId] ?? [:]
        }

        let namesURL = dir.appendingPathComponent("names.json")
        if let data = try? Data(contentsOf: namesURL),
            let map = try? JSONDecoder().decode([String: String].self, from: data)
        {
            namesBySet[setId] = map
        } else {
            namesBySet[setId] = namesBySet[setId] ?? [:]
        }

        let registeredURL = dir.appendingPathComponent("registered-downloads.json")
        if let data = try? Data(contentsOf: registeredURL),
            let ids = try? JSONDecoder().decode(Set<String>.self, from: data)
        {
            registeredBySet[setId] = ids
        } else {
            registeredBySet[setId] = registeredBySet[setId] ?? []
        }

        try? FileManager.default.createDirectory(
            at: dir.appendingPathComponent("images", isDirectory: true),
            withIntermediateDirectories: true)
    }

    private func loadSettings() {
        if let data = try? Data(contentsOf: settingsURL),
            let file = try? JSONDecoder().decode(ScenerySettingsFile.self, from: data)
        {
            settings = file
        } else {
            settings = ScenerySettingsFile()
            saveSettings()
        }
    }

    private func loadProjectPrefs() {
        if let data = try? Data(contentsOf: projectPrefsURL),
            let map = try? JSONDecoder().decode([String: ProjectSceneryPrefs].self, from: data)
        {
            projectPrefs = map
        } else {
            projectPrefs = [:]
        }
    }

    private func loadAssignments() {
        guard let data = try? Data(contentsOf: assignmentsURL) else {
            assignments = [:]
            return
        }
        // New format: [String: SceneryAssignment] (string or object values).
        if let map = try? JSONDecoder().decode([String: SceneryAssignment].self, from: data) {
            assignments = map
            return
        }
        // Extremely defensive: plain [String: String] without custom decode path.
        if let map = try? JSONDecoder().decode([String: String].self, from: data) {
            assignments = map.mapValues { SceneryAssignment(photoID: $0, setId: nil) }
            return
        }
        assignments = [:]
    }

    private func saveSettings() {
        if let data = try? JSONEncoder().encode(settings) {
            try? data.write(to: settingsURL, options: .atomic)
        }
    }

    private func saveProjectPrefs() {
        if let data = try? JSONEncoder().encode(projectPrefs) {
            try? data.write(to: projectPrefsURL, options: .atomic)
        }
    }

    private func saveManifest(_ set: ScenerySet) {
        let dir = setDirectory(set.id)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let url = dir.appendingPathComponent("manifest.json")
        if let data = try? encoder.encode(set) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func savePool(for setId: String) {
        guard let fetchedAt = poolFetchedAt[setId], let photos = pools[setId] else { return }
        let file = PoolFile(fetchedAt: fetchedAt, photos: photos)
        let url = setDirectory(setId).appendingPathComponent("pool.json")
        if let data = try? JSONEncoder().encode(file) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func savePhotoTags(for setId: String) {
        let poolIDs = Set((pools[setId] ?? []).map(\.id))
        let tags = (photoTagsBySet[setId] ?? [:]).filter {
            poolIDs.contains($0.key) && !$0.value.isUntagged
        }
        photoTagsBySet[setId] = tags
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let url = setDirectory(setId).appendingPathComponent("photo-tags.json")
        if let data = try? encoder.encode(tags) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func saveAssignments() {
        if let data = try? JSONEncoder().encode(assignments) {
            try? data.write(to: assignmentsURL, options: .atomic)
        }
    }

    private func saveNames(for setId: String) {
        let map = namesBySet[setId] ?? [:]
        let url = setDirectory(setId).appendingPathComponent("names.json")
        if let data = try? JSONEncoder().encode(map) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func saveRegisteredDownloads(for setId: String) {
        let ids = registeredBySet[setId] ?? []
        let url = setDirectory(setId).appendingPathComponent("registered-downloads.json")
        if let data = try? JSONEncoder().encode(ids) {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Unsplash download_location ping + local registration bookkeeping.
    /// Awaits `register` first; mutates `registeredBySet` and disk only on
    /// success. Failures leave the photo unregistered (natural retry) and
    /// are not surfaced to the user.
    func registerDownloadIfNeeded(
        setId: String,
        photoId: String,
        downloadLocationURL: URL?,
        register: (URL) async throws -> Void
    ) async {
        guard let ping = downloadLocationURL else { return }
        var registered = registeredBySet[setId] ?? []
        guard !registered.contains(photoId) else { return }
        do {
            try await register(ping)
            registered.insert(photoId)
            registeredBySet[setId] = registered
            saveRegisteredDownloads(for: setId)
        } catch {
            // Transient ping failure — retry on a later ensureImage.
        }
    }

    /// Test helper: photo IDs already recorded as download-registered for a set.
    func registeredDownloadIDsForTesting(setId: String) -> Set<String> {
        registeredBySet[setId] ?? []
    }

    // MARK: - Registry mutations (Phase 2+)

    /// Writes project-prefs (used by Phase 5 UI; available now for tests).
    public func setProjectPrefs(_ prefs: ProjectSceneryPrefs, forProjectPath path: String) {
        projectPrefs[path] = prefs
        saveProjectPrefs()
    }

    /// Updates the global default set id.
    public func setDefaultSetId(_ setId: String) {
        settings.defaultSetId = setId
        saveSettings()
        syncDefaultPool()
    }

    /// Installs a set manifest into the registry (disk + memory).
    /// When `pool` is non-empty it is persisted; otherwise the pool stays empty
    /// until a later refresh. Custom sets are sorted after the builtin.
    ///
    /// When `replacePoolResidue` is true and `pool` is non-empty, clears stale
    /// per-set state left by a prior version of the same set id (thread name
    /// overrides, download registrations for removed photos, cached images for
    /// photos no longer in the pool, and palette extraction attempt markers so
    /// a nil palette is recomputed).
    public func registerSet(
        _ set: ScenerySet,
        pool: [SceneryPhoto] = [],
        photoTags: [String: SceneryPhotoTags]? = nil,
        replacePoolResidue: Bool = false
    ) {
        if let idx = availableSets.firstIndex(where: { $0.id == set.id }) {
            availableSets[idx] = set
        } else {
            availableSets.append(set)
        }
        availableSets.sort { lhs, rhs in
            if lhs.id == ScenerySet.dolomitesID { return true }
            if rhs.id == ScenerySet.dolomitesID { return false }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
        saveManifest(set)
        try? FileManager.default.createDirectory(
            at: setDirectory(set.id).appendingPathComponent("images", isDirectory: true),
            withIntermediateDirectories: true)
        pools[set.id] = pool
        if let photoTags {
            photoTagsBySet[set.id] = photoTags
        } else {
            photoTagsBySet[set.id] = photoTagsBySet[set.id] ?? [:]
        }

        if replacePoolResidue, !pool.isEmpty {
            let keepIDs = Set(pool.map(\.id))
            // Thread → scene name map may still reference caption-era names.
            namesBySet[set.id] = [:]
            saveNames(for: set.id)
            // Keep download registrations only for photos that remain.
            let previousRegistered = registeredBySet[set.id] ?? []
            registeredBySet[set.id] = previousRegistered.intersection(keepIDs)
            saveRegisteredDownloads(for: set.id)
            // Drop in-memory images for removed photos.
            let imagePrefix = "\(set.id)/"
            images = images.filter { key, _ in
                guard key.hasPrefix(imagePrefix) else { return true }
                // key shape: "{setId}/{photoID}/{variant}"
                let rest = key.dropFirst(imagePrefix.count)
                let photoID = rest.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
                return keepIDs.contains(photoID)
            }
            pruneStaleImageFiles(setId: set.id, keepPhotoIDs: keepIDs)
            // New set has palette: nil — allow generatePaletteIfNeeded to run again.
            paletteExtractionAttempted.remove(set.id)
        } else {
            namesBySet[set.id] = namesBySet[set.id] ?? [:]
            registeredBySet[set.id] = registeredBySet[set.id] ?? []
        }

        if !pool.isEmpty {
            poolFetchedAt[set.id] = Date()
            savePool(for: set.id)
            if photoTags != nil {
                savePhotoTags(for: set.id)
            }
        }
        syncDefaultPool()
    }

    /// Test alias for `registerSet`.
    public func registerSetForTesting(
        _ set: ScenerySet,
        pool: [SceneryPhoto] = [],
        photoTags: [String: SceneryPhotoTags]? = nil,
        replacePoolResidue: Bool = false
    ) {
        registerSet(
            set, pool: pool, photoTags: photoTags, replacePoolResidue: replacePoolResidue)
    }

    /// Removes on-disk cached images for photos no longer in the pool.
    private func pruneStaleImageFiles(setId: String, keepPhotoIDs: Set<String>) {
        let imagesDirectory = setDirectory(setId).appendingPathComponent(
            "images", isDirectory: true)
        let files =
            (try? FileManager.default.contentsOfDirectory(
                at: imagesDirectory,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles])) ?? []
        for file in files {
            let name = file.lastPathComponent
            // Files look like "{photoID}-thumb.jpg" or "{photoID}-hero-w{N}.jpg".
            let photoID: String
            if let range = name.range(of: "-thumb.") {
                photoID = String(name[..<range.lowerBound])
            } else if let range = name.range(of: "-hero-") {
                photoID = String(name[..<range.lowerBound])
            } else {
                continue
            }
            if !keepPhotoIDs.contains(photoID) {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    public enum DeleteSetError: Error, LocalizedError, Equatable {
        case notFound
        case builtinProtected
        public var errorDescription: String? {
            switch self {
            case .notFound: "That scenery set was not found."
            case .builtinProtected: "Built-in scenery sets cannot be deleted."
            }
        }
    }

    /// Removes a custom set: registry entry, on-disk directory, project prefs
    /// pointing at it, and thread assignments for that set (so those threads
    /// lazily re-resolve photos from the default set). Builtin sets are refused.
    public func deleteCustomSet(id: String) throws {
        guard let existing = set(id: id) else { throw DeleteSetError.notFound }
        guard existing.origin == .custom else { throw DeleteSetError.builtinProtected }

        availableSets.removeAll { $0.id == id }
        paletteExtractionAttempted.remove(id)
        pools[id] = nil
        photoTagsBySet[id] = nil
        poolFetchedAt[id] = nil
        namesBySet[id] = nil
        registeredBySet[id] = nil
        let imagePrefix = "\(id)/"
        images = images.filter { !$0.key.hasPrefix(imagePrefix) }

        if settings.defaultSetId == id {
            settings.defaultSetId = ScenerySet.dolomitesID
            saveSettings()
        }

        var prefsChanged = false
        for (path, prefs) in projectPrefs where prefs.setId == id {
            var next = prefs
            next.setId = nil
            projectPrefs[path] = next
            prefsChanged = true
        }
        if prefsChanged { saveProjectPrefs() }

        // Drop assignments owned by the deleted set so photo(for:) falls through
        // to the resolved default pool (lazy reassignment).
        let before = assignments.count
        assignments = assignments.filter { $0.value.resolvedSetId != id }
        if assignments.count != before {
            saveAssignments()
        }

        let dir = setDirectory(id)
        // Surface real disk failures to callers (Settings shows an alert).
        // Skip when the directory is already gone so re-delete is clean.
        if FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.removeItem(at: dir)
        }
        syncDefaultPool()
    }

    /// Forces a disk reload (migration + registry) without network refresh.
    public func reloadFromDiskForTesting() {
        startTask = nil
        pool = []
        availableSets = []
        assignments = [:]
        namesBySet = [:]
        pools = [:]
        photoTagsBySet = [:]
        poolFetchedAt = [:]
        registeredBySet = [:]
        images = [:]
        paletteExtractionAttempted = []
        loadFromDisk()
    }

    func photoTagsForTesting(setId: String) -> [String: SceneryPhotoTags] {
        photoTagsBySet[setId] ?? [:]
    }
}

extension AppModel {
    /// Scene-aware thread creation: reserves the next pool photo from the
    /// project's resolved set, names the thread after it, and commits the
    /// assignment once the backend confirms.
    @discardableResult
    public func createSceneThread(
        projectID: String,
        provider: ProviderKind,
        scenery: SceneryStore,
        scenerySetId: String? = nil
    ) async -> ChatThread? {
        // First launch races the initial pool fetch; start() is idempotent and
        // waits for it, so early threads still get a scene name + assignment.
        await scenery.start()
        let projectPath = projects.first(where: { $0.id == projectID })?.path
        let scene = scenery.peekNextScene(
            projectPath: projectPath,
            setIdOverride: scenerySetId)
        let sceneTitle = scene.map { scenery.threadTitle(for: $0) }
        let thread = await createThread(
            projectID: projectID, provider: provider, title: sceneTitle)
        if let thread, let scene, let sceneTitle {
            scenery.assign(
                photoID: scene.id,
                name: sceneTitle,
                to: thread.id,
                projectPath: projectPath,
                setIdOverride: scenerySetId)
        }
        return thread
    }
}

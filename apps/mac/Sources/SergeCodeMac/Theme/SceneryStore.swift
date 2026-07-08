import AppKit
import Observation
import SwiftUI

/// Owns the app's alpine identity photos: a small pool of Dolomites
/// photographs fetched once from Unsplash and cached on disk, a stable
/// thread → photo assignment (each thread keeps "its" scene and the name
/// derived from it), and an in-memory NSImage cache for the views.
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

    public private(set) var pool: [SceneryPhoto] = []
    private var assignments: [String: String] = [:]  // threadID -> photoID
    /// threadID -> scene display name committed at creation ("Seceda").
    /// Kept locally because the server title becomes the AI-generated thread
    /// description after the first turn (see LiveBackend's titleSeed).
    private var names: [String: String] = [:]
    private var images: [String: NSImage] = [:]  // "photoID/variant" -> image
    private var loadingKeys: Set<String> = []
    /// Photos whose download_location was already pinged (persisted so the
    /// guideline ping happens once per photo, not once per launch).
    private var registeredDownloads: Set<String> = []

    private let client: UnsplashClient?
    private let root: URL

    /// Pixel width heroes are fetched and cached at: the widest attached
    /// screen's pixel width (so full-screen never upscales), capped to keep
    /// download size and decode memory sane. `urls.regular` is only 1080w —
    /// blurry the moment it stretches across a retina display.
    private let heroPixelWidth: Int

    /// Search queries the pool is built from, most-wanted first.
    private static let queries: [(query: String, take: Int)] = [
        ("dolomites italy mountains", 12),
        ("alpine meadow dolomites", 8),
        ("italian alps grass field", 6),
    ]
    private static let poolCap = 24
    private static let poolMaxAge: TimeInterval = 14 * 24 * 3600

    /// Dolomites place names paired with pool photos in fetch order. Curated
    /// because Unsplash alt text ("green grass field near mountain…") makes a
    /// poor thread title.
    private static let sceneNames: [String] = [
        "Tre Cime", "Seceda", "Alpe di Siusi", "Lago di Braies", "Marmolada",
        "Sassolungo", "Cadini di Misurina", "Passo Giau", "Cinque Torri",
        "Val Gardena", "Croda da Lago", "Odle Ridge", "Fanes Meadow",
        "Puez Alm", "Sciliar", "Latemar", "Catinaccio", "Passo Pordoi",
        "Sella Towers", "Passo Falzarego", "Val di Funes", "Monte Paterno",
        "Croda Rossa", "Piz Boè", "Sass de Putia", "Vajolet Towers",
        "Passo Rolle", "Pale di San Martino", "Brenta Ridge", "Piz Duleda",
    ]

    public init(client: UnsplashClient? = UnsplashClient()) {
        self.client = client
        let widestScreen =
            NSScreen.screens
            .map { $0.frame.width * $0.backingScaleFactor }
            .max() ?? 2560
        heroPixelWidth = min(Int(widestScreen.rounded()), 3840)
        let support =
            FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? FileManager.default.temporaryDirectory
        root = support.appendingPathComponent("SergeCode/scenery", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: root.appendingPathComponent("images"), withIntermediateDirectories: true)
    }

    // MARK: - Lifecycle

    private var startTask: Task<Void, Never>?

    /// Load the cached pool, then refresh from the API when empty or stale.
    /// Idempotent: concurrent callers share one load, so code that needs the
    /// pool (scene-thread creation on first launch) can await readiness by
    /// calling this again.
    public func start() async {
        if startTask == nil {
            startTask = Task {
                loadFromDisk()
                let stale =
                    poolFetchedAt.map { Date().timeIntervalSince($0) > Self.poolMaxAge } ?? true
                if pool.isEmpty || stale {
                    await refreshPool()
                }
            }
        }
        await startTask?.value
    }

    // MARK: - Assignment & naming

    /// The scene bound to a thread. Explicit assignment first (threads
    /// created in-app); stable hash fallback for threads that predate the
    /// scenery system or were created elsewhere.
    public func photo(for threadID: String) -> SceneryPhoto? {
        guard !pool.isEmpty else { return nil }
        if let photoID = assignments[threadID], let photo = pool.first(where: { $0.id == photoID }) {
            return photo
        }
        return pool[AlpineTheme.stableIndex(threadID, pool.count)]
    }

    /// The scene the next created thread will get: the least-used pool photo
    /// (pool order breaks ties), so backgrounds spread out before repeating.
    /// Pure — safe to call for previews; `assign` commits it.
    public func peekNextScene() -> SceneryPhoto? {
        guard !pool.isEmpty else { return nil }
        var useCount: [String: Int] = [:]
        for photoID in assignments.values {
            useCount[photoID, default: 0] += 1
        }
        return pool.min { (useCount[$0.id] ?? 0) < (useCount[$1.id] ?? 0) }
    }

    /// Thread title for a scene: the plain place name, even when reused.
    public func threadTitle(for photo: SceneryPhoto) -> String {
        Self.baseSceneName(photo.name)
    }

    /// Commit a thread → photo binding (after the backend confirmed create),
    /// remembering the scene display name the thread was created under.
    public func assign(photoID: String, name: String, to threadID: String) {
        assignments[threadID] = photoID
        names[threadID] = Self.baseSceneName(name)
        saveAssignments()
        saveNames()
    }

    /// Stable scene name for a thread ("Seceda"). Falls back to the
    /// assigned/hashed photo's base name for threads that predate the name map
    /// or were created by another client.
    public func sceneName(for threadID: String) -> String? {
        if let name = names[threadID] {
            return Self.baseSceneName(name)
        }
        return photo(for: threadID).map { Self.baseSceneName($0.name) }
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

    private static func baseSceneName(_ name: String) -> String {
        for base in sceneNames.sorted(by: { $0.count > $1.count }) {
            if name == base || isLegacyNumberedSceneTitle(name, base: base) {
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

    /// Empty-state hero: rotates daily through the pool.
    public func dailyFeatured() -> SceneryPhoto? {
        guard !pool.isEmpty else { return nil }
        let day = Calendar.current.ordinality(of: .day, in: .year, for: Date()) ?? 0
        return pool[day % pool.count]
    }

    // MARK: - Images

    /// Cached image, if already decoded this session. Views pair this with
    /// `ensureImage` in a `.task`.
    public func image(_ photo: SceneryPhoto, variant: ImageVariant) -> NSImage? {
        images[cacheKey(photo.id, variant)]
    }

    /// Load a photo's image into the in-memory cache: disk first, CDN on
    /// miss (writing back to disk). Safe to call repeatedly.
    public func ensureImage(_ photo: SceneryPhoto?, variant: ImageVariant) async {
        guard let photo else { return }
        let key = cacheKey(photo.id, variant)
        guard images[key] == nil, !loadingKeys.contains(key) else { return }
        loadingKeys.insert(key)
        defer { loadingKeys.remove(key) }

        let fileURL = root.appendingPathComponent("images/\(fileName(photo.id, variant))")
        var data = await Task.detached { try? Data(contentsOf: fileURL) }.value
        if data == nil, let client {
            let remote = remoteURL(for: photo, variant: variant)
            data = try? await client.fetchImageData(from: remote)
            if let data {
                await Task.detached { try? data.write(to: fileURL, options: .atomic) }.value
                if let ping = photo.downloadLocationURL, !registeredDownloads.contains(photo.id) {
                    registeredDownloads.insert(photo.id)
                    saveRegisteredDownloads()
                    await client.registerDownload(ping)
                }
            }
        }
        if let data, let image = NSImage(data: data) {
            images[key] = image
        }
    }

    private func cacheKey(_ photoID: String, _ variant: ImageVariant) -> String {
        "\(photoID)/\(variant.rawValue)"
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

    private func refreshPool() async {
        guard let client else { return }
        var fetched: [UnsplashClient.APIPhoto] = []
        for (query, take) in Self.queries {
            guard let results = try? await client.searchPhotos(query: query, count: take)
            else { continue }
            fetched.append(contentsOf: results)
        }
        var seen: Set<String> = []
        let unique = fetched.filter { seen.insert($0.id).inserted }.prefix(Self.poolCap)
        guard !unique.isEmpty else { return }

        let refreshed = unique.enumerated().map { index, photo in
            let base = Self.sceneNames[index % Self.sceneNames.count]
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
        // Carry over photos still assigned to threads but missing from the new
        // results, so a refresh never swaps an existing thread's scene out from
        // under its scene-derived title.
        let refreshedIDs = Set(refreshed.map(\.id))
        let assignedIDs = Set(assignments.values)
        let kept = pool.filter { assignedIDs.contains($0.id) && !refreshedIDs.contains($0.id) }
        pool = refreshed + kept
        poolFetchedAt = Date()
        savePool()
        // Drop stale decoded images from a previous pool.
        images = [:]
    }

    // MARK: - Persistence

    private var poolFetchedAt: Date?

    private struct PoolFile: Codable {
        var fetchedAt: Date
        var photos: [SceneryPhoto]
    }

    private var poolURL: URL { root.appendingPathComponent("pool.json") }
    private var assignmentsURL: URL { root.appendingPathComponent("assignments.json") }
    private var namesURL: URL { root.appendingPathComponent("names.json") }
    private var registeredURL: URL { root.appendingPathComponent("registered-downloads.json") }

    private func loadFromDisk() {
        if let data = try? Data(contentsOf: poolURL),
            let file = try? JSONDecoder().decode(PoolFile.self, from: data)
        {
            pool = file.photos
            poolFetchedAt = file.fetchedAt
        }
        if let data = try? Data(contentsOf: assignmentsURL),
            let map = try? JSONDecoder().decode([String: String].self, from: data)
        {
            assignments = map
        }
        if let data = try? Data(contentsOf: namesURL),
            let map = try? JSONDecoder().decode([String: String].self, from: data)
        {
            names = map
        }
        if let data = try? Data(contentsOf: registeredURL),
            let ids = try? JSONDecoder().decode(Set<String>.self, from: data)
        {
            registeredDownloads = ids
        }
    }

    private func savePool() {
        guard let fetchedAt = poolFetchedAt else { return }
        let file = PoolFile(fetchedAt: fetchedAt, photos: pool)
        if let data = try? JSONEncoder().encode(file) {
            try? data.write(to: poolURL, options: .atomic)
        }
    }

    private func saveAssignments() {
        if let data = try? JSONEncoder().encode(assignments) {
            try? data.write(to: assignmentsURL, options: .atomic)
        }
    }

    private func saveNames() {
        if let data = try? JSONEncoder().encode(names) {
            try? data.write(to: namesURL, options: .atomic)
        }
    }

    private func saveRegisteredDownloads() {
        if let data = try? JSONEncoder().encode(registeredDownloads) {
            try? data.write(to: registeredURL, options: .atomic)
        }
    }
}

extension AppModel {
    /// Scene-aware thread creation: reserves the next pool photo, names the
    /// thread after it, and commits the assignment once the backend confirms.
    public func createSceneThread(
        projectID: String, provider: ProviderKind, scenery: SceneryStore
    ) async {
        // First launch races the initial pool fetch; start() is idempotent and
        // waits for it, so early threads still get a scene name + assignment.
        await scenery.start()
        let scene = scenery.peekNextScene()
        let sceneTitle = scene.map { scenery.threadTitle(for: $0) }
        let thread = await createThread(
            projectID: projectID, provider: provider, title: sceneTitle)
        if let thread, let scene, let sceneTitle {
            scenery.assign(photoID: scene.id, name: sceneTitle, to: thread.id)
        }
    }
}

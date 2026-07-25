import AppKit
import CoreImage
import ImageIO
import Observation
import SwiftUI

/// Owns the app's scenery identity photos: the builtin World set (24 curated
/// locations; every new thread draws one random photo from it), a stable
/// thread → photo assignment (each thread keeps "its" scene and the name
/// derived from it), and an in-memory NSImage cache for the views. Legacy
/// set directories still on disk are loaded too, so threads assigned to a
/// pre-World set keep rendering their photo.
///
/// Disk layout (`~/Library/Application Support/SergeCode/scenery/`):
/// - `assignments.json` — global thread → { photoID, setId? }
/// - `settings.json` — `{ sceneryTranslucency }`
/// - `project-prefs.json` — projectPath → `{ accentHex?, sfSymbol? }`
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
        case heroBlurChat  // memory-only blur of the decoded hero for chat
        case heroBlurChrome  // memory-only blur of the decoded hero for chrome
    }

    /// World set's pool (kept for observation / source compatibility).
    /// Prefer `photo(for:)` which resolves the correct per-thread set.
    public private(set) var pool: [SceneryPhoto] = []
    /// Loaded set manifests (builtin World + legacy sets still on disk).
    public private(set) var availableSets: [ScenerySet] = []

    /// threadID → assignment (photo + owning set).
    private var assignments: [String: SceneryAssignment] = [:]
    /// The photo the next created thread will get. Sampled lazily by
    /// `peekNextScene()` so the New Session preview and the actual commit
    /// always agree; cleared by `assign(...)` (commit) and re-sampled when a
    /// pool refresh no longer contains it.
    private var pendingScene: SceneryPhoto?
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
    /// "setId/photoID" pairs whose registration ping is currently in flight.
    /// Claimed before the ping suspends so concurrent ensureImage calls for
    /// different variants of one photo can't double-ping download_location.
    private var registrationClaims: Set<String> = []

    private var images: [String: NSImage] = [:]  // "setId/photoID/variant" -> image
    /// Insertion order of the hero/blur keys in `images`, for FIFO eviction.
    private var heavyImageCacheOrder: [String] = []
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
    /// tracks these stores so surfaces that call `dailyFeatured()` (which
    /// reads them) invalidate when the bucket flips — without polling or
    /// per-frame date reads, and without notifying views that never touch
    /// rotation state.
    public private(set) var rotationBucket: SceneryBucket
    /// Day identity used by `dailyFeatured()` (year + ordinal). Public so
    /// views can also depend on day rollover explicitly if needed.
    public private(set) var rotationDayKey: String

    /// Pixel width heroes are fetched and cached at: the widest attached
    /// screen's pixel width (so full-screen never upscales), capped to keep
    /// download size and decode memory sane. `urls.regular` is only 1080w —
    /// blurry the moment it stretches across a retina display.
    private let heroPixelWidth: Int
    /// Backing scale used when computing `heroPixelWidth`; Core Image blur
    /// radii are specified in pixels while the old SwiftUI radii were points.
    private let heroBackingScale: CGFloat

    private static let poolCap = 24
    /// Cap on cached hero + blur entries. Each is a full-screen bitmap
    /// (~30-40MB decoded; a visited thread holds hero + 2 blurs ≈ 100MB), so
    /// an unbounded cache grows memory monotonically across threads. 8 keeps
    /// the active thread's trio plus a couple of recently visited threads;
    /// thumbs are ~200px and stay unbounded.
    private static let heavyImageCacheCap = 8
    private static let poolMaxAge: TimeInterval = 14 * 24 * 3600
    /// Tuned by eye to match the previous SwiftUI `.blur(radius: 4/9,
    /// opaque: true)` plus saturation; these may be adjusted by eye.
    private static let heroBlurChatRadiusPoints: CGFloat = 4
    private static let heroBlurChromeRadiusPoints: CGFloat = 9
    private static let heroBlurChatSaturation: CGFloat = 1.05
    private static let heroBlurChromeSaturation: CGFloat = 1.08
    /// A single shared context avoids creating an expensive Core Image
    /// context for every wallpaper variant.
    nonisolated private static let heroBlurContext = CIContext()

    /// Debounced `settings.json` write (translucency slider ticks).
    @ObservationIgnored
    private var pendingSettingsSaveTask: Task<Void, Never>?

    public init(client: UnsplashClient? = UnsplashClient(), root: URL? = nil) {
        self.client = client
        let now = Date()
        let calendar = Calendar.autoupdatingCurrent
        rotationBucket = SceneryBucket.compute(for: now, calendar: calendar)
        rotationDayKey = Self.dayKey(for: now, calendar: calendar)
        let screenMetrics = NSScreen.screens.map {
            ($0.frame.width * $0.backingScaleFactor, $0.backingScaleFactor)
        }
        let widestScreen = screenMetrics.max { $0.0 < $1.0 }
        heroPixelWidth = min(Int((widestScreen?.0 ?? 2560).rounded()), 3840)
        heroBackingScale = widestScreen?.1 ?? 1
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

    nonisolated private static func decodeImage(data: Data, maxPixelWidth: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelWidth,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    nonisolated private static func makeBlurredImage(
        from cgImage: CGImage,
        radiusPoints: CGFloat,
        saturation: CGFloat,
        backingScale: CGFloat
    ) -> CGImage? {
        let input = CIImage(cgImage: cgImage)
        let originalExtent = input.extent
        guard let blur = CIFilter(name: "CIGaussianBlur"),
            let colorControls = CIFilter(name: "CIColorControls")
        else { return nil }

        blur.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
        blur.setValue(radiusPoints * backingScale, forKey: kCIInputRadiusKey)
        guard let blurred = blur.outputImage else { return nil }

        colorControls.setValue(blurred, forKey: kCIInputImageKey)
        colorControls.setValue(saturation, forKey: kCIInputSaturationKey)
        guard let saturated = colorControls.outputImage else { return nil }

        return heroBlurContext.createCGImage(
            saturated.cropped(to: originalExtent),
            from: originalExtent)
    }

    // MARK: - Set resolution

    /// Resolves the set for a thread: its assignment when one exists (legacy
    /// assignments keep pointing at their original set), else the World set.
    public func resolvedSetId(forThread threadID: String) -> String {
        if let assignment = assignments[threadID] {
            return assignment.resolvedSetId
        }
        return ScenerySet.worldID
    }

    public func set(id: String) -> ScenerySet? {
        availableSets.first { $0.id == id }
    }

    /// Photos currently registered for a set (may be empty before first fetch).
    public func photos(forSetId setId: String) -> [SceneryPhoto] {
        pools[setId] ?? []
    }

    /// Palette for a resolved set. An explicit set id wins; otherwise the
    /// photo's owning set and then the World set are used.
    public func palette(for photo: SceneryPhoto?, setId: String? = nil) -> SceneryPalette? {
        let owner =
            setId
            ?? photo.flatMap { setIdContaining(photoID: $0.id) }
            ?? ScenerySet.worldID
        return set(id: owner)?.palette
    }

    /// Opacity of scenery photo layers and solidifying strength of the
    /// behind-window glass (`0.5...1.0`). Global appearance setting;
    /// live-observed by wallpaper views and `WindowGlassBackground`.
    public var sceneryTranslucency: Double {
        settings.sceneryTranslucency
    }

    public func projectPrefs(for path: String) -> ProjectSceneryPrefs? {
        projectPrefs[path]
    }

    // MARK: - Assignment & naming

    /// The scene bound to a thread. Explicit assignment first (threads
    /// created in-app); stable hash fallback over the World pool for threads
    /// that predate the scenery system, were created elsewhere, or whose
    /// assigned photo is no longer in any pool (deleted/missing legacy set).
    public func photo(for threadID: String) -> SceneryPhoto? {
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
        let worldPool = pools[ScenerySet.worldID] ?? []
        guard !worldPool.isEmpty else { return nil }
        return worldPool[AlpineTheme.stableIndex(threadID, worldPool.count)]
    }

    /// The scene the next created thread will get: a uniformly random photo
    /// from the World pool. The first call samples and remembers the pick in
    /// `pendingScene`, so the preview (`NewSessionSheet`) and the actual
    /// commit (`AppModel.createSceneThread`, which calls this once and reuses
    /// the returned `SceneryPhoto` for both the title and the `assign` call)
    /// always agree. `assign(...)` clears the pending pick; a pool refresh
    /// that no longer contains it re-samples on the next call.
    public func peekNextScene() -> SceneryPhoto? {
        let worldPool = pools[ScenerySet.worldID] ?? []
        if let pendingScene, worldPool.contains(where: { $0.id == pendingScene.id }) {
            return pendingScene
        }
        let pick = worldPool.randomElement()
        pendingScene = pick
        return pick
    }

    /// Thread title for a scene: the curated place name, verbatim.
    public func threadTitle(for photo: SceneryPhoto) -> String {
        photo.name
    }

    /// Commit a thread → photo binding (after the backend confirmed create),
    /// remembering the scene display name the thread was created under.
    public func assign(
        photoID: String,
        name: String,
        to threadID: String
    ) {
        pendingScene = nil
        let setId = setIdContaining(photoID: photoID) ?? ScenerySet.worldID
        assignments[threadID] = SceneryAssignment(
            photoID: photoID,
            setId: setId == ScenerySet.worldID ? nil : setId)
        var names = namesBySet[setId] ?? [:]
        names[threadID] = name
        namesBySet[setId] = names
        saveAssignments()
        saveNames(for: setId)
    }

    /// Stable scene name for a thread ("Kyoto, Japan"). Falls back to the
    /// assigned/hashed photo's name for threads that predate the name map
    /// or were created by another client.
    public func sceneName(for threadID: String) -> String? {
        let setId = resolvedSetId(forThread: threadID)
        if let name = namesBySet[setId]?[threadID] {
            return name
        }
        // Scan other sets' name maps (legacy threads after migration).
        for (_, names) in namesBySet {
            if let name = names[threadID] {
                return name
            }
        }
        return photo(for: threadID)?.name
    }

    /// Two-line naming for a thread: the scene place name as the stable
    /// primary name, plus the server title as the descriptive second line
    /// once first-turn title generation has replaced the scene seed.
    public func displayNames(
        for thread: ChatThread, threadKey: String? = nil
    ) -> (primary: String, description: String?) {
        let key = threadKey ?? thread.id
        let title = thread.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let scene = sceneName(for: key) else {
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
    /// the World pool's preferred subset.
    public func dailyFeatured() -> SceneryPhoto? {
        let setPool = pools[ScenerySet.worldID] ?? []
        let seed = [
            "daily", ScenerySet.worldID, rotationDayKey, rotationBucket.timeOfDay.rawValue,
            rotationBucket.season.rawValue,
        ].joined(separator: "|")
        return SceneryPhotoSelection.select(
            photos: setPool,
            tagsByPhotoID: photoTagsBySet[ScenerySet.worldID] ?? [:],
            bucket: rotationBucket,
            seed: seed)
    }

    // MARK: - Images

    /// Cached image, if already decoded this session. Views pair this with
    /// `ensureImage` in a `.task`.
    public func image(
        _ photo: SceneryPhoto,
        variant: ImageVariant,
        setId explicitSetId: String? = nil
    ) -> NSImage? {
        let setId = explicitSetId ?? setIdContaining(photoID: photo.id) ?? ScenerySet.worldID
        return images[cacheKey(setId, photo.id, variant)]
    }

    /// Load a photo's image into the in-memory cache: disk first, CDN on
    /// miss (writing back to disk). Safe to call repeatedly.
    public func ensureImage(
        _ photo: SceneryPhoto?,
        variant: ImageVariant,
        setId explicitSetId: String? = nil
    ) async {
        await ensureImage(
            photo,
            variant: variant,
            setId: explicitSetId,
            triggerPaletteBackfill: true)
    }

    private func waitForImageLoad(_ key: String) async {
        while loadingKeys.contains(key), !Task.isCancelled {
            do {
                try await Task.sleep(for: .milliseconds(1))
            } catch {
                return
            }
        }
    }

    /// Inserts into the decoded-image cache. Hero and blur variants are
    /// bounded FIFO (`heavyImageCacheCap`): past the cap the oldest heavy
    /// entries are dropped and re-decode from disk on their next ensureImage.
    private func cacheImage(_ image: NSImage, forKey key: String, variant: ImageVariant) {
        images[key] = image
        guard variant != .thumb else { return }
        heavyImageCacheOrder.append(key)
        let overflow = heavyImageCacheOrder.count - Self.heavyImageCacheCap
        guard overflow > 0 else { return }
        for evictedKey in heavyImageCacheOrder.prefix(overflow) {
            images[evictedKey] = nil
        }
        heavyImageCacheOrder.removeFirst(overflow)
    }

    private func ensureImage(
        _ photo: SceneryPhoto?,
        variant: ImageVariant,
        setId explicitSetId: String? = nil,
        triggerPaletteBackfill: Bool
    ) async {
        guard let photo else { return }
        let setId = explicitSetId ?? setIdContaining(photoID: photo.id) ?? ScenerySet.worldID
        let key = cacheKey(setId, photo.id, variant)
        guard images[key] == nil, !loadingKeys.contains(key) else { return }
        loadingKeys.insert(key)
        defer { loadingKeys.remove(key) }

        if variant == .heroBlurChat || variant == .heroBlurChrome {
            // Derived variants are memory-only. Load the decoded hero through
            // the normal path first, then rasterize the requested treatment
            // once off the main actor.
            await ensureImage(
                photo,
                variant: .hero,
                setId: setId,
                triggerPaletteBackfill: false)
            let heroKey = cacheKey(setId, photo.id, .hero)
            if images[heroKey] == nil {
                // Chat and chrome can request different derived variants at
                // the same time; wait for the deduplicated hero load instead
                // of letting the second variant miss permanently.
                await waitForImageLoad(heroKey)
            }
            guard let heroImage = images[heroKey],
                let heroCGImage = heroImage.cgImage(
                    forProposedRect: nil,
                    context: nil,
                    hints: nil)
            else { return }

            let radiusPoints: CGFloat
            let saturation: CGFloat
            switch variant {
            case .heroBlurChat:
                radiusPoints = Self.heroBlurChatRadiusPoints
                saturation = Self.heroBlurChatSaturation
            case .heroBlurChrome:
                radiusPoints = Self.heroBlurChromeRadiusPoints
                saturation = Self.heroBlurChromeSaturation
            case .hero, .thumb:
                return
            }

            let backingScale = heroBackingScale
            let blurredCGImage = await Task.detached(priority: .userInitiated) {
                Self.makeBlurredImage(
                    from: heroCGImage,
                    radiusPoints: radiusPoints,
                    saturation: saturation,
                    backingScale: backingScale)
            }.value
            if let blurredCGImage {
                cacheImage(
                    NSImage(
                        cgImage: blurredCGImage,
                        size: NSSize(
                            width: CGFloat(blurredCGImage.width),
                            height: CGFloat(blurredCGImage.height))),
                    forKey: key,
                    variant: variant)
                if triggerPaletteBackfill {
                    await generatePaletteIfNeeded(for: setId)
                }
            }
            return
        }

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
        let maxPixelWidth = variant == .hero ? heroPixelWidth : 512
        if let data {
            let cgImage = await Task.detached(priority: .userInitiated) {
                let startedAt = PerfLog.now()
                let decoded = Self.decodeImage(data: data, maxPixelWidth: maxPixelWidth)
                PerfLog.event(
                    "scenery.decode",
                    ms: PerfLog.elapsedMilliseconds(since: startedAt),
                    details: "pixel_width=\(maxPixelWidth)")
                return decoded
            }.value
            if let cgImage {
                cacheImage(
                    NSImage(
                        cgImage: cgImage,
                        size: NSSize(width: CGFloat(cgImage.width), height: CGFloat(cgImage.height))),
                    forKey: key,
                    variant: variant)
                if triggerPaletteBackfill {
                    await generatePaletteIfNeeded(for: setId)
                }
            }
        }
    }

    /// Extracts and persists a set's palette once. Startup and image loads
    /// use existing disk files as a lazy backfill. Bitmap work stays off the
    /// main actor.
    ///
    /// Failed extractions are not retried this launch (in-memory attempt marker).
    /// Missing sample files still allow a later retry once images land on disk.
    public func generatePaletteIfNeeded(for setId: String, downloadSamples: Bool = false) async {
        guard let manifest = set(id: setId),
            manifest.palette == nil, !paletteExtractionAttempted.contains(setId)
        else { return }

        paletteExtractionAttempted.insert(setId)

        if downloadSamples {
            let samplePhotos = Array((pools[setId] ?? []).prefix(
                SceneryPaletteExtractor.maximumImageCount))
            for photo in samplePhotos {
                guard !Task.isCancelled else { return }
                await ensureImage(
                    photo,
                    variant: .thumb,
                    setId: setId,
                    triggerPaletteBackfill: false)
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
        case .heroBlurChat, .heroBlurChrome:
            preconditionFailure("Blurred scenery variants are memory-only")
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
        case .heroBlurChat, .heroBlurChrome:
            preconditionFailure("Blurred scenery variants are memory-only")
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
            // Per-location path (the builtin World set): one photo per curated
            // location, named verbatim after it.
            guard
                let built = try? await SceneryPoolBuilder.buildFromLocations(
                    client: client,
                    locations: locations)
            else { return }
            refreshed = built.photos
            refreshedTags = built.photoTags
        } else {
            // Legacy path (set directories left over from the customizable
            // scenery era): query-pool fetch + sceneNames round-robin so those
            // pools can still top up and legacy assignments keep rendering.
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

            let sceneNames = set.sceneNames.isEmpty ? [set.title] : set.sceneNames
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
        heavyImageCacheOrder.removeAll { $0.hasPrefix(prefix) }
        if setId == ScenerySet.worldID {
            syncDefaultPool()
        }
    }

    /// Test hook for `refreshPool` (stale/empty pool rebuild).
    func refreshPoolForTesting(setId: String) async {
        await refreshPool(for: setId)
    }

    private func syncDefaultPool() {
        pool = pools[ScenerySet.worldID] ?? []
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
        // Ensure the builtin World set is always present even on empty disk.
        if !availableSets.contains(where: { $0.id == ScenerySet.worldID }) {
            let builtin = ScenerySet.makeBuiltinWorldSet()
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
        // Builtin World first for stable UI ordering later.
        loaded.sort { lhs, rhs in
            if lhs.id == ScenerySet.worldID { return true }
            if rhs.id == ScenerySet.worldID { return false }
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
    /// Claims the photo in `registrationClaims` before the ping suspends so
    /// concurrent ensureImage calls (e.g. sidebar thumb + hero) can't both
    /// pass the registered check and double-ping; mutates `registeredBySet`
    /// and disk only on success. Failures leave the photo unregistered
    /// (natural retry) and are not surfaced to the user.
    func registerDownloadIfNeeded(
        setId: String,
        photoId: String,
        downloadLocationURL: URL?,
        register: (URL) async throws -> Void
    ) async {
        guard let ping = downloadLocationURL else { return }
        let claim = "\(setId)/\(photoId)"
        guard registeredBySet[setId]?.contains(photoId) != true,
            !registrationClaims.contains(claim)
        else { return }
        registrationClaims.insert(claim)
        defer { registrationClaims.remove(claim) }
        do {
            try await register(ping)
            registeredBySet[setId, default: []].insert(photoId)
            saveRegisteredDownloads(for: setId)
        } catch {
            // Transient ping failure — retry on a later ensureImage.
        }
    }

    /// Test helper: photo IDs already recorded as download-registered for a set.
    func registeredDownloadIDsForTesting(setId: String) -> Set<String> {
        registeredBySet[setId] ?? []
    }

    // MARK: - Settings & project prefs

    /// Writes project-prefs (accent / symbol badges).
    public func setProjectPrefs(_ prefs: ProjectSceneryPrefs, forProjectPath path: String) {
        projectPrefs[path] = prefs
        saveProjectPrefs()
    }

    /// Updates the global scenery photo opacity (window glass bleed-through).
    /// Values outside `0.5...1.0` are clamped; no-op when unchanged after clamp.
    /// Memory updates immediately; disk write is debounced (~400ms). Call
    /// `flushPendingSettingsSave()` when a continuous edit ends (e.g. slider).
    public func setSceneryTranslucency(_ value: Double) {
        let clamped = ScenerySettingsFile.clampTranslucency(value)
        guard settings.sceneryTranslucency != clamped else { return }
        settings.sceneryTranslucency = clamped
        scheduleDebouncedSettingsSave()
    }

    /// Cancels a pending debounced settings write and persists immediately
    /// if one was scheduled. No-op when nothing is pending.
    public func flushPendingSettingsSave() {
        guard pendingSettingsSaveTask != nil else { return }
        commitPendingSettingsSave()
    }

    private func scheduleDebouncedSettingsSave() {
        pendingSettingsSaveTask?.cancel()
        pendingSettingsSaveTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            commitPendingSettingsSave()
        }
    }

    /// Shared by debounce completion and flush: clear pending + one disk write.
    private func commitPendingSettingsSave() {
        pendingSettingsSaveTask?.cancel()
        pendingSettingsSaveTask = nil
        saveSettings()
    }

    /// Test hook: installs a set manifest + pool (and optional photo tags)
    /// into the registry — disk + memory — without any network work.
    func installSetForTesting(
        _ set: ScenerySet,
        pool: [SceneryPhoto],
        photoTags: [String: SceneryPhotoTags]? = nil
    ) {
        if let idx = availableSets.firstIndex(where: { $0.id == set.id }) {
            availableSets[idx] = set
        } else {
            availableSets.append(set)
        }
        saveManifest(set)
        try? FileManager.default.createDirectory(
            at: setDirectory(set.id).appendingPathComponent("images", isDirectory: true),
            withIntermediateDirectories: true)
        pools[set.id] = pool
        photoTagsBySet[set.id] = photoTags ?? [:]
        namesBySet[set.id] = namesBySet[set.id] ?? [:]
        registeredBySet[set.id] = registeredBySet[set.id] ?? []
        if !pool.isEmpty {
            poolFetchedAt[set.id] = Date()
            savePool(for: set.id)
            if photoTags != nil {
                savePhotoTags(for: set.id)
            }
        }
        syncDefaultPool()
    }

    /// Forces a disk reload (migration + registry) without network refresh.
    public func reloadFromDiskForTesting() {
        startTask = nil
        pool = []
        availableSets = []
        assignments = [:]
        pendingScene = nil
        namesBySet = [:]
        pools = [:]
        photoTagsBySet = [:]
        poolFetchedAt = [:]
        registeredBySet = [:]
        images = [:]
        heavyImageCacheOrder = []
        paletteExtractionAttempted = []
        loadFromDisk()
    }

    func photoTagsForTesting(setId: String) -> [String: SceneryPhotoTags] {
        photoTagsBySet[setId] ?? [:]
    }

    /// Test hook: the pending next-thread pick, so preview/commit consistency
    /// can be asserted without depending on random sampling.
    var pendingSceneIDForTesting: String? {
        pendingScene?.id
    }
}

extension AppModel {
    /// Scene-aware thread creation: reserves the pending World-pool photo,
    /// names the thread after it, and commits the assignment once the backend
    /// confirms.
    @discardableResult
    public func createSceneThread(
        projectID: String,
        provider: ProviderKind,
        scenery: SceneryStore
    ) async -> ChatThread? {
        // First launch races the initial pool fetch; start() is idempotent and
        // waits for it, so early threads still get a scene name + assignment.
        await scenery.start()
        let scene = scenery.peekNextScene()
        let sceneTitle = scene.map { scenery.threadTitle(for: $0) }
        let thread = await createThread(
            projectID: projectID, provider: provider, title: sceneTitle)
        if let thread, let scene, let sceneTitle {
            let threadKey = scopedThreadKey(thread.id)
            scenery.assign(
                photoID: scene.id,
                name: sceneTitle,
                to: threadKey)
        }
        return thread
    }
}

import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Scenery assignment decoding")
struct SceneryAssignmentDecodingTests {
    @Test("legacy bare photo-id string decodes with nil setId")
    func legacyStringValue() throws {
        let json = Data(#""photo-abc""#.utf8)
        let assignment = try JSONDecoder().decode(SceneryAssignment.self, from: json)
        #expect(assignment.photoID == "photo-abc")
        #expect(assignment.setId == nil)
        #expect(assignment.resolvedSetId == ScenerySet.worldID)
    }

    @Test("object form with setId decodes")
    func objectWithSetId() throws {
        let json = Data(#"{"photoID":"p1","setId":"kyoto-3f2a"}"#.utf8)
        let assignment = try JSONDecoder().decode(SceneryAssignment.self, from: json)
        #expect(assignment.photoID == "p1")
        #expect(assignment.setId == "kyoto-3f2a")
        #expect(assignment.resolvedSetId == "kyoto-3f2a")
    }

    @Test("object form without setId defaults resolvedSetId to world")
    func objectWithoutSetId() throws {
        let json = Data(#"{"photoID":"p2"}"#.utf8)
        let assignment = try JSONDecoder().decode(SceneryAssignment.self, from: json)
        #expect(assignment.photoID == "p2")
        #expect(assignment.setId == nil)
        #expect(assignment.resolvedSetId == ScenerySet.worldID)
    }

    @Test("assignments map mixes legacy strings and objects")
    func mixedMap() throws {
        let json = Data(
            #"""
            {
              "t-legacy": "photo-old",
              "t-new": { "photoID": "photo-new", "setId": "kyoto" }
            }
            """#.utf8)
        let map = try JSONDecoder().decode([String: SceneryAssignment].self, from: json)
        #expect(map["t-legacy"]?.photoID == "photo-old")
        #expect(map["t-legacy"]?.setId == nil)
        #expect(map["t-new"]?.photoID == "photo-new")
        #expect(map["t-new"]?.setId == "kyoto")
    }
}

@Suite("Scenery builtin world set")
struct SceneryWorldSetTests {
    @Test("world set curates 224 unique locations with verbatim names and no queries")
    func worldSetShape() {
        let set = ScenerySet.makeBuiltinWorldSet()
        #expect(set.id == "world")
        #expect(set.title == "World")
        #expect(set.origin == .builtin)
        #expect(set.queries.isEmpty)
        #expect(set.sceneNames.isEmpty)

        let locations = try? #require(set.locations)
        #expect(locations?.count == 224)
        #expect(locations?.first?.name == "Santorini, Greece")
        #expect(locations?.first?.query == "santorini greece caldera")
        #expect(locations?.last?.name == "Norfolk Island, Australia")
        #expect(locations?.last?.query == "norfolk island australia coast")
        // Every curated entry carries both a display name and a search query.
        #expect(locations?.allSatisfy { !$0.name.isEmpty && !$0.query.isEmpty } == true)
        #expect(Set(locations?.map(\.name) ?? []).count == 224)
        #expect(Set(locations?.map(\.query) ?? []).count == 224)
    }
}

@Suite("Scenery layout migration")
struct SceneryLayoutMigrationTests {
    private func tempRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-mig-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("legacy files move into sets/dolomites and migration is idempotent")
    func migratesLegacyAndIsIdempotent() throws {
        let fm = FileManager.default
        let root = try tempRoot()
        defer { try? fm.removeItem(at: root) }

        let poolJSON = Data(#"{"fetchedAt":0,"photos":[]}"#.utf8)
        let namesJSON = Data(#"{"thread-1":"Seceda"}"#.utf8)
        let registeredJSON = Data(#"["photo-1"]"#.utf8)
        try poolJSON.write(to: root.appendingPathComponent("pool.json"))
        try namesJSON.write(to: root.appendingPathComponent("names.json"))
        try registeredJSON.write(to: root.appendingPathComponent("registered-downloads.json"))

        let imagesDir = root.appendingPathComponent("images", isDirectory: true)
        try fm.createDirectory(at: imagesDir, withIntermediateDirectories: true)
        let imageFile = imagesDir.appendingPathComponent("photo-1-thumb.jpg")
        try Data([0xFF, 0xD8, 0xFF]).write(to: imageFile)

        // assignments stay global — leave a legacy map at root
        try Data(#"{"thread-1":"photo-1"}"#.utf8)
            .write(to: root.appendingPathComponent("assignments.json"))

        let first = try SceneryLayoutMigration.migrateIfNeeded(root: root)
        #expect(first)

        let dolomites = root.appendingPathComponent("sets/dolomites", isDirectory: true)
        #expect(fm.fileExists(atPath: dolomites.appendingPathComponent("pool.json").path))
        #expect(fm.fileExists(atPath: dolomites.appendingPathComponent("names.json").path))
        #expect(
            fm.fileExists(
                atPath: dolomites.appendingPathComponent("registered-downloads.json").path))
        #expect(
            fm.fileExists(
                atPath: dolomites.appendingPathComponent("images/photo-1-thumb.jpg").path))
        #expect(fm.fileExists(atPath: dolomites.appendingPathComponent("manifest.json").path))

        // Legacy paths gone
        #expect(!fm.fileExists(atPath: root.appendingPathComponent("pool.json").path))
        #expect(!fm.fileExists(atPath: root.appendingPathComponent("names.json").path))
        #expect(
            !fm.fileExists(atPath: root.appendingPathComponent("registered-downloads.json").path))
        #expect(!fm.fileExists(atPath: root.appendingPathComponent("images").path))

        // Global assignments preserved
        #expect(fm.fileExists(atPath: root.appendingPathComponent("assignments.json").path))

        let manifestData = try Data(
            contentsOf: dolomites.appendingPathComponent("manifest.json"))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let manifest = try decoder.decode(ScenerySet.self, from: manifestData)
        #expect(manifest.id == SceneryLayoutMigration.legacyBuiltinSetID)
        #expect(manifest.origin == .builtin)

        // Second run: no legacy left, manifest already present → still safe
        let second = try SceneryLayoutMigration.migrateIfNeeded(root: root)
        #expect(!second)
        #expect(fm.fileExists(atPath: dolomites.appendingPathComponent("pool.json").path))
        #expect(fm.fileExists(atPath: dolomites.appendingPathComponent("images/photo-1-thumb.jpg").path))
    }

    @Test("fresh install with no legacy files synthesizes dolomites manifest")
    func freshInstall() throws {
        let fm = FileManager.default
        let root = try tempRoot()
        defer { try? fm.removeItem(at: root) }

        let changed = try SceneryLayoutMigration.migrateIfNeeded(root: root)
        #expect(changed)

        let manifestURL = root.appendingPathComponent("sets/dolomites/manifest.json")
        #expect(fm.fileExists(atPath: manifestURL.path))
        #expect(fm.fileExists(atPath: root.appendingPathComponent("sets/dolomites/images").path))

        let again = try SceneryLayoutMigration.migrateIfNeeded(root: root)
        #expect(!again)
    }
}

@Suite("SceneryStore world pool")
@MainActor
struct SceneryStoreWorldPoolTests {
    private func tempRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func samplePhoto(id: String, name: String) -> SceneryPhoto {
        SceneryPhoto(
            id: id,
            name: name,
            averageColorHex: "#112233",
            heroURL: URL(string: "https://example.com/\(id)-hero.jpg")!,
            thumbURL: URL(string: "https://example.com/\(id)-thumb.jpg")!,
            rawURL: nil,
            downloadLocationURL: nil,
            photographerName: "Tester",
            photographerProfileURL: nil)
    }

    private func worldPool() -> [SceneryPhoto] {
        [
            samplePhoto(id: "w1", name: "Kyoto, Japan"),
            samplePhoto(id: "w2", name: "Petra, Jordan"),
            samplePhoto(id: "w3", name: "Lake Bled, Slovenia"),
        ]
    }

    @Test("persisted builtin manifest upgrades to the current catalog")
    func upgradesPersistedBuiltinManifest() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let worldDirectory = root.appendingPathComponent("sets/world", isDirectory: true)
        try FileManager.default.createDirectory(
            at: worldDirectory, withIntermediateDirectories: true)
        var oldManifest = ScenerySet.makeBuiltinWorldSet()
        oldManifest.locations = Array(oldManifest.locations?.prefix(24) ?? [])
        oldManifest.palette = SceneryPalette(
            accentHex: "#112233",
            washes: [["#010203", "#040506"]])
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(oldManifest)
            .write(to: worldDirectory.appendingPathComponent("manifest.json"))

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()

        let upgraded = try #require(store.set(id: ScenerySet.worldID))
        #expect(upgraded.locations == WorldSceneryCatalog.locations)
        #expect(upgraded.palette == oldManifest.palette)
    }

    @Test("rolling refresh preserves locations with no replacement photos")
    func preservesLocationsWithoutReplacementPhotos() {
        let previous = worldPool()
        let preserved = SceneryStore.preservedPhotosDuringRefresh(
            previous: previous,
            batchNames: Set(["Kyoto, Japan", "Petra, Jordan"]),
            replacementNames: [],
            assignedIDs: [],
            isGrowing: false)

        #expect(preserved.map(\.id) == previous.map(\.id))
    }

    @Test("rolling refresh replaces only locations with new photos")
    func replacesOnlyLocationsWithNewPhotos() {
        let previous = worldPool()
        let preserved = SceneryStore.preservedPhotosDuringRefresh(
            previous: previous,
            batchNames: Set(["Kyoto, Japan", "Petra, Jordan"]),
            replacementNames: ["Petra, Jordan"],
            assignedIDs: [],
            isGrowing: false)

        #expect(preserved.map(\.id) == ["w1", "w3"])
    }

    @Test("peekNextScene returns the pending pick until assign commits, then re-samples")
    func pendingScenePreviewCommitConsistency() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: worldPool())

        let first = try #require(store.peekNextScene())
        // Repeated peeks return the same pending photo — the New Session
        // preview and the eventual commit always agree.
        #expect(store.peekNextScene()?.id == first.id)
        #expect(store.peekNextScene()?.id == first.id)
        #expect(store.pendingSceneIDForTesting == first.id)
        #expect(worldPool().map(\.id).contains(first.id))

        // Committing clears the pending pick; the next peek re-samples.
        store.assign(photoID: first.id, name: first.name, to: "thread-1")
        #expect(store.pendingSceneIDForTesting == nil)
        let next = try #require(store.peekNextScene())
        #expect(store.pendingSceneIDForTesting == next.id)
        #expect(worldPool().map(\.id).contains(next.id))
    }

    @Test("peekNextScene skips scenes occupied by excluded thread keys")
    func peekNextSceneSkipsOccupiedScenes() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: worldPool())

        // w1 and w2 are bound to open threads: every pick must land on w3.
        store.assign(photoID: "w1", name: "Kyoto, Japan", to: "thread-1")
        store.assign(photoID: "w2", name: "Petra, Jordan", to: "thread-2")
        for attempt in 0..<5 {
            let pick = try #require(
                store.peekNextScene(excludingThreadKeys: ["thread-1", "thread-2"]))
            #expect(pick.id == "w3")
            // Clear the pending pick so the next iteration re-samples.
            store.assign(photoID: pick.id, name: pick.name, to: "thread-new-\(attempt)")
        }
    }

    @Test("peekNextScene treats an excluded thread's stable-hash scene as occupied")
    func peekNextSceneSkipsHashFallbackScenes() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        let pool = worldPool()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: pool)

        // No explicit assignment: the thread still displays (and therefore
        // occupies) its stable-hash scene.
        let hashed = try #require(store.photo(for: "thread-busy"))
        let pick = try #require(store.peekNextScene(excludingThreadKeys: ["thread-busy"]))
        #expect(pick.id != hashed.id)
        #expect(pool.map(\.id).contains(pick.id))
    }

    @Test("peekNextScene allows duplicates only once every pool photo is occupied")
    func peekNextSceneFallsBackToDuplicatesWhenExhausted() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.installSetForTesting(
            ScenerySet.makeBuiltinWorldSet(), pool: [worldPool()[0]])

        store.assign(photoID: "w1", name: "Kyoto, Japan", to: "thread-1")
        let pick = try #require(store.peekNextScene(excludingThreadKeys: ["thread-1"]))
        #expect(pick.id == "w1")
    }

    @Test("photo(for:) falls back to a world-pool pick when the assigned photo is missing")
    func photoFallsBackToWorldPool() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        let pool = worldPool()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: pool)

        // Assignment points at a photo that exists in no pool (deleted/missing
        // legacy set): stable-hash pick from the world pool, never nil.
        store.assign(photoID: "ghost-photo", name: "Ghost", to: "thread-ghost")
        let resolved = try #require(store.photo(for: "thread-ghost"))
        let expected = pool[AlpineTheme.stableIndex("thread-ghost", pool.count)]
        #expect(resolved.id == expected.id)

        // Unassigned threads get the same stable-hash world fallback.
        let unassigned = try #require(store.photo(for: "thread-new"))
        #expect(unassigned.id == pool[AlpineTheme.stableIndex("thread-new", pool.count)].id)
    }

    @Test("new assignments resolve to the world set")
    func newAssignmentsResolveToWorld() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        let photo = worldPool()[0]
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: worldPool())

        #expect(store.resolvedSetId(forThread: "thread-unassigned") == ScenerySet.worldID)

        store.assign(photoID: photo.id, name: photo.name, to: "thread-1")
        #expect(store.resolvedSetId(forThread: "thread-1") == ScenerySet.worldID)
        #expect(store.photo(for: "thread-1")?.id == photo.id)
        #expect(store.sceneName(for: "thread-1") == photo.name)
        #expect(store.threadTitle(for: photo) == photo.name)

        // Assignment survives a disk round-trip.
        let reader = SceneryStore(client: nil, root: root)
        reader.reloadFromDiskForTesting()
        #expect(reader.resolvedSetId(forThread: "thread-1") == ScenerySet.worldID)
        #expect(reader.photo(for: "thread-1")?.id == photo.id)
        #expect(reader.sceneName(for: "thread-1") == photo.name)
    }

    @Test("legacy set pools still render their assigned photos")
    func legacyAssignmentsKeepRendering() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: worldPool())
        let legacySet = ScenerySet(
            id: "kyoto-3f2a",
            title: "Kyoto",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [SceneryQuery(text: "kyoto temples", take: 4)],
            sceneNames: ["Fushimi Inari"])
        let legacyPhoto = samplePhoto(id: "legacy-1", name: "Fushimi Inari")
        store.installSetForTesting(legacySet, pool: [legacyPhoto])

        store.assign(photoID: legacyPhoto.id, name: legacyPhoto.name, to: "thread-legacy")
        #expect(store.resolvedSetId(forThread: "thread-legacy") == "kyoto-3f2a")
        #expect(store.photo(for: "thread-legacy")?.id == legacyPhoto.id)
        #expect(store.sceneName(for: "thread-legacy") == "Fushimi Inari")
    }

    @Test("migration then store load keeps legacy assignment photo ids")
    func migrationPreservesAssignments() throws {
        let fm = FileManager.default
        let root = try tempRoot()
        defer { try? fm.removeItem(at: root) }

        let photo = samplePhoto(id: "legacy-photo", name: "Tre Cime")
        struct PoolFile: Codable {
            var fetchedAt: Date
            var photos: [SceneryPhoto]
        }
        let encodedPool = try JSONEncoder().encode(
            PoolFile(fetchedAt: Date(timeIntervalSince1970: 1_700_000_000), photos: [photo]))
        try encodedPool.write(to: root.appendingPathComponent("pool.json"))
        try Data(#"{"thread-legacy":"legacy-photo"}"#.utf8)
            .write(to: root.appendingPathComponent("assignments.json"))
        try Data(#"{"thread-legacy":"Tre Cime"}"#.utf8)
            .write(to: root.appendingPathComponent("names.json"))

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()

        #expect(store.set(id: SceneryLayoutMigration.legacyBuiltinSetID) != nil)
        #expect(store.set(id: ScenerySet.worldID) != nil)
        #expect(store.photo(for: "thread-legacy")?.id == "legacy-photo")
        #expect(store.sceneName(for: "thread-legacy") == "Tre Cime")

        // Idempotent reload
        store.reloadFromDiskForTesting()
        #expect(store.photo(for: "thread-legacy")?.id == "legacy-photo")
    }
}

@Suite("SceneryStore download registration")
@MainActor
struct SceneryStoreDownloadRegistrationTests {
    private enum PingError: Error { case boom }

    private func tempRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-reg-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("ping failure does not persist registration")
    func pingFailureLeavesUnregistered() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: [])

        let setId = ScenerySet.worldID
        let photoId = "photo-fail"
        let ping = URL(string: "https://api.unsplash.com/photos/photo-fail/download")!

        await store.registerDownloadIfNeeded(
            setId: setId,
            photoId: photoId,
            downloadLocationURL: ping
        ) { _ in
            throw PingError.boom
        }

        #expect(store.registeredDownloadIDsForTesting(setId: setId).isEmpty)
        let diskURL = root
            .appendingPathComponent("sets/\(setId)/registered-downloads.json")
        #expect(!FileManager.default.fileExists(atPath: diskURL.path))
    }

    @Test("ping success persists registration in memory and on disk")
    func pingSuccessPersists() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: [])

        let setId = ScenerySet.worldID
        let photoId = "photo-ok"
        let ping = URL(string: "https://api.unsplash.com/photos/photo-ok/download")!
        var pingCalls = 0

        await store.registerDownloadIfNeeded(
            setId: setId,
            photoId: photoId,
            downloadLocationURL: ping
        ) { url in
            pingCalls += 1
            #expect(url == ping)
        }

        #expect(pingCalls == 1)
        #expect(store.registeredDownloadIDsForTesting(setId: setId) == [photoId])

        let diskURL = root
            .appendingPathComponent("sets/\(setId)/registered-downloads.json")
        let data = try Data(contentsOf: diskURL)
        let ids = try JSONDecoder().decode(Set<String>.self, from: data)
        #expect(ids == [photoId])
    }

    @Test("already-registered photo skips ping")
    func alreadyRegisteredSkipsPing() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: [])

        let setId = ScenerySet.worldID
        let photoId = "photo-once"
        let ping = URL(string: "https://api.unsplash.com/photos/photo-once/download")!
        var pingCalls = 0

        await store.registerDownloadIfNeeded(
            setId: setId, photoId: photoId, downloadLocationURL: ping
        ) { _ in pingCalls += 1 }

        await store.registerDownloadIfNeeded(
            setId: setId, photoId: photoId, downloadLocationURL: ping
        ) { _ in pingCalls += 1 }

        #expect(pingCalls == 1)
        #expect(store.registeredDownloadIDsForTesting(setId: setId) == [photoId])
    }

    @Test("nil download location is a no-op")
    func nilLocationNoOp() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.installSetForTesting(ScenerySet.makeBuiltinWorldSet(), pool: [])

        var pingCalls = 0
        await store.registerDownloadIfNeeded(
            setId: ScenerySet.worldID,
            photoId: "x",
            downloadLocationURL: nil
        ) { _ in pingCalls += 1 }

        #expect(pingCalls == 0)
        #expect(store.registeredDownloadIDsForTesting(setId: ScenerySet.worldID).isEmpty)
    }
}

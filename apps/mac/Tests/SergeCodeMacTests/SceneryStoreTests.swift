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
        #expect(assignment.resolvedSetId == ScenerySet.dolomitesID)
    }

    @Test("object form with setId decodes")
    func objectWithSetId() throws {
        let json = Data(#"{"photoID":"p1","setId":"kyoto-3f2a"}"#.utf8)
        let assignment = try JSONDecoder().decode(SceneryAssignment.self, from: json)
        #expect(assignment.photoID == "p1")
        #expect(assignment.setId == "kyoto-3f2a")
        #expect(assignment.resolvedSetId == "kyoto-3f2a")
    }

    @Test("object form without setId defaults resolvedSetId to dolomites")
    func objectWithoutSetId() throws {
        let json = Data(#"{"photoID":"p2"}"#.utf8)
        let assignment = try JSONDecoder().decode(SceneryAssignment.self, from: json)
        #expect(assignment.photoID == "p2")
        #expect(assignment.setId == nil)
        #expect(assignment.resolvedSetId == ScenerySet.dolomitesID)
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

@Suite("Scenery set resolution")
struct ScenerySetResolutionTests {
    @Test("project prefs win over default and dolomites fallback")
    func projectPrefsPrecedence() {
        let prefs: [String: ProjectSceneryPrefs] = [
            "/Users/me/proj-a": ProjectSceneryPrefs(setId: "kyoto")
        ]
        let known: Set<String> = [ScenerySet.dolomitesID, "kyoto", "patagonia"]
        let resolved = ScenerySetResolution.resolveSetId(
            projectPath: "/Users/me/proj-a",
            projectPrefs: prefs,
            defaultSetId: "patagonia",
            knownSetIds: known)
        #expect(resolved == "kyoto")
    }

    @Test("defaultSetId used when project has no prefs")
    func defaultWhenNoProjectPrefs() {
        let known: Set<String> = [ScenerySet.dolomitesID, "patagonia"]
        let resolved = ScenerySetResolution.resolveSetId(
            projectPath: "/Users/me/other",
            projectPrefs: [:],
            defaultSetId: "patagonia",
            knownSetIds: known)
        #expect(resolved == "patagonia")
    }

    @Test("unknown project prefs setId falls through to default")
    func unknownProjectSetFallsThrough() {
        let prefs: [String: ProjectSceneryPrefs] = [
            "/p": ProjectSceneryPrefs(setId: "missing-set")
        ]
        let known: Set<String> = [ScenerySet.dolomitesID, "patagonia"]
        let resolved = ScenerySetResolution.resolveSetId(
            projectPath: "/p",
            projectPrefs: prefs,
            defaultSetId: "patagonia",
            knownSetIds: known)
        #expect(resolved == "patagonia")
    }

    @Test("unknown default falls through to dolomites")
    func unknownDefaultFallsToDolomites() {
        let known: Set<String> = [ScenerySet.dolomitesID]
        let resolved = ScenerySetResolution.resolveSetId(
            projectPath: nil,
            projectPrefs: [:],
            defaultSetId: "gone",
            knownSetIds: known)
        #expect(resolved == ScenerySet.dolomitesID)
    }

    @Test("nil project path uses default then dolomites")
    func nilProjectPath() {
        let known: Set<String> = [ScenerySet.dolomitesID, "patagonia"]
        #expect(
            ScenerySetResolution.resolveSetId(
                projectPath: nil,
                projectPrefs: [" /x": ProjectSceneryPrefs(setId: "patagonia")],
                defaultSetId: "patagonia",
                knownSetIds: known) == "patagonia")
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
        #expect(manifest.id == ScenerySet.dolomitesID)
        #expect(manifest.origin == .builtin)
        #expect(manifest.queries.count == 3)
        #expect(manifest.sceneNames.contains("Seceda"))

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

@Suite("SceneryStore multi-set")
@MainActor
struct SceneryStoreMultiSetTests {
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

    @Test("store resolves set from project prefs via projectPathForThread")
    func storeResolvesViaProjectPath() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        // No Unsplash client — stay offline.
        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()

        let kyoto = ScenerySet(
            id: "kyoto",
            title: "Kyoto",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [SceneryQuery(text: "kyoto temples", take: 4)],
            sceneNames: ["Fushimi Inari", "Arashiyama"])
        let kyotoPhoto = samplePhoto(id: "k1", name: "Fushimi Inari")
        let doloPhoto = samplePhoto(id: "d1", name: "Seceda")

        store.registerSetForTesting(ScenerySet.makeBuiltinDolomites(), pool: [doloPhoto])
        store.registerSetForTesting(kyoto, pool: [kyotoPhoto])
        store.setProjectPrefs(ProjectSceneryPrefs(setId: "kyoto"), forProjectPath: "/proj/kyoto")
        store.setDefaultSetId(ScenerySet.dolomitesID)

        store.projectPathForThread = { id in
            id == "thread-kyoto" ? "/proj/kyoto" : "/proj/other"
        }

        #expect(store.resolvedSetId(projectPath: "/proj/kyoto") == "kyoto")
        #expect(store.resolvedSetId(forThread: "thread-kyoto") == "kyoto")
        #expect(store.resolvedSetId(forThread: "thread-other") == ScenerySet.dolomitesID)

        let nextKyoto = store.peekNextScene(projectPath: "/proj/kyoto")
        #expect(nextKyoto?.id == "k1")
        let nextDefault = store.peekNextScene()
        #expect(nextDefault?.id == "d1")
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

        #expect(store.set(id: ScenerySet.dolomitesID) != nil)
        #expect(store.photo(for: "thread-legacy")?.id == "legacy-photo")
        #expect(store.sceneName(for: "thread-legacy") == "Tre Cime")

        // Idempotent reload
        store.reloadFromDiskForTesting()
        #expect(store.photo(for: "thread-legacy")?.id == "legacy-photo")
    }
}

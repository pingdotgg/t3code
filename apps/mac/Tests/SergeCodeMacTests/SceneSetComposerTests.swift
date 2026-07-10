import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

@Suite("Scenery set slug")
struct ScenerySetSlugTests {
    @Test("slug is filesystem-safe with random suffix")
    func slugFromLocation() {
        let id = ScenerySetSlug.make(from: "Norwegian Fjords", suffix: "a1b2")
        #expect(id == "norwegian-fjords-a1b2")
    }

    @Test("diacritics and punctuation collapse")
    func diacritics() {
        let id = ScenerySetSlug.make(from: "Kyōto!!", suffix: "3f2a")
        #expect(id == "kyoto-3f2a")
    }

    @Test("empty-ish location still yields a slug")
    func emptyLocation() {
        let id = ScenerySetSlug.make(from: "@@@", suffix: "zzzz")
        #expect(id == "set-zzzz")
    }
}

@Suite("Scenery set fallback composer")
struct ScenerySetFallbackTests {
    @Test("templated queries include location and tags")
    func templatedQueries() {
        let queries = ScenerySetFallback.templatedQueries(location: "Kyoto")
        #expect(queries.count >= 6)
        #expect(queries.contains { $0.text == "Kyoto landscape" })
        #expect(queries.contains { $0.timeOfDay == .dawn })
        #expect(queries.contains { $0.season == .winter })
    }

    @Test("makeStoreQueries maps generated tags and falls back when empty")
    func makeStoreQueries() {
        let generated = [
            GeneratedSceneryQuery(text: "kyoto temples", timeOfDay: .dawn, season: .spring),
            GeneratedSceneryQuery(text: "kyoto temples"),  // dup
            GeneratedSceneryQuery(text: "  "),
        ]
        let queries = SceneSetComposer.makeStoreQueries(from: generated, location: "Kyoto")
        #expect(queries.count == 1)
        #expect(queries[0].text == "kyoto temples")
        #expect(queries[0].timeOfDay == .dawn)
        #expect(queries[0].season == .spring)

        let fallback = SceneSetComposer.makeStoreQueries(from: [], location: "Patagonia")
        #expect(fallback.count >= 6)
        #expect(fallback[0].text.contains("Patagonia"))
    }

    @Test("normalizeSceneNames dedupes and trims")
    func normalizeNames() {
        let names = SceneSetComposer.normalizeSceneNames([
            " Fushimi Inari ", "fushimi inari", "Arashiyama", "",
        ])
        #expect(names == ["Fushimi Inari", "Arashiyama"])
    }

    @Test("numbered names last resort")
    func numbered() {
        let names = SceneSetComposer.numberedNames(location: "Kyoto", count: 3)
        #expect(names == ["Kyoto 1", "Kyoto 2", "Kyoto 3"])
    }
}

@Suite("SceneryStore delete custom set")
@MainActor
struct SceneryStoreDeleteSetTests {
    private func tempRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-del-\(UUID().uuidString)", isDirectory: true)
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

    @Test("delete removes registry, disk, prefs, and assignments; builtin protected")
    func deleteCustomSetReassigns() throws {
        let fm = FileManager.default
        let root = try tempRoot()
        defer { try? fm.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()

        let doloPhoto = samplePhoto(id: "d1", name: "Seceda")
        let kyotoPhoto = samplePhoto(id: "k1", name: "Fushimi Inari")
        store.registerSet(ScenerySet.makeBuiltinDolomites(), pool: [doloPhoto])

        let kyoto = ScenerySet(
            id: "kyoto-3f2a",
            title: "Kyoto",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [SceneryQuery(text: "kyoto temples")],
            sceneNames: ["Fushimi Inari"])
        store.registerSet(kyoto, pool: [kyotoPhoto])
        store.setDefaultSetId("kyoto-3f2a")
        store.setProjectPrefs(
            ProjectSceneryPrefs(setId: "kyoto-3f2a"), forProjectPath: "/proj/kyoto")
        store.assign(
            photoID: "k1", name: "Fushimi Inari", to: "thread-k", projectPath: "/proj/kyoto")

        #expect(store.set(id: "kyoto-3f2a") != nil)
        #expect(store.defaultSetId == "kyoto-3f2a")
        #expect(store.photo(for: "thread-k")?.id == "k1")
        #expect(
            fm.fileExists(
                atPath: root.appendingPathComponent("sets/kyoto-3f2a/manifest.json").path))

        try store.deleteCustomSet(id: "kyoto-3f2a")

        #expect(store.set(id: "kyoto-3f2a") == nil)
        #expect(store.defaultSetId == ScenerySet.dolomitesID)
        #expect(store.projectPrefs(for: "/proj/kyoto")?.setId == nil)
        // Assignment dropped → lazy fallback to default pool.
        #expect(store.photo(for: "thread-k")?.id == "d1")
        #expect(
            !fm.fileExists(
                atPath: root.appendingPathComponent("sets/kyoto-3f2a/manifest.json").path))

        #expect(throws: SceneryStore.DeleteSetError.builtinProtected) {
            try store.deleteCustomSet(id: ScenerySet.dolomitesID)
        }
    }
}

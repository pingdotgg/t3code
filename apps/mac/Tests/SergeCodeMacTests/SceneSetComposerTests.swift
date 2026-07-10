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

    @Test("templated generation has empty locations for legacy path")
    func templatedGenerationIsLegacy() {
        let gen = ScenerySetFallback.templatedGeneration(location: "Iceland")
        #expect(gen.sceneNames.isEmpty)
        #expect(gen.locations == nil || gen.locations?.isEmpty == true)
        #expect(!gen.queries.isEmpty)
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

    @Test("numbered names last resort (historical; new pools use bare title)")
    func numbered() {
        let names = SceneSetComposer.numberedNames(location: "Kyoto", count: 3)
        #expect(names == ["Kyoto 1", "Kyoto 2", "Kyoto 3"])
        #expect(SceneSetComposer.bareSetTitle("  Iceland  ") == "Iceland")
        #expect(SceneSetComposer.bareSetTitle("") == "Scene")
    }

    @Test("location tags map to photo tags")
    func locationTags() {
        let tagged = GeneratedSceneryLocation(
            name: "Kirkjufell", query: "Kirkjufell mountain Iceland", timeOfDay: .dusk,
            season: .winter)
        let tags = SceneSetComposer.tags(from: tagged)
        #expect(tags?.timeOfDay == .dusk)
        #expect(tags?.season == .winter)

        let plain = GeneratedSceneryLocation(name: "Skógafoss", query: "Skógafoss waterfall Iceland")
        #expect(SceneSetComposer.tags(from: plain) == nil)
    }

    @Test("makeStoreLocations maps and dedupes generated locations")
    func makeStoreLocations() {
        let mapped = SceneSetComposer.makeStoreLocations(from: [
            GeneratedSceneryLocation(
                name: " Kirkjufell ", query: " Kirkjufell mountain Iceland ", timeOfDay: .dusk),
            GeneratedSceneryLocation(name: "kirkjufell", query: "duplicate"),
            GeneratedSceneryLocation(name: "Skógafoss", query: "  "),
            GeneratedSceneryLocation(name: "Jökulsárlón", query: "Jökulsárlón lagoon"),
        ])
        #expect(mapped.count == 2)
        #expect(mapped[0].name == "Kirkjufell")
        #expect(mapped[0].query == "Kirkjufell mountain Iceland")
        #expect(mapped[0].timeOfDay == .dusk)
        #expect(mapped[1].name == "Jökulsárlón")
    }

    @Test("makeStoreQueries caps general queries at 6")
    func makeStoreQueriesCap() {
        let generated = (1...10).map { GeneratedSceneryQuery(text: "iceland landscape \($0)") }
        let queries = SceneSetComposer.makeStoreQueries(from: generated, location: "Iceland")
        #expect(queries.count == 6)
    }
}

@Suite("Unsplash suggested scene names")
struct UnsplashSuggestedSceneNameTests {
    private func decodePhoto(_ json: String) throws -> UnsplashClient.APIPhoto {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UnsplashClient.APIPhoto.self, from: Data(json.utf8))
    }

    @Test("uses location name, never description or alt_description captions")
    func locationOnlyNeverCaptions() throws {
        let withLocation = try decodePhoto(
            """
            {
              "id": "a",
              "color": "#112233",
              "description": "this image describes a highway at sunset over the ocean",
              "alt_description": "aerial view of a winding road",
              "location": { "name": "Kirkjufell", "city": "Grundarfjörður", "country": "Iceland" },
              "urls": {
                "raw": "https://images.unsplash.com/a-raw",
                "regular": "https://images.unsplash.com/a",
                "thumb": "https://images.unsplash.com/a-t"
              },
              "user": { "name": "Photog" }
            }
            """)
        #expect(withLocation.suggestedSceneName == "Kirkjufell")

        let captionOnly = try decodePhoto(
            """
            {
              "id": "b",
              "description": "this image describes a highway at sunset",
              "alt_description": "aerial view of a winding road",
              "urls": {
                "raw": "https://images.unsplash.com/b-raw",
                "regular": "https://images.unsplash.com/b",
                "thumb": "https://images.unsplash.com/b-t"
              },
              "user": { "name": "Photog" }
            }
            """)
        #expect(captionOnly.suggestedSceneName == nil)

        let cityOnly = try decodePhoto(
            """
            {
              "id": "c",
              "description": "caption that must never win",
              "location": { "city": "Reykjavík", "country": "Iceland" },
              "urls": {
                "raw": "https://images.unsplash.com/c-raw",
                "regular": "https://images.unsplash.com/c",
                "thumb": "https://images.unsplash.com/c-t"
              },
              "user": { "name": "Photog" }
            }
            """)
        #expect(cityOnly.suggestedSceneName == "Reykjavík")
    }
}

// MARK: - Integration: per-location fetch + regenerate

/// Minimal BackendService that returns a fixed GeneratedScenerySet.
private final class FixedSceneryBackend: BackendService, @unchecked Sendable {
    var response: GeneratedScenerySet
    var shouldFail = false

    init(response: GeneratedScenerySet) {
        self.response = response
    }

    private let streamPair = AsyncStream<BackendEvent>.makeStream()
    var events: AsyncStream<BackendEvent> { streamPair.stream }

    func start() async {}
    func stop() async { streamPair.continuation.finish() }
    func projects() async throws -> [Project] { [] }
    func threads() async throws -> [ChatThread] { [] }
    func timeline(threadID: String) async throws -> [TimelineItem] { [] }
    func closeTimeline(threadID: String) async {}
    func providers() async throws -> [ProviderInstance] { [] }
    func models() async throws -> [ModelOption] { [] }
    func searchWorkspace(threadID: String, query: String) async throws -> [WorkspaceEntry] { [] }
    func listWorkspace(threadID: String, subpath: String) async throws -> [WorkspaceEntry] { [] }
    func readWorkspaceFile(threadID: String, path: String) async throws -> FilePreview {
        FilePreview(path: path, contents: "", truncated: false)
    }
    func openInEditor(threadID: String, subpath: String?, editor: ExternalEditor) async throws {}
    func createThread(projectID: String, provider: ProviderKind, title: String?) async throws
        -> ChatThread
    {
        fatalError("unused")
    }
    func archiveThread(id: String) async throws {}
    func unarchiveThread(id: String) async throws {}
    func deleteThread(id: String) async throws {}
    func sendMessage(threadID: String, text: String, attachments: [OutgoingAttachment]) async throws
    {}
    func cancelTurn(threadID: String) async throws {}
    func stopTask(threadID: String, taskId: String) async throws {}
    func respondToApproval(id: String, approve: Bool) async throws {}
    func respondToUserInput(id: String, answers: [String: [String]]) async throws {}
    func setRuntimeMode(threadID: String, mode: ThreadRuntimeMode) async throws {}
    func setInteractionMode(threadID: String, mode: ThreadInteractionMode) async throws {}
    func setModel(threadID: String, model: ModelOption) async throws {}
    func setReasoningEffort(threadID: String, value: String) async throws {}
    func setServiceTier(threadID: String, value: String) async throws {}
    func implementPlan(threadID: String, planID: String) async throws {}
    func diff(threadID: String) async throws -> [DiffFile] { [] }
    func diff(threadID: String, fromTurn: Int, toTurn: Int) async throws -> [DiffFile] { [] }
    func checkpoints(threadID: String) async throws -> [Checkpoint] { [] }
    func restoreCheckpoint(threadID: String, turnCount: Int) async throws {}
    func addProject(path: String) async throws -> Project { fatalError("unused") }
    func renameProject(id: String, name: String) async throws {}
    func deleteProject(id: String) async throws {}
    func watchVcsStatus(threadID: String) async throws {}
    func listBranches(threadID: String, query: String?) async throws -> [BranchRef] { [] }
    func switchBranch(threadID: String, name: String) async throws {}
    func createBranch(threadID: String, name: String) async throws {}
    func pull(threadID: String) async throws {}
    func runGitAction(threadID: String, action: GitAction, commitMessage: String?) async throws
        -> GitActionOutcome
    {
        fatalError("unused")
    }
    func isServerLanReachable() async -> Bool { false }
    func mintMobilePairing() async throws -> MobilePairingInfo { fatalError("unused") }
    func settings() async throws -> AppSettings {
        AppSettings(
            assistantStreaming: true,
            providerUpdateChecks: false,
            defaultEnvMode: .local,
            newWorktreesStartFromOrigin: false,
            addProjectBaseDirectory: "")
    }
    func updateSettings(_ settings: AppSettings) async throws -> AppSettings { settings }
    func refreshProviders() async throws {}
    func updateProvider(instanceID: String) async throws {}

    func generateScenerySet(location: String) async throws -> GeneratedScenerySet {
        if shouldFail { throw URLError(.notConnectedToInternet) }
        return response
    }
}

/// URLProtocol that answers Unsplash search with query-keyed fixture photos.
private final class UnsplashSearchStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var resultsByQuery: [String: [[String: Any]]] = [:]

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.contains("unsplash.com") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let query =
            URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "query" })?.value ?? ""
        let results = Self.resultsByQuery[query] ?? Self.resultsByQuery["*"] ?? []
        let body: [String: Any] = ["results": results, "total": results.count]
        let data = try! JSONSerialization.data(withJSONObject: body)
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func photoJSON(
        id: String,
        locationName: String? = nil,
        description: String? = nil
    ) -> [String: Any] {
        var dict: [String: Any] = [
            "id": id,
            "color": "#112233",
            "urls": [
                "raw": "https://images.unsplash.com/\(id)-raw",
                "regular": "https://images.unsplash.com/\(id)",
                "thumb": "https://images.unsplash.com/\(id)-t",
            ],
            "user": ["name": "Tester"],
        ]
        if let locationName {
            dict["location"] = ["name": locationName]
        }
        if let description {
            dict["description"] = description
            dict["alt_description"] = description
        }
        return dict
    }
}

@Suite("SceneSetComposer per-location pipeline", .serialized)
@MainActor
struct SceneSetComposerPipelineTests {
    private func tempRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-compose-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeClient() -> UnsplashClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [UnsplashSearchStub.self]
        let session = URLSession(configuration: config)
        return UnsplashClient(accessKey: "test-key", session: session)!
    }

    private func awaitFinished(
        composer: SceneSetComposer, timeout: Duration = .seconds(5)
    ) async -> SceneSetComposer.State {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            switch composer.state {
            case .finished, .failed:
                return composer.state
            default:
                try? await Task.sleep(for: .milliseconds(20))
            }
        }
        return composer.state
    }

    @Test("per-location path assigns photo.name from location name; dedupes photos")
    func perLocationNamingAndDedupe() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        UnsplashSearchStub.resultsByQuery = [
            "Kirkjufell mountain Iceland": [
                UnsplashSearchStub.photoJSON(
                    id: "photo-kirk",
                    description: "this image describes a highway at sunset"),
            ],
            "Skógafoss waterfall Iceland": [
                UnsplashSearchStub.photoJSON(id: "photo-skog"),
                UnsplashSearchStub.photoJSON(id: "photo-skog-2"),
            ],
            // Same photo id returned for second location of a dup query — should not double-count.
            "Reynisfjara beach Iceland": [
                UnsplashSearchStub.photoJSON(id: "photo-kirk"),  // already seen
                UnsplashSearchStub.photoJSON(id: "photo-reyni"),
            ],
            "iceland landscape": [
                UnsplashSearchStub.photoJSON(
                    id: "photo-topup",
                    description: "caption must not become a name"),
            ],
        ]

        let backend = FixedSceneryBackend(
            response: GeneratedScenerySet(
                sceneNames: ["Kirkjufell", "Skógafoss", "Reynisfjara"],
                queries: [GeneratedSceneryQuery(text: "iceland landscape")],
                locations: [
                    GeneratedSceneryLocation(
                        name: "Kirkjufell", query: "Kirkjufell mountain Iceland", timeOfDay: .dusk),
                    GeneratedSceneryLocation(
                        name: "Skógafoss", query: "Skógafoss waterfall Iceland"),
                    GeneratedSceneryLocation(
                        name: "Reynisfjara", query: "Reynisfjara beach Iceland"),
                ]))

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        let composer = SceneSetComposer(store: store, backend: backend, client: makeClient())
        composer.createSet(location: "Iceland")

        let state = await awaitFinished(composer: composer)
        guard case .finished(let setId) = state else {
            Issue.record("expected finished, got \(state)")
            return
        }

        let photos = store.photos(forSetId: setId)
        // 3 named locations + top-up (named count < 12).
        #expect(photos.count >= 3)
        #expect(photos.prefix(3).map(\.name) == ["Kirkjufell", "Skógafoss", "Reynisfjara"])
        #expect(Set(photos.prefix(3).map(\.id)) == ["photo-kirk", "photo-skog", "photo-reyni"])
        #expect(store.set(id: setId)?.sceneNames.prefix(3).map { $0 } == [
            "Kirkjufell", "Skógafoss", "Reynisfjara",
        ])
        #expect(store.photoTagsForTesting(setId: setId)["photo-kirk"]?.timeOfDay == .dusk)
        // Locations persisted on the set for refreshPool re-fetch.
        let persisted = store.set(id: setId)?.locations
        #expect(persisted?.count == 3)
        #expect(persisted?.map(\.name) == ["Kirkjufell", "Skógafoss", "Reynisfjara"])
        #expect(persisted?.first?.query == "Kirkjufell mountain Iceland")
        // Manifest on disk includes locations.
        let manifestURL = root.appendingPathComponent("sets/\(setId)/manifest.json")
        let manifestData = try Data(contentsOf: manifestURL)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(ScenerySet.self, from: manifestData)
        #expect(decoded.locations?.map(\.name) == ["Kirkjufell", "Skógafoss", "Reynisfjara"])
        // No caption names anywhere (top-up is numbered when metadata is absent).
        for photo in photos {
            #expect(!photo.name.lowercased().contains("image describes"))
            #expect(!photo.name.lowercased().contains("caption"))
            #expect(!photo.name.lowercased().contains("highway"))
        }
    }

    @Test("top-up naming never uses captions; falls back to bare set title")
    func topUpNeverCaptions() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        // Only two locations succeed → need top-up to fill; top-up photos have captions only.
        UnsplashSearchStub.resultsByQuery = [
            "Place A Iceland": [UnsplashSearchStub.photoJSON(id: "a")],
            "Place B Iceland": [UnsplashSearchStub.photoJSON(id: "b")],
            "iceland landscape": (1...12).map { i in
                UnsplashSearchStub.photoJSON(
                    id: "top-\(i)",
                    description: "this image describes scenic number \(i)")
            },
        ]

        let backend = FixedSceneryBackend(
            response: GeneratedScenerySet(
                sceneNames: ["Place A", "Place B"],
                queries: [GeneratedSceneryQuery(text: "iceland landscape")],
                locations: [
                    GeneratedSceneryLocation(name: "Place A", query: "Place A Iceland"),
                    GeneratedSceneryLocation(name: "Place B", query: "Place B Iceland"),
                ]))

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        let composer = SceneSetComposer(store: store, backend: backend, client: makeClient())
        composer.createSet(location: "Iceland")

        let state = await awaitFinished(composer: composer)
        guard case .finished(let setId) = state else {
            Issue.record("expected finished, got \(state)")
            return
        }

        let photos = store.photos(forSetId: setId)
        #expect(photos.count >= 12)
        #expect(photos[0].name == "Place A")
        #expect(photos[1].name == "Place B")
        for photo in photos.dropFirst(2) {
            #expect(!photo.name.lowercased().contains("image describes"))
            // Captions stripped → bare set title (never "Iceland 1"…"Iceland N").
            #expect(photo.name == "Iceland")
        }
        // Thread titles must not leak pool indices either.
        for photo in photos.dropFirst(2) {
            #expect(store.threadTitle(for: photo) == "Iceland")
        }
    }

    @Test("legacy path (no locations) still works and never uses captions")
    func legacyPathCaptionFree() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        UnsplashSearchStub.resultsByQuery = [
            "Iceland landscape": [
                UnsplashSearchStub.photoJSON(
                    id: "meta-1", locationName: "Jökulsárlón",
                    description: "this image describes icebergs"),
                UnsplashSearchStub.photoJSON(
                    id: "cap-1", description: "this image describes a highway at sunset"),
            ],
            "*": [],
        ]

        // Force fallback templated generation by failing backend.
        let backend = FixedSceneryBackend(
            response: GeneratedScenerySet(sceneNames: [], queries: []))
        backend.shouldFail = true

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        let composer = SceneSetComposer(store: store, backend: backend, client: makeClient())
        composer.createSet(location: "Iceland")

        let state = await awaitFinished(composer: composer)
        guard case .finished(let setId) = state else {
            Issue.record("expected finished, got \(state)")
            return
        }

        let photos = store.photos(forSetId: setId)
        #expect(!photos.isEmpty)
        #expect(photos.contains { $0.name == "Jökulsárlón" })
        for photo in photos {
            #expect(!photo.name.lowercased().contains("image describes"))
            #expect(!photo.name.lowercased().contains("highway"))
        }
        // Caption-only photo gets the bare set title (not "Iceland N").
        if let cap = photos.first(where: { $0.id == "cap-1" }) {
            #expect(cap.name == "Iceland")
            #expect(store.threadTitle(for: cap) == "Iceland")
        }
    }

    @Test("legacy path with empty locations never titles threads Iceland N")
    func legacyEmptyLocationsThreadTitleIsBarePlace() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        // No Unsplash location metadata → previously numbered "Iceland 1"… "Iceland 5".
        UnsplashSearchStub.resultsByQuery = [
            "Iceland landscape": (1...8).map { i in
                UnsplashSearchStub.photoJSON(
                    id: "pool-\(i)",
                    description: "this image describes scenic number \(i)")
            },
            "*": [],
        ]

        // Backend returns queries but no locations (trigger: empty locations path).
        let backend = FixedSceneryBackend(
            response: GeneratedScenerySet(
                sceneNames: [],
                queries: [GeneratedSceneryQuery(text: "Iceland landscape")],
                locations: nil))

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        let composer = SceneSetComposer(store: store, backend: backend, client: makeClient())
        composer.createSet(location: "Iceland")

        let state = await awaitFinished(composer: composer)
        guard case .finished(let setId) = state else {
            Issue.record("expected finished, got \(state)")
            return
        }

        let photos = store.photos(forSetId: setId)
        #expect(photos.count >= 5)
        for photo in photos {
            #expect(photo.name == "Iceland")
            #expect(store.threadTitle(for: photo) == "Iceland")
            // No pool-index suffix like "Iceland 5".
            #expect(photo.name.range(of: #" \d+$"#, options: .regularExpression) == nil)
        }
        // sceneNames must not be polluted with "Iceland 1"…"Iceland N".
        #expect(store.set(id: setId)?.sceneNames == ["Iceland"])
    }

    @Test("threadTitle strips historical pool-index names from on-disk pools")
    func threadTitleStripsPoolIndexEvenWhenSceneNamesPolluted() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()

        let setId = "iceland-polluted"
        // Simulate the old bug: pool + sceneNames only contain numbered labels.
        let photos = (1...5).map { i in
            SceneryPhoto(
                id: "p-\(i)",
                name: "Iceland \(i)",
                averageColorHex: "#000000",
                heroURL: URL(string: "https://images.unsplash.com/p\(i)")!,
                thumbURL: URL(string: "https://images.unsplash.com/p\(i)-t")!,
                rawURL: nil,
                downloadLocationURL: nil,
                photographerName: "Old",
                photographerProfileURL: nil)
        }
        let set = ScenerySet(
            id: setId,
            title: "Iceland",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [SceneryQuery(text: "iceland landscape")],
            sceneNames: photos.map(\.name),
            locations: nil)
        store.registerSet(set, pool: photos)

        // Photo 5 was the classic first-thread title leak.
        let fifth = photos[4]
        #expect(fifth.name == "Iceland 5")
        #expect(store.threadTitle(for: fifth) == "Iceland")
        for photo in photos {
            #expect(store.threadTitle(for: photo) == "Iceland")
        }
    }

    @Test("legacy path uses curated sceneNames when locations empty")
    func legacyUsesCuratedSceneNames() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        UnsplashSearchStub.resultsByQuery = [
            "iceland landscape": [
                UnsplashSearchStub.photoJSON(id: "c1"),
                UnsplashSearchStub.photoJSON(id: "c2"),
                UnsplashSearchStub.photoJSON(id: "c3"),
            ],
            "*": [],
        ]

        let backend = FixedSceneryBackend(
            response: GeneratedScenerySet(
                sceneNames: ["Kirkjufell", "Skógafoss", "Reynisfjara"],
                queries: [GeneratedSceneryQuery(text: "iceland landscape")],
                locations: nil))

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        let composer = SceneSetComposer(store: store, backend: backend, client: makeClient())
        composer.createSet(location: "Iceland")

        let state = await awaitFinished(composer: composer)
        guard case .finished(let setId) = state else {
            Issue.record("expected finished, got \(state)")
            return
        }

        let photos = store.photos(forSetId: setId)
        #expect(photos.map(\.name) == ["Kirkjufell", "Skógafoss", "Reynisfjara"])
        #expect(store.threadTitle(for: photos[0]) == "Kirkjufell")
    }

    @Test("regenerate replaces same set id and cleans stale residue")
    func regenerateCleansResidue() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()

        let setId = "iceland-old1"
        let oldPhoto = SceneryPhoto(
            id: "stale-photo",
            name: "this image describes a highway",
            averageColorHex: "#000000",
            heroURL: URL(string: "https://images.unsplash.com/stale")!,
            thumbURL: URL(string: "https://images.unsplash.com/stale-t")!,
            rawURL: nil,
            downloadLocationURL: nil,
            photographerName: "Old",
            photographerProfileURL: nil)
        let oldSet = ScenerySet(
            id: setId,
            title: "Iceland",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [SceneryQuery(text: "old")],
            sceneNames: ["this image describes a highway"],
            palette: SceneryPalette(accentHex: "#4F9AC3", washes: [["#102A36", "#4A829F"]]))
        store.registerSet(oldSet, pool: [oldPhoto], photoTags: ["stale-photo": SceneryPhotoTags(timeOfDay: .night)])
        store.assign(
            photoID: "stale-photo", name: "this image describes a highway", to: "thread-old",
            setIdOverride: setId)

        // Plant a stale image file on disk.
        let imagesDir = root.appendingPathComponent("sets/\(setId)/images", isDirectory: true)
        try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
        let staleFile = imagesDir.appendingPathComponent("stale-photo-thumb.jpg")
        try Data([0xFF, 0xD8, 0xFF]).write(to: staleFile)
        #expect(FileManager.default.fileExists(atPath: staleFile.path))
        #expect(store.sceneName(for: "thread-old") != nil)

        UnsplashSearchStub.resultsByQuery = [
            "Kirkjufell mountain Iceland": [UnsplashSearchStub.photoJSON(id: "new-kirk")],
            "Skógafoss waterfall Iceland": [UnsplashSearchStub.photoJSON(id: "new-skog")],
            "iceland landscape": [
                UnsplashSearchStub.photoJSON(id: "new-1"),
                UnsplashSearchStub.photoJSON(id: "new-2"),
                UnsplashSearchStub.photoJSON(id: "new-3"),
                UnsplashSearchStub.photoJSON(id: "new-4"),
                UnsplashSearchStub.photoJSON(id: "new-5"),
                UnsplashSearchStub.photoJSON(id: "new-6"),
                UnsplashSearchStub.photoJSON(id: "new-7"),
                UnsplashSearchStub.photoJSON(id: "new-8"),
                UnsplashSearchStub.photoJSON(id: "new-9"),
                UnsplashSearchStub.photoJSON(id: "new-10"),
            ],
        ]

        let backend = FixedSceneryBackend(
            response: GeneratedScenerySet(
                sceneNames: ["Kirkjufell", "Skógafoss"],
                queries: [GeneratedSceneryQuery(text: "iceland landscape")],
                locations: [
                    GeneratedSceneryLocation(
                        name: "Kirkjufell", query: "Kirkjufell mountain Iceland"),
                    GeneratedSceneryLocation(
                        name: "Skógafoss", query: "Skógafoss waterfall Iceland"),
                ]))

        let composer = SceneSetComposer(store: store, backend: backend, client: makeClient())
        composer.createSet(location: "Iceland", replacingSetId: setId)

        let state = await awaitFinished(composer: composer)
        guard case .finished(let finishedId) = state else {
            Issue.record("expected finished, got \(state)")
            return
        }
        #expect(finishedId == setId)
        #expect(store.set(id: setId) != nil)
        // No orphan with a different slug.
        #expect(store.availableSets.filter { $0.title == "Iceland" }.count == 1)

        let photos = store.photos(forSetId: setId)
        #expect(photos.contains { $0.id == "new-kirk" && $0.name == "Kirkjufell" })
        #expect(!photos.contains { $0.id == "stale-photo" })
        #expect(store.set(id: setId)?.sceneNames.contains("Kirkjufell") == true)
        // Stale name map cleared.
        #expect(store.sceneName(for: "thread-old") != "this image describes a highway")
        // Stale image file removed.
        #expect(!FileManager.default.fileExists(atPath: staleFile.path))
        // Palette cleared for recompute (new set registered with nil palette).
        #expect(store.set(id: setId)?.palette == nil)
        // Regenerated set persists locations for future refresh.
        #expect(store.set(id: setId)?.locations?.map(\.name) == ["Kirkjufell", "Skógafoss"])
    }

    @Test("refreshPool with locations keeps place names on matching photos (no round-robin)")
    func refreshPoolPerLocationNames() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        UnsplashSearchStub.resultsByQuery = [
            "Kirkjufell mountain Iceland": [
                UnsplashSearchStub.photoJSON(
                    id: "fresh-kirk",
                    description: "this image describes a highway"),
            ],
            "Skógafoss waterfall Iceland": [
                UnsplashSearchStub.photoJSON(id: "fresh-skog"),
            ],
            "iceland landscape": [
                UnsplashSearchStub.photoJSON(
                    id: "fresh-top-1", description: "caption must not become a name"),
                UnsplashSearchStub.photoJSON(
                    id: "fresh-top-2", description: "another caption"),
            ],
        ]

        let client = makeClient()
        let store = SceneryStore(client: client, root: root)
        store.reloadFromDiskForTesting()

        // Seed a custom set with locations + stale pool that would be wrong if
        // refresh round-robined sceneNames onto generic query results.
        let setId = "iceland-rfr1"
        let set = ScenerySet(
            id: setId,
            title: "Iceland",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [SceneryQuery(text: "iceland landscape", take: 12)],
            sceneNames: ["Kirkjufell", "Skógafoss"],
            locations: [
                SceneryLocation(
                    name: "Kirkjufell", query: "Kirkjufell mountain Iceland", timeOfDay: .dusk),
                SceneryLocation(name: "Skógafoss", query: "Skógafoss waterfall Iceland"),
            ])
        let stale = SceneryPhoto(
            id: "stale",
            name: "Stale",
            averageColorHex: "#000000",
            heroURL: URL(string: "https://images.unsplash.com/stale")!,
            thumbURL: URL(string: "https://images.unsplash.com/stale-t")!,
            rawURL: nil,
            downloadLocationURL: nil,
            photographerName: "Old",
            photographerProfileURL: nil)
        store.registerSet(set, pool: [stale])

        await store.refreshPoolForTesting(setId: setId)

        let photos = store.photos(forSetId: setId)
        #expect(!photos.isEmpty)
        // Named location photos keep their authentic place names (not rotated).
        let kirk = photos.first { $0.id == "fresh-kirk" }
        let skog = photos.first { $0.id == "fresh-skog" }
        #expect(kirk?.name == "Kirkjufell")
        #expect(skog?.name == "Skógafoss")
        // Round-robin of sceneNames onto top-up would put Kirkjufell/Skógafoss
        // on random top-up ids — ensure top-ups use bare set title (no location meta).
        for photo in photos where photo.id.hasPrefix("fresh-top") {
            #expect(photo.name != "Kirkjufell")
            #expect(photo.name != "Skógafoss")
            #expect(!photo.name.lowercased().contains("caption"))
            #expect(!photo.name.lowercased().contains("image describes"))
            #expect(photo.name == "Iceland")
            #expect(store.threadTitle(for: photo) == "Iceland")
        }
        #expect(store.photoTagsForTesting(setId: setId)["fresh-kirk"]?.timeOfDay == .dusk)
    }

    @Test("refreshPool without locations still round-robins curated sceneNames")
    func refreshPoolLegacyRoundRobin() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        UnsplashSearchStub.resultsByQuery = [
            "dolomites italy mountains": [
                UnsplashSearchStub.photoJSON(id: "p1"),
                UnsplashSearchStub.photoJSON(id: "p2"),
                UnsplashSearchStub.photoJSON(id: "p3"),
            ],
        ]

        let client = makeClient()
        let store = SceneryStore(client: client, root: root)
        store.reloadFromDiskForTesting()

        let setId = "legacy-set1"
        let set = ScenerySet(
            id: setId,
            title: "Legacy",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [SceneryQuery(text: "dolomites italy mountains", take: 3)],
            sceneNames: ["Alpha", "Beta"],
            locations: nil)
        store.registerSet(set, pool: [])

        await store.refreshPoolForTesting(setId: setId)

        let photos = store.photos(forSetId: setId)
        #expect(photos.count == 3)
        #expect(photos.map(\.name) == ["Alpha", "Beta", "Alpha"])
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

    @Test("registerSet replacePoolResidue clears names, tags, and stale images")
    func replacePoolResidue() throws {
        let fm = FileManager.default
        let root = try tempRoot()
        defer { try? fm.removeItem(at: root) }

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()

        let setId = "patagonia-abcd"
        let old = samplePhoto(id: "old-1", name: "Old Caption Name")
        let set = ScenerySet(
            id: setId,
            title: "Patagonia",
            origin: .custom,
            createdAt: Date(),
            queries: [SceneryQuery(text: "patagonia")],
            sceneNames: ["Old Caption Name"])
        store.registerSet(set, pool: [old], photoTags: ["old-1": SceneryPhotoTags(season: .winter)])
        store.assign(photoID: "old-1", name: "Old Caption Name", to: "t1", setIdOverride: setId)

        let imagesDir = root.appendingPathComponent("sets/\(setId)/images", isDirectory: true)
        try fm.createDirectory(at: imagesDir, withIntermediateDirectories: true)
        let stale = imagesDir.appendingPathComponent("old-1-thumb.jpg")
        try Data([1, 2, 3]).write(to: stale)

        let fresh = samplePhoto(id: "new-1", name: "Fitz Roy")
        var next = set
        next.sceneNames = ["Fitz Roy"]
        next.palette = nil
        store.registerSet(
            next,
            pool: [fresh],
            photoTags: ["new-1": SceneryPhotoTags(timeOfDay: .dawn)],
            replacePoolResidue: true)

        #expect(store.photos(forSetId: setId).map(\.id) == ["new-1"])
        #expect(store.photoTagsForTesting(setId: setId)["old-1"] == nil)
        #expect(store.photoTagsForTesting(setId: setId)["new-1"]?.timeOfDay == .dawn)
        #expect(!fm.fileExists(atPath: stale.path))
        // namesBySet cleared for the set.
        #expect(store.sceneName(for: "t1") != "Old Caption Name")
    }
}

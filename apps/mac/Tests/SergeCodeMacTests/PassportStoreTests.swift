import Foundation
import Testing
import T3Kit
@testable import SergeCodeMac

final class PassportUnsplashSearchStub: URLProtocol, @unchecked Sendable {
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
}

@Suite("Passport store", .serialized)
@MainActor
struct PassportStoreTests {
    private func tempRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("passport-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func makeSet(
        id: String,
        title: String,
        createdAt: Date = Date(timeIntervalSince1970: 100)
    ) -> ScenerySet {
        ScenerySet(
            id: id,
            title: title,
            origin: id == ScenerySet.dolomitesID ? .builtin : .custom,
            createdAt: createdAt,
            queries: [],
            sceneNames: [])
    }

    @Test("ensurePage is idempotent and updates only the title")
    func ensurePageIdempotency() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = PassportStore(rootOverride: root)
        let issuedAt = Date(timeIntervalSince1970: 100)

        store.ensurePage(setId: "alps", title: "Alps", issuedAt: issuedAt)
        store.ensurePage(
            setId: "alps", title: "The Alps", issuedAt: Date(timeIntervalSince1970: 200))

        #expect(store.pages.count == 1)
        #expect(store.pages[0].title == "The Alps")
        #expect(store.pages[0].issuedAt == issuedAt)
    }

    @Test("recordVisit stamps, increments repeat visits, and ignores duplicate threads")
    func recordVisit() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = PassportStore(rootOverride: root)
        let first = Date(timeIntervalSince1970: 100)
        let second = Date(timeIntervalSince1970: 200)
        store.ensurePage(setId: "alps", title: "Alps", issuedAt: first)

        store.recordVisit(
            threadID: "thread-1", setId: "alps", placeName: "  Lake Como ", photoID: nil, date: first)
        store.recordVisit(
            threadID: "thread-2", setId: "alps", placeName: "lake como", photoID: "photo-2", date: second)
        store.recordVisit(
            threadID: "thread-2", setId: "alps", placeName: "Lake Como", photoID: "photo-3", date: Date(timeIntervalSince1970: 300))

        #expect(store.pages[0].stamps.count == 1)
        #expect(store.pages[0].stamps[0].id == "lake-como")
        #expect(store.pages[0].stamps[0].placeName == "Lake Como")
        #expect(store.pages[0].stamps[0].visitCount == 2)
        #expect(store.pages[0].stamps[0].photoID == "photo-2")
        #expect(store.pages[0].stamps[0].lastVisitedAt == second)
        #expect(store.stampedThreadIDs == ["thread-1", "thread-2"])
    }

    @Test("recordVisit matches punctuation variants by canonical slug")
    func recordVisitSlugCanonicalization() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = PassportStore(rootOverride: root)
        let first = Date(timeIntervalSince1970: 100)
        let second = Date(timeIntervalSince1970: 200)
        store.ensurePage(setId: "cornwall", title: "Cornwall", issuedAt: first)

        store.recordVisit(
            threadID: "thread-st-ives-1",
            setId: "cornwall",
            placeName: "St. Ives",
            photoID: nil,
            date: first)
        store.recordVisit(
            threadID: "thread-st-ives-2",
            setId: "cornwall",
            placeName: "St Ives",
            photoID: "st-ives-photo",
            date: second)

        #expect(store.pages[0].stamps.count == 1)
        #expect(store.pages[0].stamps[0].id == "st-ives")
        #expect(store.pages[0].stamps[0].visitCount == 2)
        #expect(store.pages[0].stamps[0].photoID == "st-ives-photo")
    }

    @Test("load repairs persisted stamp slug collisions")
    func loadRepairsSlugCollisions() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = Date(timeIntervalSince1970: 100)
        let second = Date(timeIntervalSince1970: 200)
        let file = PassportFile(
            pages: [
                PassportPage(
                    setId: "cornwall",
                    title: "Cornwall",
                    issuedAt: first,
                    stamps: [
                        PassportStamp(
                            placeName: "St. Ives",
                            photoID: nil,
                            firstVisitedAt: first,
                            lastVisitedAt: first.addingTimeInterval(50),
                            visitCount: 2),
                        PassportStamp(
                            placeName: "St Ives",
                            photoID: "st-ives-photo",
                            firstVisitedAt: second,
                            lastVisitedAt: second.addingTimeInterval(100),
                            visitCount: 3),
                    ]
                )
            ])
        try JSONEncoder().encode(file).write(to: root.appendingPathComponent("passport.json"))

        let store = PassportStore(rootOverride: root)
        let stamps = try #require(store.pages.first?.stamps)
        #expect(stamps.count == 1)
        #expect(stamps[0].id == "st-ives")
        #expect(stamps[0].placeName == "St. Ives")
        #expect(stamps[0].visitCount == 5)
        #expect(stamps[0].firstVisitedAt == first)
        #expect(stamps[0].lastVisitedAt == second.addingTimeInterval(100))
        #expect(stamps[0].photoID == "st-ives-photo")
    }

    @Test("recordVisit does not stamp the bare set title")
    func bareSetTitleIsSkipped() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = PassportStore(rootOverride: root)
        let date = Date(timeIntervalSince1970: 100)
        store.ensurePage(setId: "alps", title: "The Alps", issuedAt: date)

        store.recordVisit(
            threadID: "thread-1", setId: "alps", placeName: " the alps ", photoID: "photo", date: date)

        #expect(store.pages[0].stamps.isEmpty)
        #expect(store.stampedThreadIDs.contains("thread-1"))
    }

    @Test("backfill is idempotent and substitutes now for the builtin epoch")
    func backfillIdempotency() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = PassportStore(rootOverride: root)
        let now = Date(timeIntervalSince1970: 500)
        let customDate = Date(timeIntervalSince1970: 200)
        let sets = [
            makeSet(id: ScenerySet.dolomitesID, title: "Dolomites", createdAt: Date(timeIntervalSince1970: 0)),
            makeSet(id: "kyoto", title: "Kyoto", createdAt: customDate),
        ]
        let names: [String: [String: String]] = [
            ScenerySet.dolomitesID: ["thread-1": "Tre Cime", "thread-2": "Dolomites"],
            "kyoto": ["thread-3": "Fushimi Inari"],
        ]
        let assignments = [
            "thread-1": SceneryAssignment(photoID: "photo-1"),
            "thread-3": SceneryAssignment(photoID: "photo-3", setId: "kyoto"),
        ]

        store.backfill(sets: sets, namesBySet: names, assignments: assignments, now: now)
        let firstPages = store.pages
        let firstLedger = store.stampedThreadIDs
        store.backfill(sets: sets, namesBySet: names, assignments: assignments, now: now)

        #expect(store.pages == firstPages)
        #expect(store.stampedThreadIDs == firstLedger)
        #expect(store.pages.first(where: { $0.setId == ScenerySet.dolomitesID })?.issuedAt == now)
        #expect(store.pages.first(where: { $0.setId == "kyoto" })?.issuedAt == customDate)
        #expect(store.pages.first(where: { $0.setId == ScenerySet.dolomitesID })?.stamps.map(\.photoID) == ["photo-1"])
        #expect(store.pages.first(where: { $0.setId == "kyoto" })?.stamps.first?.photoID == "photo-3")
    }

    @Test("missing passport file stays writable")
    func missingFileStaysWritable() throws {
        let missingRoot = try tempRoot()
        defer { try? FileManager.default.removeItem(at: missingRoot) }
        let missing = PassportStore(rootOverride: missingRoot)
        #expect(missing.pages.isEmpty)
        #expect(missing.stampedThreadIDs.isEmpty)

        missing.recordVisit(
            threadID: "thread-missing",
            setId: "alps",
            placeName: "Lake Como",
            photoID: nil,
            date: Date(timeIntervalSince1970: 100))
        #expect(missing.pages.count == 1)
        #expect(
            FileManager.default.fileExists(
                atPath: missingRoot.appendingPathComponent("passport.json").path))
    }

    @Test("corrupt passport file blocks saves and preserves its bytes")
    func corruptFileBlocksSaves() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let original = Data("not json".utf8)
        let fileURL = root.appendingPathComponent("passport.json")
        try original.write(to: fileURL)

        let corrupt = PassportStore(rootOverride: root)
        #expect(corrupt.pages.isEmpty)
        #expect(corrupt.stampedThreadIDs.isEmpty)
        corrupt.recordVisit(
            threadID: "thread-corrupt",
            setId: "alps",
            placeName: "Lake Como",
            photoID: nil,
            date: Date(timeIntervalSince1970: 100))
        #expect(try Data(contentsOf: fileURL) == original)
    }

    @Test("newer passport file blocks saves and preserves its bytes")
    func newerFileBlocksSaves() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appendingPathComponent("passport.json")
        let original = try JSONEncoder().encode(PassportFile(version: 2))
        try original.write(to: fileURL)

        let newer = PassportStore(rootOverride: root)
        #expect(newer.pages.isEmpty)
        #expect(newer.stampedThreadIDs.isEmpty)
        newer.recordVisit(
            threadID: "thread-newer",
            setId: "alps",
            placeName: "Lake Como",
            photoID: nil,
            date: Date(timeIntervalSince1970: 100))
        #expect(try Data(contentsOf: fileURL) == original)
    }
}

@Suite("Passport composer integration", .serialized)
@MainActor
struct PassportComposerIntegrationTests {
    private func tempRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("passport-compose-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func makeClient() -> UnsplashClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PassportUnsplashSearchStub.self]
        let session = URLSession(configuration: config)
        return UnsplashClient(accessKey: "test-key", session: session)!
    }

    private func makeSet(id: String, title: String) -> ScenerySet {
        ScenerySet(
            id: id,
            title: title,
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 100),
            queries: [],
            sceneNames: [])
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

    private func response() -> GeneratedScenerySet {
        GeneratedScenerySet(
            sceneNames: ["Place"],
            queries: [GeneratedSceneryQuery(text: "place landscape")],
            locations: nil)
    }

    @Test("successful creation mints exactly one page")
    func successfulCreateMintsPage() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        PassportUnsplashSearchStub.resultsByQuery = [
            "*": [UnsplashSearchStub.photoJSON(id: "photo-1")]
        ]
        let scenery = SceneryStore(client: nil, root: root)
        scenery.reloadFromDiskForTesting()
        let passport = PassportStore(rootOverride: root)
        let composer = SceneSetComposer(
            store: scenery,
            backend: FixedSceneryBackend(response: response()),
            client: makeClient(),
            passport: passport)

        composer.createSet(location: "Iceland")
        let state = await awaitFinished(composer: composer)

        guard case .finished(let setId) = state else {
            Issue.record("expected finished, got \(state)")
            return
        }
        #expect(passport.pages.count == 1)
        #expect(passport.pages[0].setId == setId)
        #expect(passport.pages[0].title == "Iceland")
    }

    @Test("regeneration does not mint a page")
    func regenerationMintsNoPage() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        PassportUnsplashSearchStub.resultsByQuery = [
            "*": [UnsplashSearchStub.photoJSON(id: "photo-1")]
        ]
        let scenery = SceneryStore(client: nil, root: root)
        scenery.reloadFromDiskForTesting()
        let existingID = "iceland-existing"
        scenery.registerSet(
            makeSet(id: existingID, title: "Iceland"),
            pool: [
                SceneryPhoto(
                    id: "old-photo",
                    name: "Place",
                    averageColorHex: "#000000",
                    heroURL: URL(string: "https://images.unsplash.com/old")!,
                    thumbURL: URL(string: "https://images.unsplash.com/old-t")!,
                    rawURL: nil,
                    downloadLocationURL: nil,
                    photographerName: "Tester",
                    photographerProfileURL: nil)
            ])
        let passport = PassportStore(rootOverride: root)
        let composer = SceneSetComposer(
            store: scenery,
            backend: FixedSceneryBackend(response: response()),
            client: makeClient(),
            passport: passport)

        composer.createSet(location: "Iceland", replacingSetId: existingID)
        let state = await awaitFinished(composer: composer)

        guard case .finished = state else {
            Issue.record("expected finished, got \(state)")
            return
        }
        #expect(passport.pages.isEmpty)
    }

    @Test("cancellation before finish does not mint a page")
    func cancellationMintsNoPage() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let scenery = SceneryStore(client: nil, root: root)
        scenery.reloadFromDiskForTesting()
        let backend = FixedSceneryBackend(response: response())
        backend.generationDelay = .seconds(1)
        let passport = PassportStore(rootOverride: root)
        let composer = SceneSetComposer(
            store: scenery,
            backend: backend,
            client: makeClient(),
            passport: passport)

        composer.createSet(location: "Iceland")
        try? await Task.sleep(for: .milliseconds(20))
        composer.cancel()
        let state = await awaitFinished(composer: composer)

        #expect(state == SceneSetComposer.State.failed(.cancelled))
        #expect(passport.pages.isEmpty)
    }
}

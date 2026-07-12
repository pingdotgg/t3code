import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Passport display", .serialized)
@MainActor
struct PassportDisplayTests {
    private func tempRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("passport-display-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func makeSet(
        id: String,
        title: String,
        createdAt: Date,
        sceneNames: [String]
    ) -> ScenerySet {
        ScenerySet(
            id: id,
            title: title,
            origin: id == ScenerySet.dolomitesID ? .builtin : .custom,
            createdAt: createdAt,
            queries: [],
            sceneNames: sceneNames)
    }

    @Test("unions set names and stamps case-insensitively")
    func unionAndPartition() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let first = Date(timeIntervalSince1970: 100)
        let passport = PassportStore(rootOverride: root)
        passport.ensurePage(setId: "alps", title: "Alps", issuedAt: first)
        passport.recordVisit(
            threadID: "thread-seceda",
            setId: "alps",
            placeName: "seceda",
            photoID: "photo-seceda",
            date: first)
        passport.recordVisit(
            threadID: "thread-extra",
            setId: "alps",
            placeName: "Lake Como",
            photoID: nil,
            date: first.addingTimeInterval(10))

        let scenerySet = makeSet(
            id: "alps",
            title: "Alps",
            createdAt: first,
            sceneNames: ["Seceda", "Tre Cime", "tre cime"])
        let display = PassportPageDisplay(page: passport.pages[0], scenerySet: scenerySet)

        #expect(display.places.map(\.name) == ["Seceda", "Tre Cime", "Lake Como"])
        #expect(display.places.map(\.isVisited) == [true, false, true])
        #expect(display.collectedCount == 2)
        #expect(display.totalCount == 3)
        #expect(display.progress > 0.66 && display.progress < 0.67)
    }

    @Test("deleted set pages show only their persisted stamps")
    func deletedSetFallback() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let passport = PassportStore(rootOverride: root)
        passport.ensurePage(
            setId: "deleted-set",
            title: "Old Places",
            issuedAt: Date(timeIntervalSince1970: 100))
        passport.recordVisit(
            threadID: "thread-old-place",
            setId: "deleted-set",
            placeName: "Old Place",
            photoID: nil,
            date: Date(timeIntervalSince1970: 200))

        let display = PassportPageDisplay(page: passport.pages[0], scenerySet: nil)

        #expect(display.places.map(\.name) == ["Old Place"])
        #expect(display.places.allSatisfy { $0.isVisited })
        #expect(display.collectedCount == 1)
        #expect(display.totalCount == 1)
        #expect(display.progress == 1)
    }

    @Test("resolved default page comes first, then issue date")
    func pageOrdering() {
        let old = Date(timeIntervalSince1970: 100)
        let newest = Date(timeIntervalSince1970: 300)
        let pages = [
            PassportPage(setId: "kyoto", title: "Kyoto", issuedAt: newest),
            PassportPage(setId: ScenerySet.dolomitesID, title: "Dolomites", issuedAt: newest),
            PassportPage(setId: "alps", title: "Alps", issuedAt: old),
        ]
        let sets = [
            makeSet(
                id: ScenerySet.dolomitesID,
                title: "Dolomites",
                createdAt: old,
                sceneNames: []),
            makeSet(id: "kyoto", title: "Kyoto", createdAt: newest, sceneNames: []),
            makeSet(id: "alps", title: "Alps", createdAt: old, sceneNames: []),
        ]

        let ordered = PassportPageDisplay.orderedPages(
            pages: pages,
            scenerySets: sets,
            defaultSetId: ScenerySet.dolomitesID)
        #expect(ordered.map(\.setId) == [ScenerySet.dolomitesID, "alps", "kyoto"])

        let chronological = PassportPageDisplay.orderedPages(
            pages: pages,
            scenerySets: sets,
            defaultSetId: "missing")
        #expect(chronological.map(\.setId) == ["alps", ScenerySet.dolomitesID, "kyoto"])
    }
}

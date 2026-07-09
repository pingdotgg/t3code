import Foundation
import Observation
import Testing

@testable import SergeCodeMac

@Suite("Scenery rotation buckets")
struct SceneryRotationBucketTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private func date(month: Int = 4, hour: Int, minute: Int) -> Date {
        calendar.date(
            from: DateComponents(
                year: 2026, month: month, day: 15, hour: hour, minute: minute))!
    }

    @Test(
        "time boundaries map to dawn, day, dusk, and night",
        arguments: [
            (5, 29, SceneryTimeOfDay.night),
            (5, 30, SceneryTimeOfDay.dawn),
            (7, 59, SceneryTimeOfDay.dawn),
            (8, 0, SceneryTimeOfDay.day),
            (16, 59, SceneryTimeOfDay.day),
            (17, 0, SceneryTimeOfDay.dusk),
            (20, 29, SceneryTimeOfDay.dusk),
            (20, 30, SceneryTimeOfDay.night),
        ])
    func timeBoundaries(hour: Int, minute: Int, expected: SceneryTimeOfDay) {
        let bucket = SceneryBucket.compute(
            for: date(hour: hour, minute: minute), calendar: calendar)
        #expect(bucket.timeOfDay == expected)
    }

    @Test(
        "months use northern hemisphere seasons",
        arguments: [
            (2, ScenerySeason.winter),
            (3, ScenerySeason.spring),
            (6, ScenerySeason.summer),
            (9, ScenerySeason.autumn),
            (12, ScenerySeason.winter),
        ])
    func seasons(month: Int, expected: ScenerySeason) {
        let bucket = SceneryBucket.compute(
            for: date(month: month, hour: 12, minute: 0), calendar: calendar)
        #expect(bucket.season == expected)
    }
}

@Suite("Scenery rotation selection")
struct SceneryRotationSelectionTests {
    private func photo(_ id: String) -> SceneryPhoto {
        SceneryPhoto(
            id: id,
            name: id,
            averageColorHex: nil,
            heroURL: URL(string: "https://example.com/\(id)-hero.jpg")!,
            thumbURL: URL(string: "https://example.com/\(id)-thumb.jpg")!,
            rawURL: nil,
            downloadLocationURL: nil,
            photographerName: "Tester",
            photographerProfileURL: nil)
    }

    @Test("matching tags win, then untagged, then any")
    func preferenceOrder() {
        let photos = [photo("match"), photo("untagged"), photo("other")]
        let tags = [
            "match": SceneryPhotoTags(timeOfDay: .dawn, season: .spring),
            "other": SceneryPhotoTags(timeOfDay: .night, season: .winter),
        ]

        let matching = SceneryPhotoSelection.preferredCandidates(
            photos: photos,
            tagsByPhotoID: tags,
            bucket: SceneryBucket(timeOfDay: .dawn, season: .spring))
        #expect(matching.map(\.id) == ["match"])

        let untagged = SceneryPhotoSelection.preferredCandidates(
            photos: photos,
            tagsByPhotoID: tags,
            bucket: SceneryBucket(timeOfDay: .day, season: .summer))
        #expect(untagged.map(\.id) == ["untagged"])

        let allTagged = [photo("match"), photo("other")]
        let any = SceneryPhotoSelection.preferredCandidates(
            photos: allTagged,
            tagsByPhotoID: tags,
            bucket: SceneryBucket(timeOfDay: .day, season: .summer))
        #expect(any.map(\.id) == ["match", "other"])
    }

    @Test("FNV selection is deterministic within the preferred subset")
    func deterministicSelection() throws {
        let photos = [photo("dawn-a"), photo("dawn-b"), photo("untagged")]
        let tags = [
            "dawn-a": SceneryPhotoTags(timeOfDay: .dawn),
            "dawn-b": SceneryPhotoTags(timeOfDay: .dawn),
        ]
        let bucket = SceneryBucket(timeOfDay: .dawn, season: .summer)
        let first = try #require(
            SceneryPhotoSelection.select(
                photos: photos, tagsByPhotoID: tags, bucket: bucket, seed: "thread-42"))
        let second = try #require(
            SceneryPhotoSelection.select(
                photos: photos, tagsByPhotoID: tags, bucket: bucket, seed: "thread-42"))
        let preferred = Array(photos.prefix(2))
        let expected = preferred[AlpineTheme.stableIndex("thread-42", preferred.count)]

        #expect(first == second)
        #expect(first == expected)
    }
}

@Suite("Scenery photo tag sidecar")
@MainActor
struct SceneryPhotoTagSidecarTests {
    private func tempRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-rotation-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func photo(_ id: String) -> SceneryPhoto {
        SceneryPhoto(
            id: id,
            name: id,
            averageColorHex: "#112233",
            heroURL: URL(string: "https://example.com/\(id)-hero.jpg")!,
            thumbURL: URL(string: "https://example.com/\(id)-thumb.jpg")!,
            rawURL: nil,
            downloadLocationURL: nil,
            photographerName: "Tester",
            photographerProfileURL: nil)
    }

    private func testSet() -> ScenerySet {
        ScenerySet(
            id: "rotation-test",
            title: "Rotation",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [
                SceneryQuery(text: "rotation sunrise", timeOfDay: .dawn, season: .spring),
                SceneryQuery(text: "rotation landscape"),
            ],
            sceneNames: ["Dawn", "Anytime"])
    }

    @Test("sidecar round-trips while untagged photos have no entry")
    func sidecarRoundTrip() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let tagged = photo("tagged")
        let untagged = photo("untagged")
        let expectedTags = [
            tagged.id: SceneryPhotoTags(timeOfDay: .dawn, season: .spring)
        ]

        let writer = SceneryStore(client: nil, root: root)
        writer.reloadFromDiskForTesting()
        writer.registerSetForTesting(
            testSet(), pool: [tagged, untagged], photoTags: expectedTags)

        let sidecarURL = root.appendingPathComponent("sets/rotation-test/photo-tags.json")
        let sidecarObject = try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: sidecarURL))
                as? [String: [String: String]])
        #expect(sidecarObject["tagged"] == ["season": "spring", "timeOfDay": "dawn"])
        #expect(sidecarObject["untagged"] == nil)

        let reader = SceneryStore(client: nil, root: root)
        reader.reloadFromDiskForTesting()
        #expect(reader.photoTagsForTesting(setId: "rotation-test") == expectedTags)
    }

    @Test("pool JSON retains the existing mobile-shared shape")
    func poolShapeUnchanged() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let tagged = photo("tagged")
        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.registerSetForTesting(
            testSet(),
            pool: [tagged],
            photoTags: [tagged.id: SceneryPhotoTags(timeOfDay: .dawn, season: .spring)])

        let poolData = try Data(
            contentsOf: root.appendingPathComponent("sets/rotation-test/pool.json"))
        let poolObject = try #require(
            JSONSerialization.jsonObject(with: poolData) as? [String: Any])
        #expect(Set(poolObject.keys) == ["fetchedAt", "photos"])
        let photoObject = try #require((poolObject["photos"] as? [[String: Any]])?.first)
        let standaloneObject = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(tagged)) as? [String: Any])
        #expect(Set(photoObject.keys) == Set(standaloneObject.keys))
        #expect(photoObject["timeOfDay"] == nil)
        #expect(photoObject["season"] == nil)
        #expect(photoObject["tags"] == nil)
    }

    @Test("bucket-aware surfaces rotate while assigned threads stay pinned")
    func storeSurfacesAndPins() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let dawn = try #require(
            calendar.date(from: DateComponents(year: 2026, month: 4, day: 15, hour: 6)))
        let night = try #require(
            calendar.date(from: DateComponents(year: 2026, month: 4, day: 15, hour: 22)))
        let dawnPhoto = photo("dawn")
        let nightPhoto = photo("night")
        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.registerSetForTesting(
            ScenerySet.makeBuiltinDolomites(),
            pool: [dawnPhoto, nightPhoto],
            photoTags: [
                dawnPhoto.id: SceneryPhotoTags(timeOfDay: .dawn),
                nightPhoto.id: SceneryPhotoTags(timeOfDay: .night),
            ])

        store.reevaluateRotation(at: dawn, calendar: calendar)
        #expect(store.peekNextScene()?.id == dawnPhoto.id)
        #expect(store.dailyFeatured()?.id == dawnPhoto.id)
        store.assign(photoID: dawnPhoto.id, name: dawnPhoto.name, to: "existing-thread")

        store.reevaluateRotation(at: night, calendar: calendar)
        #expect(store.peekNextScene()?.id == nightPhoto.id)
        #expect(store.dailyFeatured()?.id == nightPhoto.id)
        #expect(store.photo(for: "existing-thread")?.id == dawnPhoto.id)
    }
}

@Suite("Scenery rotation observation")
@MainActor
struct SceneryRotationObservationTests {
    private func photo(_ id: String) -> SceneryPhoto {
        SceneryPhoto(
            id: id,
            name: id,
            averageColorHex: "#112233",
            heroURL: URL(string: "https://example.com/\(id)-hero.jpg")!,
            thumbURL: URL(string: "https://example.com/\(id)-thumb.jpg")!,
            rawURL: nil,
            downloadLocationURL: nil,
            photographerName: "Tester",
            photographerProfileURL: nil)
    }

    @Test("bucket mutation invalidates dailyFeatured/peekNextScene; same bucket is a no-op")
    func observationFiresOnBucketChange() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-obs-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let dawn = try #require(
            calendar.date(from: DateComponents(year: 2026, month: 4, day: 15, hour: 6)))
        let night = try #require(
            calendar.date(from: DateComponents(year: 2026, month: 4, day: 15, hour: 22)))

        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()
        store.registerSetForTesting(
            ScenerySet.makeBuiltinDolomites(),
            pool: [photo("dawn"), photo("night")],
            photoTags: [
                "dawn": SceneryPhotoTags(timeOfDay: .dawn),
                "night": SceneryPhotoTags(timeOfDay: .night),
            ])
        store.reevaluateRotation(at: dawn, calendar: calendar)

        // dailyFeatured() reads rotationBucket/rotationDayKey — Observation must
        // fire so EmptyStateView's body re-runs when the bucket flips.
        let dailyChanged = ObservationFlag()
        withObservationTracking {
            _ = store.dailyFeatured()
        } onChange: {
            dailyChanged.set()
        }
        store.reevaluateRotation(at: night, calendar: calendar)
        #expect(dailyChanged.value)

        // Same bucket/day must not write (activation storms should not repaint).
        store.reevaluateRotation(at: dawn, calendar: calendar)
        let noopChanged = ObservationFlag()
        withObservationTracking {
            _ = store.dailyFeatured()
        } onChange: {
            noopChanged.set()
        }
        store.reevaluateRotation(at: dawn, calendar: calendar)
        #expect(!noopChanged.value)

        // peekNextScene() path (NewSessionSheet) — re-register after prior onChange.
        let peekChanged = ObservationFlag()
        withObservationTracking {
            _ = store.peekNextScene()
        } onChange: {
            peekChanged.set()
        }
        store.reevaluateRotation(at: night, calendar: calendar)
        #expect(peekChanged.value)
    }
}

/// `@Sendable` onChange needs a class box; mutations are main-actor test only.
private final class ObservationFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = false
    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _value
    }
    func set() {
        lock.lock()
        _value = true
        lock.unlock()
    }
}

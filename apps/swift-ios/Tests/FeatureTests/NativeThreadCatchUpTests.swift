import Foundation
import XCTest
@testable import T3Code

@MainActor
@available(iOS 18.0, *)
final class NativeThreadCatchUpTests: XCTestCase {
    func testFaultInjectedOmittedMessageRepairsAtEqualWatermark() async throws {
        // Deliberate application-delivery omission, not simulated TCP packet loss.
        // HTTP is authoritative for both messages; only event 4 reaches the client.
        for paginated in [false, true] {
            let clock = SelectedReconciliationClock()
            let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
            let fixture = try await CatchUpFixture.make(
                reconciliationClock: clock,
                reconciliationReceipt: { receipts.continuation.yield($0) }
            )
            retainForSelectedReconciliationTest(fixture, clock: clock)
            var ticks = clock.requests.stream.makeAsyncIterator()
            var completed = receipts.stream.makeAsyncIterator()
            var requests = fixture.requests.makeAsyncIterator()
            var events = fixture.client.events().makeAsyncIterator()
            _ = try await fixture.client.loadThread(id: fixture.firstID)
            let detail = try await nextThreadRequest(&requests)
            try await detail.synchronize()
            _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
            // The missing event would have sequence 3; later event 4 is valid.
            try await detail.sendMessage(text: "Later delivered message", sequence: 4)
            try await detail.synchronize()
            _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
            let before = try rawThreadForHistoryTest(fixture.client)
            XCTAssertEqual(before.messages.map(\.id), ["message-4"])
            await fixture.http.setFaultInjectionMessages(paginated: paginated)
            for attempt in 1...2 {
                let pendingTick = await ticks.next()
                let tick = try XCTUnwrap(pendingTick)
                clock.advance(by: .seconds(30))
                tick.release()
                let receipt = await completed.next()
                XCTAssertEqual(receipt, .finished(threadID: fixture.firstID))
                let raw = try rawThreadForHistoryTest(fixture.client)
                let reads = await fixture.http.threadRequests.count
                XCTAssertEqual(reads, attempt + 1)
                print("FAULT_INJECTED_EQUAL_WATERMARK paginated=\(paginated) attempt=\(attempt) reads=\(reads) messageIDs=\(raw.messages.map(\.id))")
                XCTAssertEqual(Set(raw.messages.map(\.id)), Set(["message-3", "message-4"]),
                    "An authoritative equal-watermark read must repair omitted message 3; attempt \(attempt).")
            }
            await fixture.client.disconnect()
        }
    }


    func testSelectedReconciliationPreservesExplicitOlderRawFanoutBelowTenUsers() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        await fixture.http.setRawFanoutMessages(sequence: 300)
        let initial = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertEqual(initial.messages.count, 150)
        XCTAssertEqual(initial.messages.filter { $0.role == .user }.count, 1)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        let loaded = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        XCTAssertEqual(loaded?.messages.count, 300)
        XCTAssertEqual(loaded?.messages.filter { $0.role == .user }.count, 2)
        XCTAssertEqual(loaded?.messages.first?.text, "Raw 0")
        XCTAssertEqual(loaded?.page?.hasMore, false)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.editLatestUserText("Changed raw tail", sequence: 301)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        _ = await completed.next()
        try await detail.synchronize()
        let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(value?.messages.last?.text, "Changed raw tail")
        XCTAssertEqual(value?.messages.count, 300, "Quiet repair must preserve explicitly loaded raw-turn history even below ten user rows.")
        XCTAssertEqual(value?.messages.first?.text, "Raw 0")
        XCTAssertNotEqual(value?.page?.hasMore, true)
        print("RAW_CAP_PROOF initial=\(initial.messages.count) loaded=\(loaded?.messages.count ?? -1) loadedUsers=\(loaded?.messages.filter { $0.role == .user }.count ?? -1) repaired=\(value?.messages.count ?? -1)")
        print("RAW_CAP_REQUESTS \(await fixture.http.threadRequests.map { $0.url!.absoluteString })")
    }

    func testSelectedReconciliationPreservesExplicitOlderRawFanoutWithZeroUsers() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        await fixture.http.setRawFanoutMessages(sequence: 300, userSlots: [])
        let initial = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertEqual(initial.messages.count, 150)
        XCTAssertEqual(initial.messages.filter { $0.role == .user }.count, 0)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        let loaded = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        XCTAssertEqual(loaded?.messages.count, 300)
        XCTAssertEqual(loaded?.messages.filter { $0.role == .user }.count, 0)
        XCTAssertEqual(loaded?.messages.first?.text, "Raw 0")
        XCTAssertEqual(loaded?.page?.hasMore, false)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.editLatestUserText("Changed raw tail", sequence: 301)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        _ = await completed.next()
        try await detail.synchronize()
        let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(value?.messages.last?.text, "Changed raw tail")
        XCTAssertEqual(value?.messages.count, 300, "Quiet repair must preserve explicitly loaded raw-turn history even below ten user rows.")
        XCTAssertEqual(value?.messages.first?.text, "Raw 0")
        XCTAssertNotEqual(value?.page?.hasMore, true)
        print("RAW_CAP_PROOF initial=\(initial.messages.count) loaded=\(loaded?.messages.count ?? -1) loadedUsers=\(loaded?.messages.filter { $0.role == .user }.count ?? -1) repaired=\(value?.messages.count ?? -1)")
        print("RAW_CAP_REQUESTS \(await fixture.http.threadRequests.map { $0.url!.absoluteString })")
    }

    func testSelectedReconciliationRetainsRawCollectionsAndAcceptsAuthoritativeDeletion() async throws {
        for collection in ["activities", "checkpoints"] {
            let clock = SelectedReconciliationClock()
            let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
            let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
            retainForSelectedReconciliationTest(fixture, clock: clock)
            var ticks = clock.requests.stream.makeAsyncIterator()
            var completed = receipts.stream.makeAsyncIterator()
            var requests = fixture.requests.makeAsyncIterator()
            var events = fixture.client.events().makeAsyncIterator()
            await fixture.http.setRawFanoutMessages(sequence: 300, userSlots: [], collection: collection)
            _ = try await fixture.client.loadThread(id: fixture.firstID)
            let detail = try await nextThreadRequest(&requests)
            try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
            _ = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
            var raw = try rawThreadForHistoryTest(fixture.client)
            XCTAssertEqual(raw.messages.count, 0)
            XCTAssertEqual(collection == "activities" ? raw.activities.count : raw.checkpoints.count, 300)
            await fixture.http.editLatestUserText("Changed raw tail", sequence: 301)
            let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
            clock.advance(by: .seconds(30)); tick.release(); _ = await completed.next()
            raw = try rawThreadForHistoryTest(fixture.client)
            XCTAssertEqual(collection == "activities" ? raw.activities.count : raw.checkpoints.count, 300)
            var urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
            XCTAssertEqual(urls.count, collection == "activities" ? 4 : 3)
            XCTAssertEqual(urls.last!.contains("turnLimit="), collection == "checkpoints",
                "Only windowed activities need full fallback for an ordinary changed tail.")
            await fixture.http.removePaginatedUser(id: "raw-0", sequence: 302)
            let pendingDelete = await ticks.next(); let deleteTick = try XCTUnwrap(pendingDelete)
            clock.advance(by: .seconds(30)); deleteTick.release(); _ = await completed.next()
            raw = try rawThreadForHistoryTest(fixture.client)
            XCTAssertEqual(collection == "activities" ? raw.activities.count : raw.checkpoints.count, 299)
            XCTAssertFalse(raw.activities.contains { $0.id == "activity-raw-0" })
            XCTAssertFalse(raw.checkpoints.contains { $0.turnId == "turn-raw-0" })
            urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
            XCTAssertEqual(urls.count, collection == "activities" ? 6 : 5)
            XCTAssertFalse(urls.last!.contains("turnLimit="))
            let pendingUnchanged = await ticks.next(); let unchangedTick = try XCTUnwrap(pendingUnchanged)
            clock.advance(by: .seconds(30)); unchangedTick.release(); _ = await completed.next()
            let unchangedURLs = await fixture.http.threadRequests
            XCTAssertEqual(unchangedURLs.count, collection == "activities" ? 8 : 6, "A matching cursor cannot certify omitted rows outside a capped recent window.")
            raw = try rawThreadForHistoryTest(fixture.client)
            XCTAssertEqual(collection == "activities" ? raw.activities.count : raw.checkpoints.count, 299)
        }
    }

    private func rawThreadForHistoryTest(_ client: NativeFeatureClient) throws -> OrchestrationThread {
        // Read-only test inspection: checkpoints are retained raw state and have
        // no standalone published collection in FeatureThreadDetail.
        try XCTUnwrap(Mirror(reflecting: client).children.first { $0.label == "activeRawThread" }?.value as? OrchestrationThread)
    }

    func testSelectedReconciliationRepairsSilentDetailWithoutSyncFlicker() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(
            reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) }
        )
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setResponse(text: "Quiet HTTP repair", sequence: 20)
        let pendingTick = await ticks.next(); let tick = try XCTUnwrap(pendingTick)
        clock.advance(by: .seconds(30)); tick.release()
        let receipt = await completed.next()
        XCTAssertEqual(receipt, .finished(threadID: fixture.firstID))
        try await detail.synchronize()
        var messages: [String] = []
        while let event = await events.next(isolation: #isolation) {
            switch event {
            case let .detail(value), let .detailDelta(value, _): messages = value.messages.map(\.text)
            case .threadSync(fixture.firstID, .live): break
            case .threadSync(fixture.firstID, .catchingUp): XCTFail("Quiet repair must not flash catch-up.")
            default: continue
            }
            if case .threadSync(fixture.firstID, .live) = event { break }
        }
        XCTAssertEqual(messages, ["Quiet HTTP repair"])
        let reads = await fixture.http.threadRequests.count
        XCTAssertEqual(reads, 2)
        await fixture.client.disconnect()
    }

    func testSelectedReconciliationUnchangedSnapshotPublishesNothing() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(
            reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) }
        )
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        let pendingTick = await ticks.next(); let tick = try XCTUnwrap(pendingTick)
        clock.advance(by: .seconds(30)); tick.release()
        _ = await completed.next()
        try await detail.synchronize()
        var publications = 0
        while let event = await events.next(isolation: #isolation) {
            if case .detail = event { publications += 1 }
            if case .detailDelta = event { publications += 1 }
            if case .threadSync(fixture.firstID, .live) = event { break }
        }
        XCTAssertEqual(publications, 0)
        await fixture.client.disconnect()
    }

    func testSelectedReconciliationActualProgressPostponesButMarkerDoesNot() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(
            reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) }
        )
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        let pendingFirst = await ticks.next(); let first = try XCTUnwrap(pendingFirst)
        clock.advance(by: .seconds(20))
        try await detail.sendMessage(text: "Live progress", sequence: 3)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        clock.advance(by: .seconds(10)); first.release()
        let deferred = await completed.next()
        XCTAssertEqual(deferred, .deferred(threadID: fixture.firstID))
        let pendingNext = await ticks.next(); let next = try XCTUnwrap(pendingNext)
        XCTAssertEqual(next.duration, .seconds(20))
        clock.advance(by: .seconds(10))
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        clock.advance(by: .seconds(10)); next.release()
        let finished = await completed.next()
        XCTAssertEqual(finished, .finished(threadID: fixture.firstID))
        let reads = await fixture.http.threadRequests.count
        XCTAssertEqual(reads, 2)
        await fixture.client.disconnect()
    }

    func testSelectedReconciliationRejectsOlderHeldHTTPAfterNewerDetail() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(
            reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) }
        )
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setResponse(text: "Old HTTP", sequence: 3)
        await fixture.http.holdThreadReads(true)
        let pendingTick = await ticks.next(); let tick = try XCTUnwrap(pendingTick)
        clock.advance(by: .seconds(30)); tick.release()
        let held = try await nextHeldRead(&reads)
        try await detail.sendMessage(text: "Newer live response", sequence: 4)
        try await detail.synchronize()
        let live = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(live, ["Newer live response"])
        held.succeed()
        _ = await completed.next()
        try await detail.synchronize()
        let replaced = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertTrue(replaced.isEmpty, "Older HTTP must not republish over newer detail.")
        await fixture.client.disconnect()
    }

    func testSelectedReconciliationBackgroundCancelsItsHeldRead() async throws {
        let clock = SelectedReconciliationClock()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock)
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        let pendingTick = await ticks.next(); let tick = try XCTUnwrap(pendingTick)
        clock.advance(by: .seconds(30)); tick.release()
        let held = try await nextHeldRead(&reads)
        fixture.client.suspendForBackground()
        held.succeed()
        let cancelled = await held.finished.first { _ in true }
        XCTAssertEqual(cancelled, true)
        await fixture.client.disconnect()
    }

    func testSelectedReconciliationRequiredReadKeepsItsFailureAfterQuietRead() async throws {
        let clock = SelectedReconciliationClock()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock)
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        let pendingTick = await ticks.next(); let tick = try XCTUnwrap(pendingTick)
        clock.advance(by: .seconds(30)); tick.release()
        let quiet = try await nextHeldRead(&reads)
        try await detail.invalidate(sequence: 3)
        await nextCatchUp(&events, threadID: fixture.firstID)
        quiet.succeed()
        let required = try await nextHeldRead(&reads)
        required.fail()
        var failure: String?
        while let event = await events.next(isolation: #isolation) {
            if case let .threadSync(id, .failed(message)) = event, id == fixture.firstID {
                failure = message; break
            }
        }
        XCTAssertEqual(failure, URLError(.notConnectedToInternet).localizedDescription)
        await fixture.client.disconnect()
    }

    private func retainForSelectedReconciliationTest(_ fixture: CatchUpFixture, clock: SelectedReconciliationClock? = nil) {
        addTeardownBlock {
            await MainActor.run { clock?.cancelAll() }
            await fixture.http.cancelHeldReads()
            await fixture.client.disconnect()
            await MainActor.run { fixture.cleanUp() }
        }
    }

    func testSelectedReconciliationPreservesLoadedHistoryWhenUnchanged() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(
            reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) }
        )
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        await fixture.http.setPaginatedUserMessages(0..<50, sequence: 50)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        let older = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        XCTAssertEqual(older?.messages.count, 30)
        let retainedPage = older?.page
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        _ = await completed.next()
        try await detail.synchronize()
        let unchanged = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertTrue(unchanged.isEmpty, "An unchanged enlarged window must not publish extra history.")
        let earlier = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        XCTAssertEqual(retainedPage?.beforeCursor, "user-20")
        XCTAssertEqual(earlier?.messages.count, 50)
        let urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
        XCTAssertTrue(urls[2].contains("turnLimit=30"))
        XCTAssertTrue(urls[3].contains("beforeCursor=user-20"))
    }

    func testSelectedReconciliationExpandedGapAndDeletedBoundaryUseAuthoritativeFullRead() async throws {
        for deletedBoundary in [false, true] {
            let clock = SelectedReconciliationClock()
            let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
            let fixture = try await CatchUpFixture.make(
                reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) }
            )
            retainForSelectedReconciliationTest(fixture, clock: clock)
            var ticks = clock.requests.stream.makeAsyncIterator()
            var completed = receipts.stream.makeAsyncIterator()
            var requests = fixture.requests.makeAsyncIterator()
            var events = fixture.client.events().makeAsyncIterator()
            await fixture.http.setPaginatedUserMessages(0..<50, sequence: 50)
            _ = try await fixture.client.loadThread(id: fixture.firstID)
            let detail = try await nextThreadRequest(&requests)
            try await detail.synchronize()
            _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
            _ = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
            try await detail.synchronize()
            _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
            let lower = deletedBoundary ? 21 : 0
            await fixture.http.setPaginatedUserMessages(lower..<110, sequence: 200)
            let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
            clock.advance(by: .seconds(30)); tick.release()
            _ = await completed.next()
            try await detail.synchronize()
            let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
            XCTAssertEqual(messages.first, "User \(lower)")
            XCTAssertEqual(messages.last, "User 109")
            XCTAssertEqual(messages.count, 110 - lower)
            let urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
            XCTAssertEqual(urls.count, 4)
            XCTAssertTrue(urls[2].contains("turnLimit=30"))
            XCTAssertFalse(urls[3].contains("turnLimit="))
        }
    }

    func testSelectedReconciliationUnchangedReadDoesNotInvalidatePendingOlderPage() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(
            reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) }
        )
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        await fixture.http.setPaginatedUserMessages(0..<50, sequence: 50)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        let quiet = try await nextHeldRead(&reads)
        let olderTask = Task { try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID) }
        let olderRead = try await nextHeldRead(&reads)
        quiet.succeed()
        _ = await completed.next()
        olderRead.succeed()
        let older = try await olderTask.value
        XCTAssertEqual(older?.messages.count, 30)
        XCTAssertEqual(older?.page?.beforeCursor, "user-20")
        XCTAssertEqual(older?.page?.isLoading, false)
    }

    func testSelectedReconciliationNavigationRejectsHeldResponse() async throws {
        let clock = SelectedReconciliationClock()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock)
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setResponse(text: "Must not arrive after navigation", sequence: 20)
        await fixture.http.holdThreadReads(true)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        let held = try await nextHeldRead(&reads)
        fixture.client.releaseThread(id: fixture.firstID)
        await fixture.http.holdThreadReads(false)
        _ = try await fixture.client.loadThread(id: fixture.secondID)
        _ = try await nextThreadRequest(&requests)
        held.succeed()
        let cancelled = await held.finished.first { _ in true }
        XCTAssertEqual(cancelled, true)
        fixture.client.releaseThread(id: fixture.secondID)
        let restored = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertFalse(restored.messages.contains { $0.text == "Must not arrive after navigation" })
    }

    func testSelectedReconciliationUsesSelectedPassivePeerRoute() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(
            includePeer: true, reconciliationClock: clock,
            reconciliationReceipt: { receipts.continuation.yield($0) }
        )
        retainForSelectedReconciliationTest(fixture, clock: clock)
        let peerID = FeatureScopedID.thread(environmentID: "two", wireID: "first")
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: peerID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: peerID)
        await fixture.http.setResponse(text: "Peer HTTP repair", sequence: 20)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        let receipt = await completed.next()
        XCTAssertEqual(receipt, .finished(threadID: peerID))
        try await detail.synchronize()
        let messages = await messagesBeforeLive(&events, threadID: peerID)
        XCTAssertEqual(messages, ["Peer HTTP repair"])
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2)
        XCTAssertTrue(reads.allSatisfy { $0.url?.host == "two.example" })
    }

    func testSelectedReconciliationDefaultDeadlineRepairsMessageAndWorkingState() async throws {
        let fixture = try await CatchUpFixture.make()
        retainForSelectedReconciliationTest(fixture)
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        let initial = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertEqual(initial.thread.state, .idle)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setRunningResponse(text: "Default deadline repair", sequence: 20)
        let start = ContinuousClock.now
        var repaired: FeatureThreadDetail?
        while let event = await events.next(isolation: #isolation) {
            switch event {
            case let .detail(value), let .detailDelta(value, _):
                if value.thread.id == fixture.firstID,
                   value.messages.contains(where: { $0.text == "Default deadline repair" }) {
                    repaired = value
                }
            case .threadSync(fixture.firstID, .catchingUp): XCTFail("Quiet recovery must not flash catch-up.")
            default: break
            }
            if repaired != nil { break }
        }
        let elapsed = start.duration(to: .now)
        XCTAssertEqual(repaired?.thread.state, .working)
        XCTAssertGreaterThanOrEqual(elapsed, .seconds(29))
        XCTAssertLessThan(elapsed, .seconds(40))
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2)
        print("DEFAULT_RECONCILIATION elapsed=\(elapsed) state=\(String(describing: repaired?.thread.state)) reads=\(reads.count) bytes=\(await fixture.http.threadResponseBytes)")
    }

    func testSelectedReconciliationRepeatedTailEditsKeepExplicitHistoryExtent() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        await fixture.http.setPaginatedUserMessages(0..<100, sequence: 100)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        _ = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        for edit in 1...3 {
            await fixture.http.editLatestUserText("Tail edit \(edit)", sequence: 100 + edit)
            let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
            clock.advance(by: .seconds(30)); tick.release()
            _ = await completed.next()
            try await detail.synchronize()
            let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
            XCTAssertEqual(value?.messages.count, 30)
            XCTAssertEqual(value?.messages.first?.text, "User 70")
            XCTAssertEqual(value?.messages.last?.text, "Tail edit \(edit)")
            XCTAssertEqual(value?.page?.beforeCursor, "user-70")
        }
        let urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
        XCTAssertEqual(urls.count, 5)
        XCTAssertTrue(urls.dropFirst(2).allSatisfy { $0.contains("turnLimit=30") })
    }

    func testSelectedReconciliationNewUserAddsOnlyRequiredWindowExtent() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        await fixture.http.setPaginatedUserMessages(0..<100, sequence: 100)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        _ = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setPaginatedUserMessages(0..<101, sequence: 101)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        _ = await completed.next()
        try await detail.synchronize()
        let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(value?.messages.count, 31)
        XCTAssertEqual(value?.messages.first?.text, "User 70")
        XCTAssertEqual(value?.messages.last?.text, "User 100")
        XCTAssertEqual(value?.page?.beforeCursor, "user-70")
        let urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
        XCTAssertEqual(urls.count, 4)
        XCTAssertTrue(urls[2].contains("turnLimit=30"))
        if urls.count > 3 { XCTAssertTrue(urls[3].contains("turnLimit=31")) }
    }

    func testSelectedReconciliationUserlessPendingAheadPageRecoversWithoutStreamProgress() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        await fixture.http.setRawFanoutMessages(sequence: 300, userSlots: [])
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.editLatestUserText("New head", sequence: 301)
        let pendingPage = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        XCTAssertEqual(pendingPage?.page?.isLoading, true)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        let receipt = await completed.next()
        XCTAssertEqual(receipt, .finished(threadID: fixture.firstID))
        try await detail.synchronize()
        let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(value?.messages.count, 300)
        XCTAssertEqual(value?.messages.first?.text, "Raw 0")
        XCTAssertEqual(value?.messages.last?.text, "New head")
        XCTAssertNotEqual(value?.page?.isLoading, true)
    }

    func testSelectedReconciliationPendingAheadPageRecoversWithoutStreamProgress() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        await fixture.http.setPaginatedUserMessages(0..<50, sequence: 50)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.editLatestUserText("New head", sequence: 51)
        let pendingPage = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        XCTAssertEqual(pendingPage?.page?.isLoading, true)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        let receipt = await completed.next()
        XCTAssertEqual(receipt, .finished(threadID: fixture.firstID))
        try await detail.synchronize()
        let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(value?.messages.count, 30)
        XCTAssertEqual(value?.messages.first?.text, "User 20")
        XCTAssertEqual(value?.messages.last?.text, "New head")
        XCTAssertEqual(value?.page?.isLoading, false)
    }

    func testSelectedReconciliationUserlessChangedQuietReadYieldsToOlderPageRequest() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        await fixture.http.setRawFanoutMessages(sequence: 300, userSlots: [])
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.editLatestUserText("Changed head", sequence: 301)
        await fixture.http.holdThreadReads(true)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        let quiet = try await nextHeldRead(&reads)
        let olderTask = Task { try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID) }
        let olderRead = try await nextHeldRead(&reads)
        quiet.succeed(); _ = await completed.next()
        olderRead.succeed()
        let waitingOlder = try await olderTask.value
        XCTAssertEqual(waitingOlder?.page?.isLoading, true, "Optional quiet read must not invalidate the user's older-page epoch.")
        await fixture.http.holdThreadReads(false)
        let nextPending = await ticks.next(); let nextTick = try XCTUnwrap(nextPending)
        clock.advance(by: .seconds(30)); nextTick.release()
        _ = await completed.next()
        try await detail.synchronize()
        let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(value?.messages.count, 300)
        XCTAssertEqual(value?.messages.first?.text, "Raw 0")
        XCTAssertEqual(value?.messages.last?.text, "Changed head")
        XCTAssertNotEqual(value?.page?.isLoading, true)
    }

    func testSelectedReconciliationChangedQuietReadYieldsToOlderPageRequest() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        await fixture.http.setPaginatedUserMessages(0..<50, sequence: 50)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.editLatestUserText("Changed head", sequence: 51)
        await fixture.http.holdThreadReads(true)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        let quiet = try await nextHeldRead(&reads)
        let olderTask = Task { try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID) }
        let olderRead = try await nextHeldRead(&reads)
        quiet.succeed(); _ = await completed.next()
        olderRead.succeed()
        let waitingOlder = try await olderTask.value
        XCTAssertEqual(waitingOlder?.page?.isLoading, true, "Optional quiet read must not invalidate the user's older-page epoch.")
        await fixture.http.holdThreadReads(false)
        let nextPending = await ticks.next(); let nextTick = try XCTUnwrap(nextPending)
        clock.advance(by: .seconds(30)); nextTick.release()
        _ = await completed.next()
        try await detail.synchronize()
        let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(value?.messages.count, 30)
        XCTAssertEqual(value?.messages.first?.text, "User 20")
        XCTAssertEqual(value?.messages.last?.text, "Changed head")
        XCTAssertEqual(value?.page?.isLoading, false)
    }

    private func selectedDetailBeforeLive(_ events: inout AsyncStream<FeatureEvent>.Iterator, threadID: String) async -> FeatureThreadDetail? {
        var value: FeatureThreadDetail?
        while let event = await events.next(isolation: #isolation) {
            switch event {
            case let .detail(detail), let .detailDelta(detail, _):
                if detail.thread.id == threadID { value = detail }
            case .threadSync(threadID, .live): return value
            default: break
            }
        }
        return value
    }

    func testSelectedReconciliationMovingAdaptiveHeadDefersWithoutFullRead() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        await fixture.http.setPaginatedUserMessages(0..<100, sequence: 100)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        _ = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setPaginatedUserMessages(0..<101, sequence: 101)
        await fixture.http.holdThreadReads(true)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release()
        let first = try await nextHeldRead(&reads)
        await fixture.http.setPaginatedUserMessages(0..<102, sequence: 102)
        first.succeed()
        let adaptive = try await nextHeldRead(&reads)
        adaptive.succeed(); _ = await completed.next()
        var urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
        XCTAssertEqual(urls.count, 4)
        XCTAssertTrue(urls[2].contains("turnLimit=30"))
        XCTAssertTrue(urls[3].contains("turnLimit=31"))
        try await detail.synchronize()
        let unchanged = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertNil(unchanged, "A moving second read must not widen or replace the retained range.")
        await fixture.http.holdThreadReads(false)
        let nextPending = await ticks.next(); let next = try XCTUnwrap(nextPending)
        clock.advance(by: .seconds(30)); next.release(); _ = await completed.next()
        try await detail.synchronize()
        let repaired = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(repaired?.messages.count, 32)
        XCTAssertEqual(repaired?.messages.first?.text, "User 70")
        XCTAssertEqual(repaired?.messages.last?.text, "User 101")
        urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
        XCTAssertEqual(urls.count, 6)
        XCTAssertTrue(urls[5].contains("turnLimit=32"))
    }

    func testSelectedReconciliationDeletedAnchorAfterAdaptiveReadUsesOneFullFallback() async throws {
        let clock = SelectedReconciliationClock()
        let receipts = AsyncStream<NativeSelectedThreadReconciliationReceipt>.makeStream()
        let fixture = try await CatchUpFixture.make(reconciliationClock: clock, reconciliationReceipt: { receipts.continuation.yield($0) })
        retainForSelectedReconciliationTest(fixture, clock: clock)
        var ticks = clock.requests.stream.makeAsyncIterator()
        var completed = receipts.stream.makeAsyncIterator()
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        await fixture.http.setPaginatedUserMessages(0..<100, sequence: 100)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        _ = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        try await detail.synchronize(); _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setPaginatedUserMessages(0..<101, sequence: 101)
        await fixture.http.removePaginatedUser(id: "user-70", sequence: 102)
        let pending = await ticks.next(); let tick = try XCTUnwrap(pending)
        clock.advance(by: .seconds(30)); tick.release(); _ = await completed.next()
        try await detail.synchronize()
        let value = await selectedDetailBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(value?.messages.count, 100)
        XCTAssertFalse(value?.messages.contains(where: { $0.text == "User 70" }) ?? true)
        let urls = await fixture.http.threadRequests.map { $0.url!.absoluteString }
        XCTAssertEqual(urls.count, 5)
        XCTAssertTrue(urls[2].contains("turnLimit=30"))
        XCTAssertTrue(urls[3].contains("turnLimit=31"))
        XCTAssertFalse(urls[4].contains("turnLimit="))
    }


    func testOnlyMessageQuestionsCanBeDismissed() async throws {
        let fixture = try await CatchUpFixture.make(activities: [
            requestActivity("user-input.requested", id: "callback"),
            requestActivity("user-input.requested", id: "async", responseMode: "message"),
        ])
        defer { fixture.cleanUp() }
        let detail = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertTrue(try XCTUnwrap(detail.userInputs.first { $0.wireID == "async" }).canDismiss)
        let callback = try XCTUnwrap(detail.userInputs.first { $0.wireID == "callback" })
        XCTAssertFalse(callback.canDismiss)
        do {
            try await fixture.client.dismissUserInput(id: callback.id)
            XCTFail("A provider callback must not be dismissed")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The input request is no longer active.")
        }
        await fixture.client.disconnect()
    }

    func testLegacyBurstCoalescesUntilExplicitMarker() async throws {
        for capability: Bool? in [nil, false] {
            let clock = CatchUpPublicationClock()
            let fixture = try await CatchUpFixture.make(
                completionMarker: capability, detailPublicationSleep: { try await clock.wait() }
            )
            defer { fixture.cleanUp() }
            do {
                var requests = fixture.requests.makeAsyncIterator()
                var events = fixture.client.events().makeAsyncIterator()
                _ = try await fixture.client.loadThread(id: fixture.firstID)
                let detail = try await nextThreadRequest(&requests)
                _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
                // HTTP readiness can precede installation of the subscription's
                // connection UUID. Establish this stream's own live boundary
                // before counting the already-synchronized burst publications.
                try await detail.synchronize()
                _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
                try await detail.sendBurst(count: 100, includeMarker: true)
                var publications = 0
                var sawLive = false
                var finalText: String?
                while let event = await events.next(isolation: #isolation) {
                    switch event {
                    case let .detail(value), let .detailDelta(value, _):
                        guard value.thread.id == fixture.firstID else { continue }
                        publications += 1
                        finalText = value.messages.last?.text
                    case .threadSync(fixture.firstID, .live):
                        XCTAssertEqual(publications, 1)
                        XCTAssertEqual(finalText, String(repeating: "x", count: 100))
                        sawLive = true
                        break
                    default: continue
                    }
                    if case .threadSync(fixture.firstID, .live) = event { break }
                }
                try Task.checkCancellation()
                XCTAssertTrue(sawLive)
                XCTAssertEqual(finalText, String(repeating: "x", count: 100))
            } catch {
                await clock.release()
                await fixture.client.disconnect()
                throw error
            }
            await clock.release()
            await fixture.client.disconnect()
        }
    }

    func testLegacyMarkerlessFinalPublishesWhenClockReleases() async throws {
        for capability: Bool? in [nil, false] {
            let clock = CatchUpPublicationClock()
            let fixture = try await CatchUpFixture.make(
                completionMarker: capability, detailPublicationSleep: { try await clock.wait() }
            )
            defer { fixture.cleanUp() }
            do {
                var requests = fixture.requests.makeAsyncIterator()
                var events = fixture.client.events().makeAsyncIterator()
                var entries = clock.entries.makeAsyncIterator()
                _ = try await fixture.client.loadThread(id: fixture.firstID)
                let detail = try await nextThreadRequest(&requests)
                _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
                try await detail.synchronize()
                _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
                try await detail.sendBurst(count: 1, includeMarker: false)
                guard await entries.next(isolation: #isolation) != nil else { throw CancellationError() }
                await clock.release()
                var foundFinal = false
                while let event = await events.next(isolation: #isolation) {
                    if case .threadSync(fixture.firstID, .live) = event {
                        XCTFail("An already live legacy event must not emit another live status")
                    }
                    switch event {
                    case let .detail(value), let .detailDelta(value, _):
                        guard value.thread.id == fixture.firstID else { continue }
                        XCTAssertEqual(value.messages.last?.text, "x")
                        foundFinal = true
                    default: continue
                    }
                    if foundFinal { break }
                }
                try Task.checkCancellation()
                XCTAssertTrue(foundFinal)
            } catch {
                await clock.release()
                await fixture.client.disconnect()
                throw error
            }
            await fixture.client.disconnect()
        }
    }

    func testLegacyBufferedFinalPrecedesShellDone() async throws {
        for shellSequence in [3, 10] {
            let clock = CatchUpPublicationClock()
            let fixture = try await CatchUpFixture.make(
                completionMarker: nil, detailPublicationSleep: { try await clock.wait() }
            )
            defer { fixture.cleanUp() }
            do {
                var requests = fixture.requests.makeAsyncIterator()
                let shell = try await nextShellRequest(&requests)
                var events = fixture.client.events().makeAsyncIterator()
                var entries = clock.entries.makeAsyncIterator()
                _ = try await fixture.client.loadThread(id: fixture.firstID)
                let detail = try await nextThreadRequest(&requests)
                _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
                try await detail.synchronize()
                _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
                try await detail.sendBurst(count: 1, includeMarker: false)
                guard await entries.next(isolation: #isolation) != nil else { throw CancellationError() }
                try await shell.completeShell(sequence: shellSequence, assistantMessageID: "burst-message")
                var reachedDone = false
                while let event = await events.next(isolation: #isolation) {
                    switch event {
                    case let .detail(value), let .detailDelta(value, _):
                        guard value.thread.id == fixture.firstID else { continue }
                        if value.thread.state == .completed {
                            XCTAssertEqual(value.messages.last?.text, "x")
                            reachedDone = true
                        }
                    default: continue
                    }
                    if reachedDone { break }
                }
                try Task.checkCancellation()
                XCTAssertTrue(reachedDone)
            } catch {
                await clock.release()
                await fixture.client.disconnect()
                throw error
            }
            await clock.release()
            await fixture.client.disconnect()
        }
    }

    func testDelayedCompletedShellPreservesNewerRunningDetailAndBackgroundLiveness() async throws {
        for background: String? in [nil, "working"] {
            let receipts = AsyncStream<Int>.makeStream()
            let fixture = try await CatchUpFixture.make(aggregateRefreshReceipt: { receipt in
                if case let .shellApplied("one", sequence) = receipt { receipts.continuation.yield(sequence) }
            })
            defer { fixture.cleanUp() }
            do {
                var requests = fixture.requests.makeAsyncIterator()
                var applied = receipts.stream.makeAsyncIterator()
                let shell = try await nextShellRequest(&requests)
                try await shell.completeShell(sequence: 10, assistantMessageID: nil)
                while let sequence = await applied.next(isolation: #isolation) {
                    if sequence == 10 { break }
                }
                try Task.checkCancellation()
                var events = fixture.client.events().makeAsyncIterator()
                _ = try await fixture.client.loadThread(id: fixture.firstID)
                let detail = try await nextThreadRequest(&requests)
                try await detail.synchronize()
                _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
                try await detail.runningTurnSnapshot(sequence: 12)
                var latest: FeatureThreadDetail?
                while let event = await events.next(isolation: #isolation) {
                    switch event {
                    case let .detail(value), let .detailDelta(value, _): latest = value
                    case .threadSync(fixture.firstID, .live): break
                    default: continue
                    }
                    if case .threadSync(fixture.firstID, .live) = event { break }
                }
                XCTAssertEqual(latest?.thread.state, .working)
                let startedAt = try XCTUnwrap(latest?.thread.workingStartedAt)
                try await shell.completeShell(
                    sequence: 11, assistantMessageID: nil, backgroundLiveness: background
                )
                while let sequence = await applied.next(isolation: #isolation) {
                    if sequence == 11 { break }
                }
                try Task.checkCancellation()
                // The applied shell receipt orders this explicit detail marker
                // after any detail publication caused by the delayed shell.
                try await detail.synchronize()
                while let event = await events.next(isolation: #isolation) {
                    switch event {
                    case let .detail(value), let .detailDelta(value, _):
                        latest = value
                        XCTAssertEqual(value.thread.state, .working)
                        XCTAssertEqual(value.thread.workingStartedAt, startedAt)
                    case .threadSync(fixture.firstID, .live): break
                    default: continue
                    }
                    if case .threadSync(fixture.firstID, .live) = event { break }
                }
                try Task.checkCancellation()
                XCTAssertEqual(latest?.thread.state, .working)
                XCTAssertEqual(latest?.backgroundWorkIsActive, background == "working")
            } catch {
                await fixture.client.disconnect()
                throw error
            }
            await fixture.client.disconnect()
        }
    }

    func testShellCompletionRepairsMissingOrStreamingFinalWithoutClosingDetailStream() async throws {
        for mode in ["missing", "streaming", "no-message-id", "no-message-id-streaming", "no-message-id-completed"] {
            let fixture = try await CatchUpFixture.make()
            defer { fixture.cleanUp() }
            if mode == "streaming" || mode == "no-message-id-streaming" {
                await fixture.http.setCompletionResponse(text: "Partial", sequence: 2, streaming: true)
            }
            var requests = fixture.requests.makeAsyncIterator()
            let shell = try await nextShellRequest(&requests)
            var events = fixture.client.events().makeAsyncIterator()
            _ = try await fixture.client.loadThread(id: fixture.firstID)
            let detail = try await nextThreadRequest(&requests)
            if mode == "no-message-id-streaming" || mode == "no-message-id-completed" {
                try await detail.completeTurnWithoutMessageID(sequence: 3)
            }
            try await detail.synchronize()
            _ = await messagesBeforeLive(&events, threadID: fixture.firstID)

            await fixture.http.setCompletionResponse(text: "Final assistant response", sequence: 10)
            await fixture.http.holdThreadReads(true)
            let began = expectation(description: "Completion starts a required snapshot: \(mode)")
            let waiting = Task { @MainActor in
                var reads = fixture.http.heldRequests.makeAsyncIterator()
                let read = await reads.next(isolation: #isolation)
                if read != nil { began.fulfill() }
                return read
            }
            try await shell.completeShell(sequence: 10, assistantMessageID: mode.hasPrefix("no-message-id") ? nil : "answer-0")
            // Failure watchdog only: successful progress is signaled by the held HTTP read.
            await fulfillment(of: [began], timeout: 2)
            waiting.cancel()
            guard let read = await waiting.value else {
                await fixture.client.disconnect()
                continue
            }
            read.succeed()
            let repaired = await messagesBeforeLive(&events, threadID: fixture.firstID)
            XCTAssertEqual(repaired, ["Final assistant response"], mode)

            // The same subscription remains usable after HTTP repair.
            try await detail.sendMessage(text: "Next response", sequence: 11)
            try await detail.synchronize()
            let next = await messagesBeforeLive(&events, threadID: fixture.firstID)
            XCTAssertEqual(next, ["Final assistant response", "Next response"], mode)
            try await shell.completeShell(
                sequence: 30, assistantMessageID: mode.hasPrefix("no-message-id") ? nil : "answer-0",
                activeOrderKey: "already-complete"
            )
            while let event = await events.next(isolation: #isolation) {
                if case .threadSync(fixture.firstID, .catchingUp) = event {
                    XCTFail("Already-complete detail must not start another repair")
                }
                if case let .detail(value) = event, value.thread.activeOrderKey == "already-complete" { break }
                if case let .detailDelta(value, _) = event, value.thread.activeOrderKey == "already-complete" { break }
            }
            let count = await fixture.http.threadRequests.count
            XCTAssertEqual(count, 2, mode)
            await fixture.client.disconnect()
        }
    }

    func testShellCompletionCoalescesWhileRequiredSnapshotTracksNewerDetailEvents() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        let shell = try await nextShellRequest(&requests)
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let detail = try await nextThreadRequest(&requests)
        try await detail.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setCompletionResponse(text: "Final", sequence: 10)
        await fixture.http.holdThreadReads(true)
        let began = expectation(description: "Completion starts required read")
        let waiting = Task { @MainActor in
            var reads = fixture.http.heldRequests.makeAsyncIterator()
            let read = await reads.next(isolation: #isolation)
            if read != nil { began.fulfill() }
            return read
        }
        try await shell.completeShell(sequence: 10, assistantMessageID: "answer-0")
        await fulfillment(of: [began], timeout: 2)
        waiting.cancel()
        guard let first = await waiting.value else {
            await fixture.client.disconnect()
            return
        }
        await nextCatchUp(&events, threadID: fixture.firstID)

        // An unrelated shell cursor advance must not invalidate the same completion twice.
        try await shell.completeShell(sequence: 100, assistantMessageID: "answer-0", activeOrderKey: "completion-seen-again")
        while let event = await events.next(isolation: #isolation) {
            if case let .detail(value) = event, value.thread.activeOrderKey == "completion-seen-again" { break }
            if case let .detailDelta(value, _) = event, value.thread.activeOrderKey == "completion-seen-again" { break }
        }
        await fixture.http.setCompletionResponse(text: "Final with newer detail", sequence: 20)
        try await detail.sendMessage(text: "Final with newer detail", sequence: 20)
        await nextCatchUp(&events, threadID: fixture.firstID)
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        first.succeed()
        let replacement = try await nextHeldRead(&reads)
        replacement.succeed()
        let repaired = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(repaired, ["Final with newer detail"])
        let count = await fixture.http.threadRequests.count
        XCTAssertEqual(count, 3, "Initial read plus one stale repair and one cursor replacement")
        await fixture.client.disconnect()
    }

    func testWarmCachedOpenRepairsAlreadyCompletedShellWithoutAnotherShellEvent() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        let shell = try await nextShellRequest(&requests)
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        fixture.client.releaseThread(id: fixture.firstID)
        try await shell.completeShell(sequence: 10, assistantMessageID: "answer-0", activeOrderKey: "cached-completion")
        while let event = await events.next(isolation: #isolation) {
            if case let .thread(value) = event, value.activeOrderKey == "cached-completion" { break }
            if case let .snapshot(value) = event,
               value.threads.contains(where: { $0.activeOrderKey == "cached-completion" }) { break }
        }
        await fixture.http.setCompletionResponse(text: "Final while closed", sequence: 10)
        await fixture.http.holdThreadReads(true)
        let began = expectation(description: "Cached completion starts required read on reopen")
        let waiting = Task { @MainActor in
            var reads = fixture.http.heldRequests.makeAsyncIterator()
            let read = await reads.next(isolation: #isolation)
            if read != nil { began.fulfill() }
            return read
        }
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let resumed = try await nextThreadRequest(&requests)
        try await resumed.synchronize()
        await fulfillment(of: [began], timeout: 2)
        waiting.cancel()
        guard let read = await waiting.value else {
            await fixture.client.disconnect()
            return
        }
        // Ignore the warm-cache immediate live receipt preceding the repair.
        while let event = await events.next(isolation: #isolation) {
            if case .threadSync(fixture.firstID, .catchingUp) = event { break }
        }
        read.succeed()
        let repaired = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(repaired, ["Final while closed"])
        let count = await fixture.http.threadRequests.count
        XCTAssertEqual(count, 2)
        await fixture.client.disconnect()
    }

    private func nextShellRequest(
        _ iterator: inout AsyncStream<CatchUpRequest>.Iterator
    ) async throws -> CatchUpRequest {
        while let request = await iterator.next(isolation: #isolation) {
            if request.tag == RPCMethod.subscribeShell.rawValue { return request }
        }
        throw CancellationError()
    }

    func testRequestSnapshotsKeepTerminalRequestsClosedAndOtherFailuresRetryable() async throws {
        var activities: [OrchestrationActivity] = []
        for kind in ["approval", "user-input"] {
            activities += [
                requestActivity("\(kind).resolved", id: "resolved-\(kind)"),
                requestActivity("\(kind).requested", id: "resolved-\(kind)"),
                requestActivity("\(kind).requested", id: "retry-\(kind)"),
                requestActivity(
                    "provider.\(kind).respond.failed", id: "retry-\(kind)",
                    detail: "Unknown network failure with stale connection metadata"
                ),
            ]
        }
        let failures = [
            "approval": [
                "stale pending approval request", "unknown pending approval request",
                "unknown pending permission request", "unknown pending codex approval request",
            ],
            "user-input": [
                "stale pending user-input request", "unknown pending user-input request",
                "unknown pending user input request", "unknown pending codex user input request",
            ],
        ]
        for (kind, fragments) in failures {
            for (index, fragment) in fragments.enumerated() {
                let id = "stale-\(kind)-\(index)"
                activities += [
                    requestActivity("provider.\(kind).respond.failed", id: id, detail: fragment.uppercased()),
                    requestActivity("\(kind).requested", id: id),
                ]
            }
        }
        activities += [
            requestActivity("approval.requested", id: "legacy-file", requestType: "apply_patch_approval"),
            requestActivity("approval.requested", id: "legacy-input", requestType: "tool_user_input"),
            requestActivity("approval.requested", id: "legacy-auth", requestType: "auth_tokens_refresh"),
        ]
        let fixture = try await CatchUpFixture.make(activities: activities)
        defer { fixture.cleanUp() }
        let detail = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertEqual(Set(detail.approvals.compactMap(\.wireID)), ["retry-approval", "legacy-file"])
        XCTAssertEqual(detail.approvals.first { $0.wireID == "legacy-file" }?.kind, .fileChange)
        XCTAssertEqual(detail.userInputs.compactMap(\.wireID), ["retry-user-input"])
        await fixture.client.disconnect()
    }

    func testLiveRequestsKeepTerminalStateAcrossBatchesAndResetWithSnapshots() async throws {
        let resolved = ["approval", "user-input"].map {
            requestActivity("\($0).resolved", id: "closed-\($0)")
        }
        let fixture = try await CatchUpFixture.make(activities: resolved)
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)

        var activities: [OrchestrationActivity] = []
        for kind in ["approval", "user-input"] {
            activities += [
                requestActivity("\(kind).requested", id: "closed-\(kind)"),
                requestActivity("\(kind).resolved", id: "live-\(kind)"),
                requestActivity("\(kind).requested", id: "retry-\(kind)"),
                requestActivity(
                    "provider.\(kind).respond.failed", id: "retry-\(kind)",
                    detail: "Unknown transport error"
                ),
            ]
        }
        try await stream.sendActivities(activities, startingAt: 3)
        try await stream.synchronize()
        let first = try await requestsBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(first.approvals.compactMap(\.wireID), ["retry-approval"])
        XCTAssertEqual(first.userInputs.compactMap(\.wireID), ["retry-user-input"])

        let lateRequests = ["approval", "user-input"].map {
            requestActivity("\($0).requested", id: "live-\($0)")
        }
        try await stream.sendActivities(lateRequests, startingAt: 20)
        try await stream.synchronize()
        let second = try await requestsBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(second.approvals.compactMap(\.wireID), ["retry-approval"])
        XCTAssertEqual(second.userInputs.compactMap(\.wireID), ["retry-user-input"])

        // A replacement snapshot is authoritative, including its request history.
        await fixture.http.setActivities(lateRequests)
        let replaced = try await fixture.client.loadThread(id: fixture.firstID, fresh: true)
        XCTAssertEqual(replaced.approvals.compactMap(\.wireID), ["live-approval"])
        XCTAssertEqual(replaced.userInputs.compactMap(\.wireID), ["live-user-input"])
        await fixture.client.disconnect()
    }

    private func requestActivity(
        _ kind: String, id: String, detail: String? = nil, requestType: String? = nil,
        responseMode: String? = nil
    ) -> OrchestrationActivity {
        var payload: [String: JSONValue] = ["requestId": .string(id)]
        payload["detail"] = detail.map(JSONValue.string)
        payload["requestType"] = requestType.map(JSONValue.string)
        payload["responseMode"] = responseMode.map(JSONValue.string)
        if kind == "user-input.requested" {
            payload["questions"] = .array([.object([
                "id": .string("choice"), "header": .string("Choice"),
                "question": .string("Which option?"), "options": .array([
                    .object(["label": .string("First"), "description": .string("First option")]),
                ]),
            ])])
        }
        return OrchestrationActivity(
            id: UUID().uuidString, tone: "info", kind: kind, summary: kind,
            payload: .object(payload), turnId: nil, sequence: nil,
            createdAt: "2026-09-02T12:00:00Z"
        )
    }

    private func requestsBeforeLive(
        _ iterator: inout AsyncStream<FeatureEvent>.Iterator, threadID: String
    ) async throws -> FeatureThreadDetail {
        var latest: FeatureThreadDetail?
        while let event = await iterator.next(isolation: #isolation) {
            switch event {
            case let .detail(detail), let .detailDelta(detail, _):
                if detail.thread.id == threadID { latest = detail }
            case .threadSync(threadID, .live): return try XCTUnwrap(latest)
            case let .threadSync(id, .failed(message)) where id == threadID:
                XCTFail("Request stream failed: \(message)")
                throw CancellationError()
            default: break
            }
        }
        throw CancellationError()
    }

    func testDomainFailureBacksOffAndKeepsItsErrorUntilTheStreamRecovers() async throws {
        let retry = CatchUpRetryGate()
        let fixture = try await CatchUpFixture.make(threadRetryDelay: { try await retry.wait($0) })
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var attempts = retry.attempts.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        var current = try await nextThreadRequest(&requests)
        for expectedAttempt in 1...3 {
            try await current.socket.fail(id: current.id, message: "Thread is temporarily unavailable.")
            while let event = await events.next(isolation: #isolation) {
                if case let .threadSync(id, .failed(message)) = event, id == fixture.firstID {
                    XCTAssertEqual(message, "Thread is temporarily unavailable.")
                    break
                }
            }
            let attempt = await attempts.next(isolation: #isolation)
            XCTAssertEqual(attempt, expectedAttempt)
            await retry.release()
            let next = try await nextThreadRequest(&requests)
            XCTAssertTrue(next.socket === current.socket)
            current = next
        }

        try await current.sendMessage(text: "Recovered without reconnecting", sequence: 3)
        try await current.synchronize()
        let nextState = await nextSyncState(&events, threadID: fixture.firstID)
        XCTAssertEqual(nextState, .catchingUp, "A rejected retry must retain its failure until real data arrives.")
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(messages, ["Recovered without reconnecting"])

        try await current.socket.fail(id: current.id, message: "Temporarily unavailable again.")
        let resetAttempt = await attempts.next(isolation: #isolation)
        XCTAssertEqual(resetAttempt, 1, "Valid stream data resets the retry backoff.")
        await fixture.client.disconnect()
    }

    func testTerminatedStreamsKeepBufferedTextAndRecoverOnConnectionOrForeground() async throws {
        for failure in CatchUpStreamFailure.allCases {
            let fixture = try await CatchUpFixture.make()
            defer { fixture.cleanUp() }
            var requests = fixture.requests.makeAsyncIterator()
            var events = fixture.client.events().makeAsyncIterator()
            _ = try await fixture.client.loadThread(id: fixture.firstID)
            let first = try await nextThreadRequest(&requests)
            try await first.sendMessage(text: "Received before the failure", sequence: 3)
            try await first.terminate(failure)

            var bufferedMessages: [String] = []
            while let event = await events.next(isolation: #isolation) {
                switch event {
                case let .detail(detail), let .detailDelta(detail, _):
                    if detail.thread.id == fixture.firstID {
                        bufferedMessages = detail.messages.map(\.text)
                    }
                case let .threadSync(id, .failed(message)) where id == fixture.firstID:
                    XCTAssertEqual(message, "Could not synchronize the thread. Try again.")
                default: continue
                }
                if case .threadSync(fixture.firstID, .failed) = event { break }
            }
            XCTAssertEqual(bufferedMessages, ["Received before the failure"])

            if failure == .malformed {
                await first.socket.close()
            } else {
                await fixture.client.resumeAfterBackground(reconnect: false)
            }
            let resumed = try await nextThreadRequest(&requests)
            XCTAssertEqual(resumed.payload["afterSequence"], .number(3))
            XCTAssertEqual(resumed.socket === first.socket, failure != .malformed)
            let resumedState = await nextSyncState(&events, threadID: fixture.firstID)
            XCTAssertEqual(resumedState, .catchingUp)
            try await resumed.sendMessage(text: "Recovered", sequence: 4)
            try await resumed.synchronize()
            let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
            XCTAssertEqual(messages, ["Received before the failure", "Recovered"])
            let reads = await fixture.http.threadRequests
            XCTAssertEqual(reads.count, 1, "A failed stream must retain its usable snapshot.")
            await fixture.client.disconnect()
        }
    }

    func testLeavingFailedThreadCancelsItsConnectionWait() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.terminate(.malformed)
        while let event = await events.next(isolation: #isolation) {
            if case .threadSync(fixture.firstID, .failed) = event { break }
        }

        fixture.client.releaseThread(id: fixture.firstID)
        _ = try await fixture.client.loadThread(id: fixture.secondID)
        let second = try await nextThreadRequest(&requests)
        try await second.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.secondID)
        await second.socket.close()
        let resumed = try await nextThreadRequest(&requests)
        XCTAssertEqual(resumed.payload["threadId"], .string("second"))
        try await resumed.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.secondID)
        await fixture.client.disconnect()
    }

    func testExplicitRetryReadsFreshSnapshotInsteadOfWarmResume() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        _ = try await nextThreadRequest(&requests)
        fixture.client.releaseThread(id: fixture.firstID)
        await fixture.http.setResponse(text: "Fresh retry", sequence: 20)
        let detail = try await fixture.client.loadThread(id: fixture.firstID, fresh: true)
        XCTAssertTrue(detail.messages.contains { $0.text == "Fresh retry" })
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2)
        await fixture.client.disconnect()
    }

    func testWarmReopenClearsAnInterruptedOlderPageLoadingState() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        await fixture.http.setPage(.init(beforeCursor: "older", hasMore: true, snapshotSequence: 2))
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)
        try await stream.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        let older = Task { try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID) }
        let held = try await nextHeldRead(&reads)
        fixture.client.releaseThread(id: fixture.firstID)
        let restored = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertEqual(restored.page?.isLoading, false)
        XCTAssertEqual(restored.page?.hasMore, true)
        held.succeed()
        _ = try await older.value
        await fixture.http.holdThreadReads(false)
        await fixture.http.setPage(.init(beforeCursor: nil, hasMore: false, snapshotSequence: 2))
        _ = try await fixture.client.loadEarlierThreadTurns(id: fixture.firstID)
        let count = await fixture.http.threadRequests.count
        XCTAssertEqual(count, 3, "Reopened history must allow another older-page request")
        await fixture.client.disconnect()
    }

    func testWarmNavigationResumesAfterAppliedMessagesWithoutAnotherHTTPRead() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        XCTAssertEqual(first.payload["afterSequence"], .number(2))
        try await first.sendMessage(text: "Finished on the computer", sequence: 3)
        try await first.synchronize()
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertTrue(messages.contains("Finished on the computer"))

        fixture.client.releaseThread(id: fixture.firstID)
        _ = try await fixture.client.loadThread(id: fixture.secondID)
        _ = try await nextThreadRequest(&requests)
        fixture.client.releaseThread(id: fixture.secondID)
        let restored = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertTrue(restored.messages.contains { $0.text == "Finished on the computer" })
        let resumed = try await nextThreadRequest(&requests)
        XCTAssertEqual(resumed.payload["afterSequence"], .number(3))
        XCTAssertEqual(resumed.payload["turnLimit"], .number(10))
        XCTAssertEqual(resumed.payload["requestCompletionMarker"], .bool(true))
        let resumedState = await nextSyncState(&events, threadID: fixture.firstID)
        XCTAssertEqual(resumedState, .live, "A completed warm thread must not flash catch-up status.")
        try await resumed.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2, "Only the two cold opens should fetch HTTP snapshots.")
        await fixture.client.disconnect()
    }

    func testWarmReplayShowsCatchUpOnlyAfterReceivingNewerData() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)

        fixture.client.releaseThread(id: fixture.firstID)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let resumed = try await nextThreadRequest(&requests)
        let initialState = await nextSyncState(&events, threadID: fixture.firstID)
        XCTAssertEqual(initialState, .live)

        try await resumed.sendMessage(text: "Finished while away", sequence: 3)
        try await resumed.synchronize()
        var states: [FeatureThreadSyncState] = []
        var messages: [String] = []
        while let event = await events.next(isolation: #isolation) {
            if case let .threadSync(id, state) = event,
               id == fixture.firstID, let state {
                states.append(state)
                if state == .live { break }
                if case .failed = state { break }
            }
            switch event {
            case let .detail(detail), let .detailDelta(detail, _):
                if detail.thread.id == fixture.firstID { messages = detail.messages.map(\.text) }
            default: break
            }
        }
        XCTAssertEqual(states, [.catchingUp, .live])
        XCTAssertTrue(messages.contains("Finished while away"))
        await fixture.client.disconnect()
    }

    func testIncompleteWarmCacheStillShowsCatchUp() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        _ = try await nextThreadRequest(&requests)
        fixture.client.releaseThread(id: fixture.firstID)
        while let event = await events.next(isolation: #isolation) {
            if case .threadSync(fixture.firstID, nil) = event { break }
        }

        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let resumed = try await nextThreadRequest(&requests)
        let initialState = await nextSyncState(&events, threadID: fixture.firstID)
        XCTAssertEqual(initialState, .catchingUp)
        try await resumed.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.client.disconnect()
    }

    func testWarmCacheShowsCatchUpAfterSocketReplacement() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        fixture.client.releaseThread(id: fixture.firstID)

        await first.socket.close()
        while let request = await requests.next(isolation: #isolation) {
            if request.socket !== first.socket { break }
        }
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let resumed = try await nextThreadRequest(&requests)
        XCTAssertFalse(resumed.socket === first.socket)
        let resumedState = await nextSyncState(&events, threadID: fixture.firstID)
        XCTAssertEqual(resumedState, .catchingUp)
        try await resumed.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.client.disconnect()
    }

    func testForegroundReplacesSuspendedConnectionAndUsesLatestCursor() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.sendMessage(text: "Before background", sequence: 7)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)

        await fixture.client.resumeAfterBackground(reconnect: true)
        let resumed = try await nextThreadRequest(&requests)
        XCTAssertFalse(resumed.socket === first.socket)
        XCTAssertEqual(resumed.payload["afterSequence"], .number(7))
        let resumedState = await nextSyncState(&events, threadID: fixture.firstID)
        XCTAssertEqual(resumedState, .catchingUp)
        try await resumed.sendMessage(text: "Completed while away", sequence: 8)
        try await resumed.synchronize()
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertTrue(messages.contains("Completed while away"))
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 1)
        await fixture.client.disconnect()
    }

    func testSocketLossResubscribesFromAppliedCursor() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.sendMessage(text: "Last applied message", sequence: 12)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await first.socket.close()
        let resumed = try await nextThreadRequest(&requests)
        XCTAssertEqual(resumed.payload["afterSequence"], .number(12))
        XCTAssertFalse(resumed.socket === first.socket)
        let resumedState = await nextSyncState(&events, threadID: fixture.firstID)
        XCTAssertEqual(resumedState, .reconnecting)
        await fixture.client.disconnect()
    }

    func testStalledResumeFetchesBoundedHTTPFallbackWithoutWaitingForHeartbeat() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        fixture.client.releaseThread(id: fixture.firstID)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let resumed = try await nextThreadRequest(&requests)
        await fixture.http.setResponse(text: "HTTP caught up", sequence: 20)
        await fixture.delay.release()
        var sawUpdatedMessage = false
        while let event = await events.next(isolation: #isolation) {
            if case let .detail(detail) = event {
                sawUpdatedMessage = detail.messages.contains { $0.text == "HTTP caught up" }
            }
            if case .threadSync(fixture.firstID, .reconnecting) = event { break }
        }
        XCTAssertTrue(sawUpdatedMessage)
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2)
        XCTAssertEqual(reads.last?.timeoutInterval, 8)
        try await resumed.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.client.disconnect()
    }

    func testLegacyServerStillRevalidatesWarmThreadOverHTTP() async throws {
        let fixture = try await CatchUpFixture.make(completionMarker: false)
        defer { fixture.cleanUp() }
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        fixture.client.releaseThread(id: fixture.firstID)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2)
        await fixture.client.disconnect()
    }

    func testCompletionMarkerWaitsForRequiredSnapshotReplacement() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let request = try await nextThreadRequest(&requests)
        try await request.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setResponse(text: "Authoritative replacement", sequence: 20)
        try await request.socket.chunk(id: request.id, values: [
            .object(["kind": .string("event"), "event": .object([
                "type": .string("thread.reverted"), "sequence": .number(19),
                "occurredAt": .string("2026-09-02T12:00:00Z"),
                "payload": .object(["threadId": .string("first")]),
            ])]),
            .object(["kind": .string("synchronized")]),
        ])
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertTrue(messages.contains("Authoritative replacement"))
        await fixture.client.disconnect()
    }

    func testFailedRequiredSnapshotKeepsCachedTextAndOffersFreshRetry() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        await fixture.http.setResponse(text: "Cached answer", sequence: 2)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)
        try await stream.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)

        await fixture.http.holdThreadReads(true)
        try await stream.invalidate(sequence: 10)
        await nextCatchUp(&events, threadID: fixture.firstID)
        let read = try await nextHeldRead(&reads)
        read.fail()
        while let event = await events.next(isolation: #isolation) {
            if case .threadSync(fixture.firstID, .failed) = event { break }
            if case .threadSync(fixture.firstID, .live) = event {
                XCTFail("A failed snapshot must not mark cached content current.")
            }
        }

        await fixture.http.holdThreadReads(false)
        await fixture.http.setResponse(text: "Fresh answer", sequence: 11)
        let detail = try await fixture.client.loadThread(id: fixture.firstID, fresh: true)
        XCTAssertEqual(detail.messages.map(\.text), ["Fresh answer"])
        await fixture.client.disconnect()
    }

    func testRequiredSnapshotsCoverEveryEventReceivedDuringReplacement() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)
        try await stream.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)

        await fixture.http.setResponse(text: "Before new messages", sequence: 10)
        try await stream.invalidate(sequence: 10)
        await nextCatchUp(&events, threadID: fixture.firstID)
        let first = try await nextHeldRead(&reads)
        try await stream.sendMessage(text: "Eleven", sequence: 11)
        await nextCatchUp(&events, threadID: fixture.firstID)
        await fixture.http.setResponse(text: "Eleven", sequence: 11)
        first.succeed()

        let second = try await nextHeldRead(&reads)
        await nextCatchUp(&events, threadID: fixture.firstID)
        try await stream.sendMessage(text: "Twelve", sequence: 12)
        await nextCatchUp(&events, threadID: fixture.firstID)
        await fixture.http.setResponse(texts: ["Eleven", "Twelve"], sequence: 12)
        second.succeed()

        let third = try await nextHeldRead(&reads)
        await nextCatchUp(&events, threadID: fixture.firstID)
        third.succeed()
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(messages, ["Eleven", "Twelve"])
        let count = await fixture.http.threadRequests.count
        XCTAssertEqual(count, 4, "Each stale response needs one coalesced follow-up, not one read per event.")
        await fixture.client.disconnect()
    }

    func testEventWithoutCursorNeedsSnapshotStartedAfterIt() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)
        try await stream.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        await fixture.http.setResponse(text: "Before unknown event", sequence: 10)
        try await stream.invalidate(sequence: 10)
        await nextCatchUp(&events, threadID: fixture.firstID)
        let first = try await nextHeldRead(&reads)
        try await stream.socket.chunk(id: stream.id, values: [.object(["kind": .string("unknown")])])
        await nextCatchUp(&events, threadID: fixture.firstID)
        await fixture.http.setResponse(text: "After unknown event", sequence: 11)
        first.succeed()
        let second = try await nextHeldRead(&reads)
        await nextCatchUp(&events, threadID: fixture.firstID)
        second.succeed()
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(messages, ["After unknown event"])
        await fixture.client.disconnect()
    }

    func testSocketSnapshotCancelsFailedHTTPReplacement() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)
        try await stream.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        try await stream.invalidate(sequence: 10)
        await nextCatchUp(&events, threadID: fixture.firstID)
        let read = try await nextHeldRead(&reads)
        try await stream.snapshot(texts: ["Recovered over the socket"], sequence: 11)
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(messages, ["Recovered over the socket"])
        read.fail()
        let cancelled = await read.finished.first { _ in true }
        XCTAssertEqual(cancelled, true, "The obsolete HTTP read must not replace live state with an error.")
        await fixture.client.disconnect()
    }

    func testOldSocketSnapshotDoesNotCancelReadAfterCursorlessEvent() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)
        try await stream.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        await fixture.http.setResponse(text: "Fresh after unknown event", sequence: 20)
        try await stream.socket.chunk(id: stream.id, values: [.object(["kind": .string("unknown")])])
        await nextCatchUp(&events, threadID: fixture.firstID)
        let read = try await nextHeldRead(&reads)

        try await stream.snapshot(texts: ["Requested before unknown event"], sequence: 3)
        try await stream.synchronize()
        // This next event is a receipt that the old snapshot was handled first.
        try await stream.sendMessage(text: "After old snapshot", sequence: 19)
        await nextCatchUp(&events, threadID: fixture.firstID)
        read.succeed()
        let cancelled = await read.finished.first { _ in true }
        XCTAssertEqual(cancelled, false, "The required post-event read must still run.")
        guard cancelled == false else {
            await fixture.client.disconnect()
            return
        }
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(messages, ["Fresh after unknown event"])
        await fixture.client.disconnect()
    }

    func testNewSubscriptionSnapshotCanRecoverAfterCursorlessEvent() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)
        try await stream.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        try await stream.socket.chunk(id: stream.id, values: [.object(["kind": .string("unknown")])])
        await nextCatchUp(&events, threadID: fixture.firstID)
        let read = try await nextHeldRead(&reads)

        await stream.socket.close()
        let resumed = try await nextThreadRequest(&requests)
        try await resumed.snapshot(texts: ["New socket snapshot"], sequence: 20)
        try await resumed.synchronize()
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(messages, ["New socket snapshot"])
        read.fail()
        let cancelled = await read.finished.first { _ in true }
        XCTAssertEqual(cancelled, true, "The new subscription can replace the required HTTP read.")
        await fixture.client.disconnect()
    }

    func testLeavingThreadCancelsHeldReplacementAndItsPendingFollowUp() async throws {
        for disconnect in [false, true] {
            let fixture = try await CatchUpFixture.make()
            defer { fixture.cleanUp() }
            var requests = fixture.requests.makeAsyncIterator()
            var events = fixture.client.events().makeAsyncIterator()
            var reads = fixture.http.heldRequests.makeAsyncIterator()
            _ = try await fixture.client.loadThread(id: fixture.firstID)
            let stream = try await nextThreadRequest(&requests)
            try await stream.synchronize()
            _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
            await fixture.http.holdThreadReads(true)
            try await stream.invalidate(sequence: 10)
            await nextCatchUp(&events, threadID: fixture.firstID)
            let read = try await nextHeldRead(&reads)
            try await stream.sendMessage(text: "Do not publish after leaving", sequence: 11)
            await nextCatchUp(&events, threadID: fixture.firstID)

            if disconnect {
                await fixture.client.disconnect()
            } else {
                fixture.client.releaseThread(id: fixture.firstID)
                await fixture.http.holdThreadReads(false)
                await fixture.http.setResponse(text: "Second thread", sequence: 20)
                let detail = try await fixture.client.loadThread(id: fixture.secondID)
                XCTAssertEqual(detail.thread.id, fixture.secondID)
                XCTAssertEqual(detail.messages.map(\.text), ["Second thread"])
            }
            read.succeed()
            let cancelled = await read.finished.first { _ in true }
            XCTAssertEqual(cancelled, true)
            let count = await fixture.http.threadRequests.count
            XCTAssertEqual(count, disconnect ? 2 : 3, "A closed thread must not start its pending read.")
            await fixture.client.disconnect()
        }
    }

    func testAttachmentLookupDoesNotBlockRequiredTextRefresh() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let stream = try await nextThreadRequest(&requests)
        try await stream.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.holdThreadReads(true)
        await fixture.http.setResponse(texts: ["Text ready"], sequence: 11, withImage: true)
        try await stream.invalidate(sequence: 10)
        await nextCatchUp(&events, threadID: fixture.firstID)
        let first = try await nextHeldRead(&reads)
        try await stream.sendMessage(text: "Text ready", sequence: 11)
        await nextCatchUp(&events, threadID: fixture.firstID)
        first.succeed()
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(messages, ["Text ready"])
        let resolving = Task {
            try await fixture.client.attachmentAssetURL(
                threadID: fixture.firstID,
                attachment: .init(id: "image-0", name: "test.png", mimeType: "image/png", sizeBytes: 20)
            )
        }
        defer { resolving.cancel() }
        while let request = await requests.next(isolation: #isolation) {
            if request.tag == RPCMethod.assetsCreateURL.rawValue { break }
        }
        let firstReadCount = await fixture.http.threadRequests.count
        XCTAssertEqual(firstReadCount, 2, "The first snapshot already includes the skipped message.")

        // Leave the asset RPC unanswered. A later text refresh must start anyway.
        await fixture.http.setResponse(texts: ["New text ready"], sequence: 12, withImage: true)
        try await stream.invalidate(sequence: 12)
        await nextCatchUp(&events, threadID: fixture.firstID)
        let second = try await nextHeldRead(&reads)
        second.succeed()
        let updated = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(updated, ["New text ready"])
        await fixture.client.disconnect()
    }

    func testVisibleNonImageAttachmentsResolveWithoutRepublishingThread() async throws {
        for (name, mimeType) in [("document.pdf", "application/pdf"), ("clip.mp4", "video/mp4")] {
            let fixture = try await CatchUpFixture.make()
            defer { fixture.cleanUp() }
            var requests = fixture.requests.makeAsyncIterator()
            var events = fixture.client.events().makeAsyncIterator()
            _ = try await fixture.client.loadThread(id: fixture.firstID)
            let stream = try await nextThreadRequest(&requests)
            try await stream.synchronize()
            _ = await messagesBeforeLive(&events, threadID: fixture.firstID)

            await fixture.http.setResponse(text: "File ready", sequence: 10, attachment: .init(
                type: "file", id: "file", name: name, mimeType: mimeType, sizeBytes: 20
            ))
            try await stream.invalidate(sequence: 10)
            await nextCatchUp(&events, threadID: fixture.firstID)
            // Text must become current before the asset URL request completes.
            let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
            XCTAssertEqual(messages, ["File ready"])

            let resolving = Task {
                try await fixture.client.attachmentAssetURL(
                    threadID: fixture.firstID,
                    attachment: .init(id: "file", name: name, mimeType: mimeType, sizeBytes: 20)
                )
            }
            while let request = await requests.next(isolation: #isolation) {
                guard request.tag == RPCMethod.assetsCreateURL.rawValue else { continue }
                XCTAssertEqual(request.payload["resource"]?["mimeType"], .string(mimeType))
                try await request.socket.succeed(id: request.id, value: .object([
                    "relativeUrl": .string("/assets/\(name)"),
                    "expiresAt": .number(Date.now.addingTimeInterval(3_600).timeIntervalSince1970 * 1_000),
                ]))
                break
            }
            let resolved = try await resolving.value
            XCTAssertEqual(resolved, URL(string: "https://one.example/assets/\(name)"))
            await fixture.client.disconnect()
        }
    }

    func testOpeningAttachmentHistoryDoesNotResolveOffscreenURLsAndVisibleURLIsReused() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        await fixture.http.setResponse(texts: (0..<100).map { "Image \($0)" }, sequence: 2, withImage: true)
        let detail = try await fixture.client.loadThread(id: fixture.firstID)
        let subscription = try await nextThreadRequest(&requests)
        try await subscription.synchronize()
        let attachment = try XCTUnwrap(detail.messages.last?.attachments.first)
        let resolving = Task {
            try await fixture.client.attachmentAssetURL(threadID: fixture.firstID, attachment: attachment)
        }
        while let request = await requests.next(isolation: #isolation) {
            guard request.tag == RPCMethod.assetsCreateURL.rawValue else { continue }
            XCTAssertEqual(request.payload["resource"]?["attachmentId"], .string(attachment.id))
            try await request.socket.succeed(id: request.id, value: .object([
                "relativeUrl": .string("/assets/visible.png"),
                "expiresAt": .number(Date.now.addingTimeInterval(3_600).timeIntervalSince1970 * 1_000),
            ]))
            break
        }
        let firstURL = try await resolving.value
        let cachedURL = try await fixture.client.attachmentAssetURL(threadID: fixture.firstID, attachment: attachment)
        XCTAssertEqual(cachedURL, firstURL)
        let assetReads = await subscription.socket.assetRequestCount
        XCTAssertEqual(assetReads, 1, "Only the visible attachment needs a signed URL.")
        await fixture.client.disconnect()
    }

    func testRequiredReadReplacesColdFallbackWithoutHidingItsOwnFailure() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        var reads = fixture.http.heldRequests.makeAsyncIterator()
        await fixture.http.holdThreadReads(true)

        // Fail the cold open so catch-up starts without a base snapshot.
        let opening = Task { try await fixture.client.loadThread(id: fixture.firstID) }
        let initial = try await nextHeldRead(&reads)
        initial.fail()
        do {
            _ = try await opening.value
            XCTFail("The initial snapshot should fail.")
        } catch {}
        let stream = try await nextThreadRequest(&requests)
        while let event = await events.next(isolation: #isolation) {
            if case .threadSync(fixture.firstID, .failed) = event { break }
        }
        await nextCatchUp(&events, threadID: fixture.firstID)
        await fixture.delay.release()
        let fallback = try await nextHeldRead(&reads)

        // The event needs a newer snapshot than the fallback captured.
        await fixture.http.setResponse(text: "New message", sequence: 3)
        try await stream.sendMessage(text: "New message", sequence: 3)
        await nextCatchUp(&events, threadID: fixture.firstID)
        let replacement = try await nextHeldRead(&reads)
        fallback.succeed()
        let wasCancelled = await fallback.finished.first { _ in true }
        XCTAssertEqual(wasCancelled, true, "The older fallback must stop when the required read takes over.")

        replacement.fail()
        var failure: String?
        while let event = await events.next(isolation: #isolation) {
            guard case let .threadSync(id, .failed(message)) = event,
                  id == fixture.firstID else { continue }
            failure = message
            break
        }
        XCTAssertEqual(failure, URLError(.notConnectedToInternet).localizedDescription)
        await fixture.client.disconnect()
    }

    private func nextHeldRead(
        _ iterator: inout AsyncStream<CatchUpHTTPRead>.Iterator
    ) async throws -> CatchUpHTTPRead {
        let read = await iterator.next(isolation: #isolation)
        return try XCTUnwrap(read)
    }

    private func nextCatchUp(
        _ iterator: inout AsyncStream<FeatureEvent>.Iterator, threadID: String
    ) async {
        while let event = await iterator.next(isolation: #isolation) {
            if case .threadSync(threadID, .catchingUp) = event { return }
            if case .threadSync(threadID, .live) = event {
                XCTFail("The thread became live before its required snapshot was complete.")
                return
            }
        }
        XCTFail("The thread did not report its pending refresh.")
    }

    private func nextThreadRequest(
        _ iterator: inout AsyncStream<CatchUpRequest>.Iterator
    ) async throws -> CatchUpRequest {
        while let request = await iterator.next(isolation: #isolation) {
            if request.tag == RPCMethod.subscribeThread.rawValue { return request }
        }
        throw CancellationError()
    }

    private func nextSyncState(
        _ iterator: inout AsyncStream<FeatureEvent>.Iterator, threadID: String
    ) async -> FeatureThreadSyncState? {
        while let event = await iterator.next(isolation: #isolation) {
            if case let .threadSync(id, state) = event, id == threadID, let state {
                return state
            }
        }
        XCTFail("The thread did not report its sync state.")
        return nil
    }

    private func messagesBeforeLive(
        _ iterator: inout AsyncStream<FeatureEvent>.Iterator, threadID: String
    ) async -> [String] {
        var messages: [String] = []
        while let event = await iterator.next(isolation: #isolation) {
            switch event {
            case let .detail(detail), let .detailDelta(detail, _):
                if detail.thread.id == threadID { messages = detail.messages.map(\.text) }
            case .threadSync(threadID, .live): return messages
            case let .threadSync(id, .failed(error)) where id == threadID:
                XCTFail("The thread failed synchronization: \(error)")
                return messages
            default: break
            }
        }
        XCTFail("The thread did not finish synchronization.")
        return messages
    }
}

@MainActor
private struct CatchUpFixture {
    let client: NativeFeatureClient
    let http: CatchUpHTTPTransport
    let requests: AsyncStream<CatchUpRequest>
    let delay: CatchUpDelay
    let directory: URL
    var firstID: String { FeatureScopedID.thread(environmentID: "one", wireID: "first") }
    var secondID: String { FeatureScopedID.thread(environmentID: "one", wireID: "second") }

    static func make(
        completionMarker: Bool? = true,
        includePeer: Bool = false,
        reconciliationClock: SelectedReconciliationClock? = nil,
        reconciliationReceipt: @escaping @MainActor @Sendable (NativeSelectedThreadReconciliationReceipt) -> Void = { _ in },
        activities: [OrchestrationActivity] = [],
        aggregateRefreshReceipt: @escaping @MainActor @Sendable (NativePassiveShellReceipt) -> Void = { _ in },
        detailPublicationSleep: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: .milliseconds(80))
        },
        threadRetryDelay: @escaping @Sendable (Int) async throws -> Void = { _ in
            try await Task.sleep(for: .milliseconds(250))
        }
    ) async throws -> Self {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save([Environment(
            id: "one", label: "Computer", httpBaseURL: URL(string: "https://one.example")!,
            webSocketBaseURL: URL(string: "wss://one.example/ws")!
        )] + (includePeer ? [Environment(
            id: "two", label: "Peer", httpBaseURL: URL(string: "https://two.example")!,
            webSocketBaseURL: URL(string: "wss://two.example/ws")!
        )] : []))
        try await store.setActiveEnvironment(id: "one")
        let http = CatchUpHTTPTransport()
        await http.setActivities(activities)
        let requests = AsyncStream<CatchUpRequest>.makeStream()
        let delay = CatchUpDelay()
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: ["one": .init(accessToken: "test"), "two": .init(accessToken: "test")]),
            httpTransport: http,
            webSocketConnector: CatchUpConnector(
                requests: requests.continuation, completionMarker: completionMarker
            )
        )
        let readiness = CatchUpBootstrapReadiness()
        let peerReadiness = CatchUpBootstrapReadiness()
        let client = NativeFeatureClient(
            runtime: runtime, settingsStore: UserDefaults(suiteName: UUID().uuidString)!,
            fallbackPollingInitialDelay: .seconds(3_600),
            aggregateRefreshInterval: .seconds(3_600),
            aggregateRefreshReceipt: {
                readiness.record($0)
                switch $0 {
                case let .shellApplied("two", sequence): peerReadiness.record(.shellApplied(environmentID: "one", sequence: sequence))
                case .configurationApplied("two"): peerReadiness.record(.configurationApplied(environmentID: "one"))
                default: break
                }
                aggregateRefreshReceipt($0)
            },
            detailPublicationSleep: detailPublicationSleep,
            catchUpDelay: { try await delay.wait() },
            selectedThreadReconciliationSleep: { duration in
                if let reconciliationClock { try await reconciliationClock.sleep(for: duration) }
                else { try await Task.sleep(for: duration) }
            },
            selectedThreadReconciliationNow: { reconciliationClock?.now ?? .now },
            selectedThreadReconciliationReceipt: reconciliationReceipt,
            threadRetryDelay: threadRetryDelay
        )
        _ = try await client.initialSnapshot()
        try await readiness.wait()
        if includePeer { try await peerReadiness.wait() }
        return Self(client: client, http: http, requests: requests.stream, delay: delay, directory: directory)
    }

    func cleanUp() { try? FileManager.default.removeItem(at: directory) }
}

private actor CatchUpHTTPTransport: HTTPTransport {
    func setFaultInjectionMessages(paginated: Bool) {
        let authoritative = [3, 4].map { index in
            OrchestrationMessage(id: "message-\(index)", role: "assistant",
                text: index == 3 ? "Omitted message" : "Later delivered message",
                attachments: [], turnId: nil, streaming: false,
                createdAt: "2026-09-02T12:00:00Z", updatedAt: "2026-09-02T12:00:00Z")
        }
        messages = authoritative
        paginatedMessages = paginated ? authoritative : nil
        sequence = 4
    }


    private(set) var threadRequests: [URLRequest] = []
    private(set) var threadResponseBytes: [Int] = []
    private var messages: [OrchestrationMessage] = []
    private var paginatedMessages: [OrchestrationMessage]?
    private var rawTurnCap: Int?
    private var rawCollection: String?
    private var pendingHeldReads: [CatchUpHTTPRead] = []
    private var activities: [OrchestrationActivity] = []
    private var completionResponse = false
    private var runningResponse = false
    private var responsePage: OrchestrationThreadDetailPage?
    private var sequence = 2
    private var holdsThreadReads = false
    private let heldReadContinuation: AsyncStream<CatchUpHTTPRead>.Continuation
    nonisolated let heldRequests: AsyncStream<CatchUpHTTPRead>

    init() {
        let reads = AsyncStream<CatchUpHTTPRead>.makeStream()
        heldRequests = reads.stream
        heldReadContinuation = reads.continuation
    }

    func setRawFanoutMessages(sequence: Int, userSlots: Set<Int> = [0, 200], collection: String? = nil) {
        rawTurnCap = 150
        rawCollection = collection
        paginatedMessages = (0..<300).map { index in
            let stamp = String(format: "2026-09-02T12:%02d:%02dZ", index / 60, index % 60)
            return OrchestrationMessage(id: "raw-\(index)", role: userSlots.contains(index) ? "user" : "assistant",
                text: "Raw \(index)", attachments: [], turnId: userSlots.contains(index) ? nil : "turn-\(index)",
                streaming: false, createdAt: stamp, updatedAt: stamp)
        }
        self.sequence = sequence
    }

    func setPaginatedUserMessages(_ range: Range<Int>, sequence: Int) {
        paginatedMessages = range.map { index in
            OrchestrationMessage(
                id: "user-\(index)", role: "user", text: "User \(index)", attachments: [],
                turnId: nil, streaming: false,
                createdAt: String(format: "2026-09-02T12:%02d:%02dZ", index / 60, index % 60),
                updatedAt: String(format: "2026-09-02T12:%02d:%02dZ", index / 60, index % 60)
            )
        }
        self.sequence = sequence
    }
    func removePaginatedUser(id: String, sequence: Int) {
        paginatedMessages?.removeAll { $0.id == id }
        self.sequence = sequence
    }
    func editLatestUserText(_ text: String, sequence: Int) {
        guard let latest = paginatedMessages?.popLast() else { return }
        paginatedMessages?.append(OrchestrationMessage(
            id: latest.id, role: latest.role, text: text, attachments: latest.attachments,
            turnId: latest.turnId, streaming: latest.streaming, createdAt: latest.createdAt,
            updatedAt: latest.updatedAt
        ))
        self.sequence = sequence
    }
    func cancelHeldReads() {
        pendingHeldReads.forEach { $0.fail() }
        pendingHeldReads.removeAll()
    }

    func setResponse(text: String, sequence: Int, attachment: ChatAttachment? = nil) {
        messages = [catchUpMessage(text, index: 0, attachment: attachment)]
        self.sequence = sequence
    }

    func setResponse(texts: [String], sequence: Int, withImage: Bool = false) {
        messages = texts.enumerated().map { index, text in
            catchUpMessage(text, index: index, withImage: withImage)
        }
        self.sequence = sequence
    }

    func setRunningResponse(text: String, sequence: Int) {
        setResponse(text: text, sequence: sequence)
        runningResponse = true
    }

    func setCompletionResponse(text: String, sequence: Int, streaming: Bool = false) {
        messages = [OrchestrationMessage(
            id: "answer-0", role: "assistant", text: text, attachments: [], turnId: "turn-1",
            streaming: streaming, createdAt: "2026-09-02T12:00:00Z", updatedAt: "2026-09-02T12:00:00Z"
        )]
        self.sequence = sequence
        completionResponse = !streaming
    }

    func setPage(_ page: OrchestrationThreadDetailPage) { responsePage = page }

    func holdThreadReads(_ hold: Bool) { holdsThreadReads = hold }

    func setActivities(_ activities: [OrchestrationActivity]) { self.activities = activities }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let value: JSONValue
        switch request.url!.path {
        case "/api/auth/websocket-ticket":
            value = .object(["ticket": .string("test"), "expiresAt": .string("2027-01-01T00:00:00Z")])
        case "/api/orchestration/shell":
            let first = multiEnvironmentShell(projectID: "project", threadID: "first", title: "First")
            let second = multiEnvironmentShell(projectID: "project", threadID: "second", title: "Second")
            value = try .encode(OrchestrationShellSnapshot(
                snapshotSequence: 1, projects: first.projects,
                threads: first.threads + second.threads, updatedAt: first.updatedAt
            ))
        default:
            guard request.url!.path.hasPrefix("/api/orchestration/threads/") else {
                throw URLError(.unsupportedURL)
            }
            threadRequests.append(request)
            var responseMessages = messages
            var page: OrchestrationThreadDetailPage?
            if let paginatedMessages {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let limit = query.first { $0.name == "turnLimit" }?.value.flatMap(Int.init)
                let cursor = query.first { $0.name == "beforeCursor" }?.value
                let end = cursor.flatMap { value in paginatedMessages.firstIndex { $0.id == value } } ?? paginatedMessages.count
                var start = max(0, end - (limit ?? end))
                if let cap = rawTurnCap, let limit {
                    // One fixture message per raw turn. Match server candidates LIMIT150,
                    // then walk descending until the user-anchored turn limit is reached.
                    start = max(0, end - cap)
                    var usersSeen = 0
                    for index in stride(from: end - 1, through: start, by: -1) {
                        if paginatedMessages[index].role == "user" { usersSeen += 1 }
                        if usersSeen == limit { start = index; break }
                    }
                }
                responseMessages = Array(paginatedMessages[start..<end])
                if limit != nil {
                    page = OrchestrationThreadDetailPage(
                        beforeCursor: responseMessages.first?.id, hasMore: start > 0,
                        snapshotSequence: sequence, threadSequence: sequence
                    )
                }
            }
            let snapshot = multiEnvironmentDetail(
                projectID: "project", threadID: request.url!.lastPathComponent,
                snapshotSequence: sequence, messages: responseMessages
            )
            var thread = snapshot.thread
            thread.activities = activities
            if let rawCollection {
                thread.messages = []
                if rawCollection == "activities" {
                    thread.activities = responseMessages.map { row in
                        OrchestrationActivity(id: "activity-\(row.id)", tone: "info", kind: "fixture.raw-turn",
                            summary: row.text, payload: .null, turnId: "turn-\(row.id)", sequence: nil, createdAt: row.createdAt)
                    }
                } else {
                    // Server checkpoints are unwindowed even when messages/activities
                    // hit the raw-turn cap. Keep this fixture faithful to that contract.
                    thread.checkpoints = (paginatedMessages ?? responseMessages).enumerated().map { offset, row in
                        CheckpointSummary(turnId: "turn-\(row.id)", checkpointTurnCount: offset,
                            checkpointRef: row.text, status: "completed", files: [], assistantMessageId: nil, completedAt: row.createdAt)
                    }
                }
            }
            if runningResponse {
                var object = try JSONValue.encode(thread).decode([String: JSONValue].self)
                object["latestTurn"] = .object([
                    "turnId": .string("synthetic-turn"), "state": .string("running"),
                    "requestedAt": .string("2026-09-02T12:00:00Z"), "startedAt": .string("2026-09-02T12:00:00Z"),
                    "completedAt": .null, "assistantMessageId": .null
                ])
                thread = try JSONValue.object(object).decode(OrchestrationThread.self)
            }
            if completionResponse {
                var object = try JSONValue.encode(thread).decode([String: JSONValue].self)
                object["latestTurn"] = catchUpCompletedTurn(assistantMessageID: "answer-0")
                thread = try JSONValue.object(object).decode(OrchestrationThread.self)
            }
            value = try .encode(OrchestrationThreadDetailSnapshot(
                snapshotSequence: snapshot.snapshotSequence, thread: thread, page: responsePage ?? page ?? snapshot.page
            ))
        }
        let response = (try JSONEncoder.t3.encode(value), HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!)
        if request.url!.path.hasPrefix("/api/orchestration/threads/") { threadResponseBytes.append(response.0.count) }
        if holdsThreadReads, request.url!.path.hasPrefix("/api/orchestration/threads/") {
            let finished = AsyncStream<Bool>.makeStream()
            defer {
                finished.continuation.yield(Task.isCancelled)
                finished.continuation.finish()
            }
            return try await withCheckedThrowingContinuation { continuation in
                let read = CatchUpHTTPRead(response: response, continuation: continuation, finished: finished.stream)
                pendingHeldReads.append(read)
                heldReadContinuation.yield(read)
            }
        }
        return response
    }
}

private final class CatchUpHTTPRead: @unchecked Sendable {
    let response: (Data, HTTPURLResponse)
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), any Error>?
    private let lock = NSLock()
    let finished: AsyncStream<Bool>
    init(response: (Data, HTTPURLResponse), continuation: CheckedContinuation<(Data, HTTPURLResponse), any Error>, finished: AsyncStream<Bool>) {
        self.response = response; self.continuation = continuation; self.finished = finished
    }
    private func take() -> CheckedContinuation<(Data, HTTPURLResponse), any Error>? {
        lock.lock(); defer { lock.unlock() }
        defer { continuation = nil }
        return continuation
    }
    func succeed() { take()?.resume(returning: response) }
    func fail() { take()?.resume(throwing: URLError(.notConnectedToInternet)) }
}

private func catchUpMessage(
    _ text: String, index: Int, withImage: Bool = false, attachment: ChatAttachment? = nil
) -> OrchestrationMessage {
    OrchestrationMessage(
        id: "answer-\(index)", role: "assistant", text: text,
        attachments: attachment.map { [$0] } ?? (withImage ? [.init(
            type: "image", id: "image-\(index)", name: "test.png", mimeType: "image/png", sizeBytes: 20
        )] : []),
        turnId: nil, streaming: false, createdAt: "2026-09-02T12:00:00Z",
        updatedAt: "2026-09-02T12:00:00Z"
    )
}

private struct CatchUpConnector: WebSocketConnecting {
    let requests: AsyncStream<CatchUpRequest>.Continuation
    let completionMarker: Bool?
    func connect(to url: URL) async throws -> any WebSocketConnection {
        CatchUpSocket(requests: requests, completionMarker: completionMarker, publishInitialShell: url.host == "two.example")
    }
}

private enum CatchUpStreamFailure: CaseIterable {
    case malformed, defect, ended
}

private struct CatchUpRequest: Sendable {
    let tag: String
    let id: Int
    let payload: JSONValue
    let socket: CatchUpSocket

    func completeShell(sequence: Int, assistantMessageID: String?, activeOrderKey: String? = nil, backgroundLiveness: String? = nil) async throws {
        let shell = multiEnvironmentShell(projectID: "project", threadID: "first", title: "First")
        var thread = try JSONValue.encode(shell.threads[0]).decode([String: JSONValue].self)
        thread["latestTurn"] = catchUpCompletedTurn(assistantMessageID: assistantMessageID)
        thread["activeOrderKey"] = activeOrderKey.map(JSONValue.string)
        thread["backgroundLiveness"] = backgroundLiveness.map(JSONValue.string)
        let snapshot = OrchestrationShellSnapshot(
            snapshotSequence: sequence, projects: shell.projects,
            threads: [try JSONValue.object(thread).decode(OrchestrationThreadShell.self)], updatedAt: shell.updatedAt
        )
        try await socket.chunk(id: id, values: [.object([
            "kind": .string("snapshot"), "snapshot": try .encode(snapshot),
        ])])
    }

    func completeTurnWithoutMessageID(sequence: Int) async throws {
        try await socket.chunk(id: id, values: [.object([
            "kind": .string("event"), "event": .object([
                "type": .string("thread.turn-diff-completed"), "sequence": .number(Double(sequence)),
                "occurredAt": .string("2026-09-02T12:01:00Z"), "payload": .object([
                    "threadId": payload["threadId"]!, "turnId": .string("turn-1"),
                    "checkpointTurnCount": .number(1), "checkpointRef": .string("refs/t3/checkpoints/turn-1"),
                    "status": .string("ready"), "files": .array([]),
                    "completedAt": .string("2026-09-02T12:01:00Z"), "assistantMessageId": .null,
                ]),
            ]),
        ])])
    }

    func terminate(_ failure: CatchUpStreamFailure) async throws {
        switch failure {
        case .malformed:
            try await socket.chunk(id: id, values: [.object([
                "kind": .number(42),
            ])])
        case .defect:
            try await socket.failWithDefect(id: id)
        case .ended:
            try await socket.succeed(id: id, value: .null)
        }
    }

    func synchronize() async throws {
        try await socket.chunk(id: id, values: [.object(["kind": .string("synchronized")])])
    }

    func sendActivities(_ activities: [OrchestrationActivity], startingAt sequence: Int) async throws {
        let values = try activities.enumerated().map { index, activity in
            JSONValue.object([
                "kind": .string("event"), "event": .object([
                    "type": .string("thread.activity-appended"),
                    "sequence": .number(Double(sequence + index)),
                    "occurredAt": .string(activity.createdAt),
                    "payload": .object([
                        "threadId": payload["threadId"]!, "activity": try .encode(activity),
                    ]),
                ]),
            ])
        }
        try await socket.chunk(id: id, values: values)
    }

    func invalidate(sequence: Int) async throws {
        try await socket.chunk(id: id, values: [.object([
            "kind": .string("event"), "event": .object([
                "type": .string("thread.reverted"), "sequence": .number(Double(sequence)),
                "occurredAt": .string("2026-09-02T12:00:00Z"),
                "payload": .object(["threadId": payload["threadId"]!]),
            ]),
        ])])
    }

    func snapshot(texts: [String], sequence: Int) async throws {
        let snapshot = multiEnvironmentDetail(
            projectID: "project", threadID: payload["threadId"]!.stringValue!,
            snapshotSequence: sequence,
            messages: texts.enumerated().map { catchUpMessage($0.element, index: $0.offset) }
        )
        try await socket.chunk(id: id, values: [.object([
            "kind": .string("snapshot"), "snapshot": try .encode(snapshot),
        ])])
    }

    func runningTurnSnapshot(sequence: Int) async throws {
        let snapshot = multiEnvironmentDetail(
            projectID: "project", threadID: payload["threadId"]!.stringValue!, snapshotSequence: sequence
        )
        var thread = try JSONValue.encode(snapshot.thread).decode([String: JSONValue].self)
        thread["latestTurn"] = .object([
            "turnId": .string("turn-2"), "state": .string("running"),
            "requestedAt": .string("2026-09-02T12:02:00Z"),
            "startedAt": .string("2026-09-02T12:02:00Z"),
            "completedAt": .null, "assistantMessageId": .null,
        ])
        let updated = OrchestrationThreadDetailSnapshot(
            snapshotSequence: sequence, thread: try JSONValue.object(thread).decode(OrchestrationThread.self)
        )
        try await socket.chunk(id: id, values: [
            .object(["kind": .string("snapshot"), "snapshot": try .encode(updated)]),
        ])
    }

    func sendBurst(count: Int, includeMarker: Bool) async throws {
        var values: [JSONValue] = (1...count).map { index in
            .object([
                "kind": .string("event"), "event": .object([
                    "type": .string("thread.message-sent"), "sequence": .number(Double(index + 2)),
                    "occurredAt": .string("2026-09-02T12:00:00Z"), "payload": .object([
                        "threadId": payload["threadId"]!, "messageId": .string("burst-message"),
                        "role": .string("assistant"), "text": .string(index < count ? "x" : String(repeating: "x", count: count)),
                        "streaming": .bool(index < count),
                        "createdAt": .string("2026-09-02T12:00:00Z"),
                        "updatedAt": .string("2026-09-02T12:00:00Z"),
                    ]),
                ]),
            ])
        }
        if includeMarker { values.append(.object(["kind": .string("synchronized")])) }
        try await socket.chunk(id: id, values: values)
    }

    func sendMessage(text: String, sequence: Int) async throws {
        try await socket.chunk(id: id, values: [.object([
            "kind": .string("event"), "event": .object([
                "type": .string("thread.message-sent"), "sequence": .number(Double(sequence)),
                "occurredAt": .string("2026-09-02T12:00:00Z"), "payload": .object([
                    "threadId": payload["threadId"]!, "messageId": .string("message-\(sequence)"),
                    "role": .string("assistant"), "text": .string(text), "streaming": .bool(false),
                    "createdAt": .string("2026-09-02T12:00:00Z"),
                    "updatedAt": .string("2026-09-02T12:00:00Z"),
                ]),
            ]),
        ])])
    }
}

private actor CatchUpSocket: WebSocketConnection {
    let requests: AsyncStream<CatchUpRequest>.Continuation
    let completionMarker: Bool?
    private(set) var assetRequestCount = 0
    private var pending: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    private var closed = false

    private let publishInitialShell: Bool

    init(requests: AsyncStream<CatchUpRequest>.Continuation, completionMarker: Bool?, publishInitialShell: Bool = false) {
        self.requests = requests
        self.completionMarker = completionMarker
        self.publishInitialShell = publishInitialShell
    }

    func send(_ data: Data) throws {
        guard !closed else { throw URLError(.networkConnectionLost) }
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if request["_tag"]?.stringValue == "Ping" {
            try enqueue(.object(["_tag": .string("Pong")]))
        }
        guard let tag = request["tag"]?.stringValue, case let .number(id) = request["id"] else { return }
        if publishInitialShell, tag == RPCMethod.subscribeShell.rawValue {
            let snapshot = multiEnvironmentShell(projectID: "project", threadID: "first", title: "Peer")
            try chunk(id: Int(id), values: [.object([
                "kind": .string("snapshot"), "snapshot": try .encode(snapshot)
            ])])
        }
        if tag == RPCMethod.assetsCreateURL.rawValue { assetRequestCount += 1 }
        if tag == RPCMethod.subscribeServerConfig.rawValue {
            var config: [String: JSONValue] = [
                "providers": .array([]), "threadSnapshotPagination": .bool(true),
            ]
            if let completionMarker { config["threadResumeCompletionMarker"] = .bool(completionMarker) }
            try chunk(id: Int(id), values: [.object([
                "type": .string("snapshot"), "config": .object(config),
            ])])
        }
        requests.yield(.init(tag: tag, id: Int(id), payload: request["payload"]!, socket: self))
    }

    func receive() async throws -> Data {
        guard !closed else { throw URLError(.networkConnectionLost) }
        if !pending.isEmpty { return pending.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }

    func chunk(id: Int, values: [JSONValue]) throws {
        try enqueue(.object([
            "_tag": .string("Chunk"), "requestId": .number(Double(id)), "values": .array(values),
        ]))
    }

    func succeed(id: Int, value: JSONValue) throws {
        try enqueue(.object([
            "_tag": .string("Exit"), "requestId": .number(Double(id)),
            "exit": .object(["_tag": .string("Success"), "value": value]),
        ]))
    }

    func failWithDefect(id: Int) throws {
        try enqueue(.object([
            "_tag": .string("Exit"), "requestId": .number(Double(id)),
            "exit": .object([
                "_tag": .string("Failure"),
                "cause": .array([.object([
                    "_tag": .string("Die"),
                    "defect": .string("RAW_SERVER_DEFECT_MUST_NOT_REACH_THREAD_UI"),
                ])]),
            ]),
        ]))
    }

    func fail(id: Int, message: String) throws {
        try enqueue(.object([
            "_tag": .string("Exit"), "requestId": .number(Double(id)),
            "exit": .object([
                "_tag": .string("Failure"),
                "cause": .array([.object([
                    "_tag": .string("Fail"), "error": .object(["message": .string(message)]),
                ])]),
            ]),
        ]))
    }

    private func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else { pending.append(data) }
    }
}

private actor CatchUpRetryGate {
    nonisolated let attempts: AsyncStream<Int>
    private let continuation: AsyncStream<Int>.Continuation
    private var waiters: [UUID: CheckedContinuation<Void, any Error>] = [:]

    init() {
        let stream = AsyncStream<Int>.makeStream()
        attempts = stream.stream
        continuation = stream.continuation
    }

    func wait(_ attempt: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled { waiter.resume(throwing: CancellationError()) }
                else {
                    waiters[id] = waiter
                    continuation.yield(attempt)
                }
            }
        } onCancel: { Task { await self.cancel(id) } }
    }

    func release() {
        let pending = waiters.values
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }

    private func cancel(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

private actor CatchUpDelay {
    private var opened = false
    private var waiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
    func wait() async throws {
        if opened { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { waiters[id] = continuation }
            }
        } onCancel: { Task { await self.cancel(id) } }
    }
    func release() {
        opened = true
        let waiting = waiters.values
        waiters.removeAll()
        waiting.forEach { $0.resume() }
    }
    private func cancel(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

private func catchUpCompletedTurn(assistantMessageID: String?) -> JSONValue {
    .object([
        "turnId": .string("turn-1"), "state": .string("completed"),
        "requestedAt": .string("2026-09-02T12:00:00Z"),
        "startedAt": .string("2026-09-02T12:00:00Z"),
        "completedAt": .string("2026-09-02T12:01:00Z"),
        "assistantMessageId": assistantMessageID.map(JSONValue.string) ?? .null,
    ])
}

/// The detail tests retain their one FeatureEvent consumer. Readiness comes
/// from applied shell/config receipts and does not drain that event stream.
@MainActor
private final class CatchUpBootstrapReadiness {
    private var hasShell = false
    private var hasConfig = false
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    func record(_ receipt: NativePassiveShellReceipt) {
        switch receipt {
        case .shellApplied(environmentID: "one", sequence: _): hasShell = true
        case .configurationApplied(environmentID: "one"): hasConfig = true
        default: break
        }
        if hasShell && hasConfig {
            let pending = waiters.values
            waiters.removeAll()
            pending.forEach { $0.resume() }
        }
    }

    func wait() async throws {
        try Task.checkCancellation()
        guard !hasShell || !hasConfig else { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiters[id] = $0 }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
            }
        }
    }
}

private final class CatchUpPublicationClock: Sendable {
    private let gate = CatchUpDelay()
    private let receipt: AsyncStream<Void>.Continuation
    let entries: AsyncStream<Void>

    init() {
        let pair = AsyncStream<Void>.makeStream()
        entries = pair.stream
        receipt = pair.continuation
    }

    func wait() async throws {
        receipt.yield(())
        try await gate.wait()
    }

    func release() async { await gate.release() }
}

@MainActor
private final class SelectedReconciliationClock {
    var now = ContinuousClock.now
    let requests = AsyncStream<Wait>.makeStream()
    private var pending: [UUID: CheckedContinuation<Void, any Error>] = [:]
    struct Wait: Sendable {
        let duration: Duration
        let release: @MainActor @Sendable () -> Void
    }
    func advance(by duration: Duration) { now = now.advanced(by: duration) }
    func cancelAll() {
        let waits = pending.values
        pending.removeAll()
        waits.forEach { $0.resume(throwing: CancellationError()) }
        requests.continuation.finish()
    }
    func sleep(for duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else {
                    pending[id] = continuation
                    requests.continuation.yield(Wait(duration: duration, release: { [weak self] in
                        self?.pending.removeValue(forKey: id)?.resume()
                    }))
                }
            }
            pending.removeValue(forKey: id)
        } onCancel: { Task { @MainActor [weak self] in
            self?.pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
        } }
    }
}

import Foundation
import XCTest
@testable import T3Code

@MainActor
@available(iOS 18.0, *)
final class NativeThreadCatchUpTests: XCTestCase {
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
        while let request = await requests.next(isolation: #isolation) {
            if request.tag == RPCMethod.assetsCreateURL.rawValue { break }
        }
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertEqual(messages, ["Text ready"])
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

    func testNonImageAttachmentsResolveAfterTextCatchUpCompletes() async throws {
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

            while let request = await requests.next(isolation: #isolation) {
                guard request.tag == RPCMethod.assetsCreateURL.rawValue else { continue }
                XCTAssertEqual(request.payload["resource"]?["mimeType"], .string(mimeType))
                try await request.socket.succeed(id: request.id, value: .object([
                    "relativeUrl": .string("/assets/\(name)"),
                    "expiresAt": .number(Date.now.addingTimeInterval(3_600).timeIntervalSince1970 * 1_000),
                ]))
                break
            }
            var resolved: FeatureMessageAttachment?
            while let event = await events.next(isolation: #isolation) {
                guard case let .detail(detail) = event, detail.thread.id == fixture.firstID,
                      let attachment = detail.messages.first?.attachments.first else { continue }
                resolved = attachment
                break
            }
            XCTAssertEqual(resolved?.mimeType, mimeType)
            XCTAssertEqual(resolved?.url, URL(string: "https://one.example/assets/\(name)"))
            await fixture.client.disconnect()
        }
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

    static func make(completionMarker: Bool = true) async throws -> Self {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save([Environment(
            id: "one", label: "Computer", httpBaseURL: URL(string: "https://one.example")!,
            webSocketBaseURL: URL(string: "wss://one.example/ws")!
        )])
        try await store.setActiveEnvironment(id: "one")
        let http = CatchUpHTTPTransport()
        let requests = AsyncStream<CatchUpRequest>.makeStream()
        let delay = CatchUpDelay()
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: ["one": .init(accessToken: "test")]),
            httpTransport: http,
            webSocketConnector: CatchUpConnector(
                requests: requests.continuation, completionMarker: completionMarker
            )
        )
        let client = NativeFeatureClient(
            runtime: runtime, settingsStore: UserDefaults(suiteName: UUID().uuidString)!,
            fallbackPollingInitialDelay: .seconds(3_600),
            aggregateRefreshInterval: .seconds(3_600),
            catchUpDelay: { try await delay.wait() }
        )
        _ = try await client.initialSnapshot()
        return Self(client: client, http: http, requests: requests.stream, delay: delay, directory: directory)
    }

    func cleanUp() { try? FileManager.default.removeItem(at: directory) }
}

private actor CatchUpHTTPTransport: HTTPTransport {
    private(set) var threadRequests: [URLRequest] = []
    private var messages: [OrchestrationMessage] = []
    private var sequence = 2
    private var holdsThreadReads = false
    private let heldReadContinuation: AsyncStream<CatchUpHTTPRead>.Continuation
    nonisolated let heldRequests: AsyncStream<CatchUpHTTPRead>

    init() {
        let reads = AsyncStream<CatchUpHTTPRead>.makeStream()
        heldRequests = reads.stream
        heldReadContinuation = reads.continuation
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

    func holdThreadReads(_ hold: Bool) { holdsThreadReads = hold }

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
            value = try .encode(multiEnvironmentDetail(
                projectID: "project", threadID: request.url!.lastPathComponent,
                snapshotSequence: sequence, messages: messages
            ))
        }
        let response = (try JSONEncoder.t3.encode(value), HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!)
        if holdsThreadReads, request.url!.path.hasPrefix("/api/orchestration/threads/") {
            let finished = AsyncStream<Bool>.makeStream()
            defer {
                finished.continuation.yield(Task.isCancelled)
                finished.continuation.finish()
            }
            return try await withCheckedThrowingContinuation { continuation in
                heldReadContinuation.yield(CatchUpHTTPRead(
                    response: response, continuation: continuation, finished: finished.stream
                ))
            }
        }
        return response
    }
}

private struct CatchUpHTTPRead: Sendable {
    let response: (Data, HTTPURLResponse)
    let continuation: CheckedContinuation<(Data, HTTPURLResponse), any Error>
    let finished: AsyncStream<Bool>
    func succeed() { continuation.resume(returning: response) }
    func fail() { continuation.resume(throwing: URLError(.notConnectedToInternet)) }
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
    let completionMarker: Bool
    func connect(to url: URL) async throws -> any WebSocketConnection {
        CatchUpSocket(requests: requests, completionMarker: completionMarker)
    }
}

private struct CatchUpRequest: Sendable {
    let tag: String
    let id: Int
    let payload: JSONValue
    let socket: CatchUpSocket

    func synchronize() async throws {
        try await socket.chunk(id: id, values: [.object(["kind": .string("synchronized")])])
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
    let completionMarker: Bool
    private var pending: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    private var closed = false

    init(requests: AsyncStream<CatchUpRequest>.Continuation, completionMarker: Bool) {
        self.requests = requests
        self.completionMarker = completionMarker
    }

    func send(_ data: Data) throws {
        guard !closed else { throw URLError(.networkConnectionLost) }
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if request["_tag"]?.stringValue == "Ping" {
            try enqueue(.object(["_tag": .string("Pong")]))
        }
        guard let tag = request["tag"]?.stringValue, case let .number(id) = request["id"] else { return }
        if tag == RPCMethod.subscribeServerConfig.rawValue {
            try chunk(id: Int(id), values: [.object([
                "type": .string("snapshot"), "config": .object([
                    "providers": .array([]), "threadSnapshotPagination": .bool(true),
                    "threadResumeCompletionMarker": .bool(completionMarker),
                ]),
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

    private func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else { pending.append(data) }
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

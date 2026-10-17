import Foundation
import XCTest
@testable import T3Code

final class WireFixtureContractTests: XCTestCase {
    func testHubCreditsMatchTheServerContract() throws {
        let input = try V2Fixture.load("hub-reset-credit-input").decode(ProviderConsumeResetCreditInput.self)
        XCTAssertEqual(input, .source(sourceID: "hub-fixture", accountID: "account-fixture", creditID: "credit-fixture"))
        XCTAssertEqual(try JSONValue.encode(input), try V2Fixture.load("hub-reset-credit-input"))
        let result = try V2Fixture.load("hub-reset-credit-result").decode(ProviderConsumeResetCreditResult.self)
        XCTAssertEqual(result.warning, "Could not clear the hub cooldown.")
        let credits = try V2Fixture.load("hub-reset-credits").decode(ServerProviderResetCredits.self)
        XCTAssertEqual(credits.nextCreditId, "credit-fixture")
        XCTAssertEqual(credits.availableCount, 1)
    }

    func testGeneratedV2SnapshotsAndStreamsDecodeInSwift() throws {
        let raw = try V2Fixture.load("v2-shell-snapshot")
        let shell = try OrchestrationV2Presentation.shellSnapshot(raw)
        XCTAssertEqual(shell.orchestrationProtocolVersion, 2)
        XCTAssertEqual(shell.projects.map(\.id), ["project-v2"])
        XCTAssertEqual(shell.threads.first?.id, "thread-v2")
        XCTAssertEqual(shell.threads.first?.autoSettleDisabledAt, "2026-08-07T12:00:00.000Z")
        XCTAssertEqual(shell.threads.first?.activeOrderKey, "nm")
        let detail = try OrchestrationV2ThreadState(snapshot: V2Fixture.load("v2-thread-bounded-snapshot")).normalizedSnapshot()
        XCTAssertEqual(detail.orchestrationProtocolVersion, 2)
        XCTAssertEqual(detail.thread.id, "thread-v2")
        XCTAssertEqual(detail.page?.beforeCursor, "fixture-v2-before-10")
        guard case let .snapshot(streamShell) = OrchestrationV2Presentation.shellStreamItem(
            try V2Fixture.load("v2-shell-stream-snapshot")
        ) else { return XCTFail("Expected the V2 shell stream snapshot") }
        XCTAssertEqual(streamShell.snapshotSequence, shell.snapshotSequence)
        let streamDetail = try OrchestrationV2ThreadState(snapshot: V2Fixture.load("v2-thread-stream-snapshot"))
        XCTAssertEqual(streamDetail.projection.thread.id, detail.thread.id)
    }

    func testV2SnapshotsPreservePullRequestsOrderAndTitleRegeneration() throws {
        let link = ThreadLinkedPullRequest(projectId: "project-v2", repository: "pingdotgg/t3code",
            number: 5178, url: "https://github.com/pingdotgg/t3code/pull/5178")
        let regeneration = ThreadTitleRegeneration(requestId: "command-regenerate-title", startedAt: V2Fixture.now)
        let fields: [String: JSONValue] = [
            "linkedPullRequest": try .encode(link), "branchPullRequest": try .encode(link),
            "titleRegeneration": try .encode(regeneration), "activeOrderKey": .string("nm"),
        ]
        let original = try V2Fixture.load("v2-shell-snapshot")
        let thread = try XCTUnwrap(original["threads"]?.v2Array?.first)
        let shell = try OrchestrationV2Presentation.shellSnapshot(V2Fixture.patch(original, [
            "threads": .array([V2Fixture.patch(thread, fields)]),
        ]))
        let detail = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: [
            "thread": V2Fixture.patch(V2Fixture.thread, fields),
        ])).normalizedSnapshot()
        XCTAssertEqual(shell.threads.first?.linkedPullRequest, link)
        XCTAssertEqual(shell.threads.first?.branchPullRequest, link)
        XCTAssertEqual(detail.thread.linkedPullRequest, link)
        XCTAssertEqual(detail.thread.branchPullRequest, link)
        XCTAssertEqual(detail.thread.activeOrderKey, "nm")
        XCTAssertEqual(detail.thread.titleRegeneration, regeneration)
    }

    func testV2ReopenTimestampIsOptionalAndReachesBothPresentations() throws {
        let original = try V2Fixture.load("v2-shell-snapshot")
        let thread = try XCTUnwrap(original["threads"]?.v2Array?.first)
        XCTAssertNil(try OrchestrationV2Presentation.shellSnapshot(original).threads.first?.unsettledAt)
        for timestamp in [JSONValue.null, .string(V2Fixture.now)] {
            let shell = try OrchestrationV2Presentation.shellSnapshot(V2Fixture.patch(original, [
                "threads": .array([V2Fixture.patch(thread, ["unsettledAt": timestamp])]),
            ]))
            let detail = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: [
                "thread": V2Fixture.patch(V2Fixture.thread, ["unsettledAt": timestamp]),
            ])).normalizedSnapshot()
            XCTAssertEqual(shell.threads.first?.unsettledAt, timestamp.stringValue)
            XCTAssertEqual(detail.thread.unsettledAt, timestamp.stringValue)
        }
    }

    func testUnknownShellItemsRequestAnAuthoritativeRefresh() {
        for item in [JSONValue]([
            .object(["kind": .string("future-shell-delta"), "sequence": .number(43)]),
            .object(["kind": .string("thread.updated"), "sequence": .number(43),
                     "location": .string("active"), "thread": .object(["id": .string("future")])]),
        ]) {
            guard case .refreshRequired = OrchestrationV2Presentation.shellStreamItem(item) else {
                XCTFail("Unknown or malformed V2 shell items require a refresh")
                continue
            }
        }
    }
}

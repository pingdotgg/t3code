import Foundation
import XCTest
@testable import T3Code

@MainActor
final class FeatureV2ItemDetailTests: XCTestCase {
    func testOmittedOutputAndSummarizedInputRequireFetch() {
        XCTAssertTrue(FeatureV2ItemDetail.needsFetch(.object([
            "type": .string("command_execution"), "outputOmitted": .bool(true),
        ])))
        XCTAssertTrue(FeatureV2ItemDetail.needsFetch(.object([
            "type": .string("dynamic_tool"), "input": .object(["summary": .string("Large input"), "truncated": .bool(true)]),
        ])))
        XCTAssertNil(FeatureV2ItemDetail.output(.object([
            "type": .string("dynamic_tool"), "outputOmitted": .bool(true), "output": .string("short preview"),
        ])))
    }

    func testToolDetailPreservesEmptyArgumentsMCPTextAndLargeOutputForCopy() {
        let raw: JSONValue = .object([
            "type": .string("dynamic_tool"),
            "input": .object(["clear": .string(""), "value": .null]),
            "output": .object(["content": .array([.object(["type": .string("text"), "text": .string("{\"ok\":true}")])]), "isError": .bool(false)]),
        ])
        XCTAssertEqual(FeatureV2ItemDetail.call(raw), "clear: \"\"\nvalue: null")
        XCTAssertEqual(FeatureV2ItemDetail.output(raw), "{\n  \"ok\" : true\n}")
        let large = String(repeating: "line\n", count: 20_000)
        let command = V2Fixture.item("large", type: "command_execution", ordinal: 1, fields: ["input": .string("cat file"), "output": .string(large)])
        XCTAssertTrue(FeatureV2ItemDetail.copyText(command).contains(large))
    }

    func testSearchResultsAndCommandFailureAreInspectable() {
        let file: JSONValue = .object([
            "type": .string("file_search"), "pattern": .string("hello"), "results": .array([
                .object(["fileName": .string("a.swift"), "line": .number(12), "preview": .string("hello()")]),
            ]),
        ])
        XCTAssertEqual(FeatureV2ItemDetail.call(file), "hello")
        XCTAssertEqual(FeatureV2ItemDetail.output(file), "a.swift:12\nhello()")
        let web: JSONValue = .object([
            "type": .string("web_search"), "results": .array([
                .object(["title": .string("Docs"), "url": .string("https://example.com/docs"), "snippet": .string("Description")]),
            ]),
        ])
        XCTAssertEqual(FeatureV2ItemDetail.output(web), "Docs\nhttps://example.com/docs\nDescription")
        let command: JSONValue = .object(["type": .string("command_execution"), "status": .string("completed"), "exitCode": .number(2)])
        XCTAssertTrue(FeatureV2ItemDetail.indicatesFailure(command))
        XCTAssertEqual(FeatureV2ItemDetail.exitLabel(command), "Exit code: 2")
        XCTAssertTrue(FeatureV2ItemDetail.indicatesFailure(.object([
            "type": .string("dynamic_tool"), "status": .string("completed"), "output": .object([
                "content": .array([.object(["type": .string("text"), "text": .string("{\"_tag\":\"ToolFailure\"}")])]),
            ]),
        ])))
        XCTAssertFalse(FeatureV2ItemDetail.indicatesFailure(.object(["type": .string("error"), "status": .string("completed")])))
    }

    func testDerivedFailureFlagSurvivesCodableRoundTripWithoutChangingTheFormat() throws {
        let base = try workItem(status: "completed", updatedAt: V2Fixture.now)
        let item = FeatureV2WorkItem(source: base.source, raw: V2Fixture.patch(base.raw, ["exitCode": .number(2)]))
        XCTAssertTrue(item.indicatesFailure)
        let data = try JSONEncoder().encode(item)
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]).keys
        XCTAssertEqual(Set(keys), ["source", "raw"])
        let decoded = try JSONDecoder().decode(FeatureV2WorkItem.self, from: data)
        XCTAssertTrue(decoded.indicatesFailure)
        XCTAssertEqual(decoded, item)
    }

    func testDetailFetchUsesInheritedSourceAndStableLiveRevisionThenRefetchesCompletion() async throws {
        let projected = try workItem(status: "running", updatedAt: V2Fixture.now)
        let client = InspectionClient()
        client.item = try OrchestrationV2TurnItem(json: V2Fixture.patch(projected.raw, ["outputOmitted": .bool(false), "output": .string("Full output")]))
        let state = FeatureV2TimelineState()
        let context = FeatureV2ItemInspectionContext(threadID: "environment-scoped-fork", client: client, state: state)
        await state.load(projected, context: context)
        var updated = projected
        updated.source.updatedAt = "2026-10-04T12:01:00Z"
        await state.load(updated, context: context)
        XCTAssertEqual(client.sources.count, 1)
        XCTAssertEqual(client.sources.first?.sourceThreadID, "original-thread")
        XCTAssertEqual(client.sources.first?.itemID, "tool")
        XCTAssertEqual(client.sources.first?.detailRevision, "live")
        updated.source.status = "completed"
        await state.load(updated, context: context)
        XCTAssertEqual(client.sources.count, 2)
        XCTAssertEqual(client.sources.last?.detailRevision, updated.source.updatedAt)
    }

    func testMissingAndFailedOutputStayDistinctAndRetryCanRecover() async throws {
        let item = try workItem(status: "completed", updatedAt: V2Fixture.now)
        let client = InspectionClient()
        let state = FeatureV2TimelineState()
        let context = FeatureV2ItemInspectionContext(threadID: "fork", client: client, state: state)
        let key = FeatureV2TimelineState.Key(threadID: context.threadID, source: item.source)
        await state.load(item, context: context)
        XCTAssertEqual(state.details[key], .missing)
        client.shouldFail = true
        await state.load(item, context: context, retry: true)
        guard case .failed = state.details[key] else { return XCTFail("A fetch failure must not become empty output") }
        client.shouldFail = false
        client.item = try OrchestrationV2TurnItem(json: V2Fixture.patch(item.raw, ["outputOmitted": .bool(false), "output": .string("Recovered")]))
        await state.load(item, context: context, retry: true)
        guard case let .loaded(raw) = state.details[key] else { return XCTFail("Retry did not load the result") }
        XCTAssertEqual(FeatureV2ItemDetail.output(raw), "Recovered")
        XCTAssertEqual(client.sources.count, 3)
    }

    func testFetchedIdentityCannotReplaceAnotherItem() async throws {
        let item = try workItem(status: "completed", updatedAt: V2Fixture.now)
        let client = InspectionClient()
        client.item = try OrchestrationV2TurnItem(json: V2Fixture.patch(item.raw, ["threadId": .string("wrong-source")]))
        let state = FeatureV2TimelineState()
        let context = FeatureV2ItemInspectionContext(threadID: "fork", client: client, state: state)
        await state.load(item, context: context)
        guard case .failed = state.details[.init(threadID: "fork", source: item.source)] else {
            return XCTFail("Mismatched source identity must fail")
        }
    }

    private func workItem(status: String, updatedAt: String) throws -> FeatureV2WorkItem {
        let raw = V2Fixture.item("tool", type: "command_execution", ordinal: 1, fields: [
            "input": .string("cat file"), "outputOmitted": .bool(true), "threadId": .string("original-thread"),
            "status": .string(status), "updatedAt": .string(updatedAt),
        ])
        let projected = try V2Fixture.row(raw, visibility: "inherited").decode(OrchestrationV2ProjectedTurnItem.self)
        return FeatureV2WorkItem(source: OrchestrationV2TimelineMetadata(projected), raw: raw)
    }
}

@MainActor
private final class InspectionClient: FeatureV2ItemInspecting {
    var sources: [OrchestrationV2TimelineMetadata] = []
    var item: OrchestrationV2TurnItem?
    var shouldFail = false

    func inspectV2Item(threadID: String, source: OrchestrationV2TimelineMetadata) async throws -> OrchestrationV2TurnItem? {
        sources.append(source)
        if shouldFail { throw RPCError.disconnected }
        return item
    }
}

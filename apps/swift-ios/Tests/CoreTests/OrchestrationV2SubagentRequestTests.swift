import Foundation
import XCTest
@testable import T3Code

final class OrchestrationV2SubagentRequestTests: XCTestCase {
    func testNestedRequestsReachEveryAncestorAndApprovalWinsInEitherOrder() throws {
        let root = try source("root")
        let child = try source("child", parent: "root", request: "user_input")
        let nested = try source("nested", parent: "child", request: "command")
        for sources in [[root, child, nested], [nested, child, root]] {
            let index = OrchestrationV2SubagentRequests(environmentID: "home", sources: sources)
            XCTAssertEqual(index.pendingRequest(for: "root"), .approval)
            XCTAssertEqual(index.pendingRequest(for: "child"), .approval)
            XCTAssertNil(index.pendingRequest(for: "nested"))
            XCTAssertEqual(Set(index.childInputs(for: "root").map(\.threadID)), ["child", "nested"])
            XCTAssertEqual(index.childInputs(for: "child").map(\.threadID), ["nested"])
            XCTAssertEqual(OrchestrationV2SubagentRequests.childInputsTitle(index.childInputs(for: "root")),
                           "2 subagents need you")
        }
    }

    func testActivityFieldPresenceControlsWhetherAQuestionStillCounts() throws {
        let root = try source("root")
        let live = try source("child", parent: "root", request: "user_input", status: "queued")
        XCTAssertEqual(index([root, live]).pendingRequest(for: "root"), .userInput)
        let ended = try source("child", parent: "root", request: "user_input",
                               status: "running", activity: .null)
        XCTAssertNil(index([root, ended]).pendingRequest(for: "root"))
        for status in ["preparing", "starting", "running", "waiting"] {
            let legacy = try source("child", parent: "root", request: "user_input",
                                    status: status, activity: nil)
            XCTAssertEqual(index([root, legacy]).pendingRequest(for: "root"), .userInput, status)
        }
        for status in ["idle", "queued", "completed", "failed", "cancelled", "interrupted", "rolled_back"] {
            let legacy = try source("child", parent: "root", request: "user_input",
                                    status: status, activity: nil)
            XCTAssertNil(index([root, legacy]).pendingRequest(for: "root"), status)
        }
    }

    func testProviderNativeAuthRefreshAndForkRequestsDoNotPropagate() throws {
        let root = try source("root")
        let excluded = try [
            source("native", parent: "root", request: "command", creationSource: "provider"),
            source("auth", parent: "root", request: "auth_refresh"),
            source("fork", parent: "root", request: "user_input", relationship: "fork"),
        ]
        XCTAssertNil(index([root] + excluded).pendingRequest(for: "root"))
        XCTAssertTrue(index([root] + excluded).childInputs(for: "root").isEmpty)
        let forkChild = try source("fork-child", parent: "fork", request: "user_input")
        let requests = index([root] + excluded + [forkChild])
        XCTAssertEqual(requests.pendingRequest(for: "fork"), .userInput)
        XCTAssertNil(requests.pendingRequest(for: "root"))
    }

    func testClosedAndDeletedChildrenOrAncestorsCannotRaiseAnOpenParent() throws {
        let root = try source("root")
        for field in ["archivedAt", "deletedAt"] {
            let closed = try source("closed", parent: "root", request: "command",
                                    fields: [field: .string(V2Fixture.now)])
            let nested = try source("nested", parent: "closed", request: "user_input")
            let requests = index([root, closed, nested])
            XCTAssertNil(requests.pendingRequest(for: "root"), field)
            XCTAssertTrue(requests.childInputs(for: "root").isEmpty, field)
            XCTAssertNil(requests.pendingRequest(for: "closed"), field)
        }
    }

    func testCyclesAndMissingParentsStopWithoutSurfacingAChildOnItself() throws {
        let a = try source("a", parent: "b", request: "command")
        let b = try source("b", parent: "a")
        let selfCycle = try source("self", parent: "self", request: "user_input")
        let orphan = try source("orphan", parent: "missing", request: "command")
        let requests = index([a, b, selfCycle, orphan])
        XCTAssertEqual(requests.pendingRequest(for: "b"), .approval)
        XCTAssertEqual(requests.childInputs(for: "b").map(\.threadID), ["a"])
        for id in ["a", "self", "orphan", "missing"] {
            XCTAssertNil(requests.pendingRequest(for: id), id)
            XCTAssertTrue(requests.childInputs(for: id).isEmpty, id)
        }
    }

    func testTargetsStayInTheirEnvironmentAndClearWithTheNextSnapshot() throws {
        let root = try source("root")
        let child = try source("child", parent: "root", request: "user_input")
        let home = OrchestrationV2SubagentRequests(environmentID: "home", sources: [root, child])
        let work = OrchestrationV2SubagentRequests(environmentID: "work", sources: [root])
        XCTAssertEqual(home.childInputs(for: "root").first?.environmentID, "home")
        XCTAssertEqual(home.childInputs(for: "root").first?.threadID, "child")
        XCTAssertNil(work.pendingRequest(for: "root"))
        XCTAssertTrue(work.childInputs(for: "root").isEmpty)
        let ended = try source("child", parent: "root", request: "user_input", activity: .null)
        let refreshed = index([root, ended])
        XCTAssertNil(refreshed.pendingRequest(for: "root"))
        XCTAssertTrue(refreshed.childInputs(for: "root").isEmpty)
    }

    func testBannerTitlesDistinguishApprovalInputAndMixedRequests() throws {
        let root = try source("root")
        for (kind, singular, plural) in [
            ("user_input", "Subagent needs input", "2 subagents need input"),
            ("command", "Subagent needs approval", "2 subagents need approval"),
        ] {
            let a = try source("a", parent: "root", request: kind)
            let b = try source("b", parent: "root", request: kind)
            XCTAssertEqual(OrchestrationV2SubagentRequests.childInputsTitle(index([root, a]).childInputs(for: "root")), singular)
            XCTAssertEqual(OrchestrationV2SubagentRequests.childInputsTitle(index([root, a, b]).childInputs(for: "root")), plural)
        }
    }

    func testPresentationRetainsLineageAndActivityFactsAcrossShellUpdatesAndCacheEncoding() throws {
        let child = try shell("child", parent: "root", request: "command", status: "queued")
        let presented = OrchestrationV2Presentation.shellThread(child)
        let source = try XCTUnwrap(presented.v2SubagentRequestSource)
        XCTAssertEqual(source.parentThreadID, "root")
        XCTAssertEqual(source.request, .approval)
        let restored = try JSONDecoder.t3.decode(OrchestrationThreadShell.self,
            from: JSONEncoder.t3Intermediate.encode(presented))
        XCTAssertEqual(restored.v2SubagentRequestSource, source)
        let update: JSONValue = .object([
            "kind": .string("thread.updated"), "sequence": .number(2),
            "location": .string("active"), "thread": child.raw,
        ])
        guard case let .threadUpserted(_, updated) = OrchestrationV2Presentation.shellStreamItem(update) else {
            return XCTFail("Expected a shell update")
        }
        XCTAssertEqual(updated.v2SubagentRequestSource, source)
    }

    private func index(_ sources: [OrchestrationV2SubagentRequestSource]) -> OrchestrationV2SubagentRequests {
        OrchestrationV2SubagentRequests(environmentID: "home", sources: sources)
    }

    private func source(
        _ id: String, parent: String? = nil, request: String? = nil,
        status: String = "waiting", activity: JSONValue? = .string("waiting"),
        creationSource: String = "mcp", relationship: String = "subagent", fields: [String: JSONValue] = [:]
    ) throws -> OrchestrationV2SubagentRequestSource {
        try OrchestrationV2SubagentRequestSource(shell: shell(id, parent: parent, request: request,
            status: status, activity: activity, creationSource: creationSource, relationship: relationship, fields: fields))
    }

    private func shell(
        _ id: String, parent: String? = nil, request: String? = nil,
        status: String = "waiting", activity: JSONValue? = .string("waiting"),
        creationSource: String = "mcp", relationship: String = "subagent", fields: [String: JSONValue] = [:]
    ) throws -> OrchestrationV2ThreadShell {
        var values = V2Fixture.patch(V2Fixture.thread, [
            "id": .string(id), "title": .string(id), "creationSource": .string(creationSource),
            "lineage": .object(["parentThreadId": parent.map(JSONValue.string) ?? .null,
                "relationshipToParent": parent == nil ? .null : .string(relationship), "rootThreadId": .string("root")]),
            "status": .string(status), "latestRunId": .string("run"), "activeRunId": .null,
            "pendingRuntimeRequest": request.map { .object([
                "id": .string("request"), "kind": .string($0), "createdAt": .string(V2Fixture.now),
            ]) } ?? .null,
            "latestVisibleMessage": .null, "latestUserMessageAt": .null,
            "hasActionableProposedPlan": .bool(false), "itemCount": .number(0), "visibleItemCount": .number(0),
        ]).v2Object
        values["activityRunStatus"] = activity
        values.merge(fields, uniquingKeysWith: { _, last in last })
        return try OrchestrationV2ThreadShell(json: .object(values))
    }
}
